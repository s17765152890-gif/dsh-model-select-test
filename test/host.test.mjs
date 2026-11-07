import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, codeLabel, runModelTest } from '../lib/index.js'

/**
 * A scripted llm service: each `stream()` call pops the next script entry;
 * `resolveModelInfo` and `providerRetryPolicy` return stubs.
 */
class FakeLlm {
  constructor({ attempts, info, policy } = {}) {
    this.attempts = attempts ?? [runOk()]
    this.info = info
    this.policy = policy ?? { mode: 'normal', maxRetries: 5, retryableCodes: ['RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE'], backoff: { initialDelayMs: 2, maxDelayMs: 4, jitterRatio: 0 } }
    this.calls = []
  }

  providerRetryPolicy(provider) {
    if (provider === 'unknown-gateway') throw new Error('no adapter')
    return this.policy
  }

  async resolveModelInfo(provider, model, signal) {
    if (typeof signal?.throwIfAborted === 'function') signal.throwIfAborted?.()
    if (provider === 'unknown-gateway') throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' })
    if (this.info === null) throw Object.assign(new Error('metadata unavailable'), { code: 'NO_ADAPTER' })
    return this.info ?? {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    }
  }

  async *stream(options) {
    this.calls.push(options)
    const next = this.attempts.shift()
    if (next === undefined) yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INTERNAL', message: 'script exhausted' } } }
    else yield* next()
  }
}

/** A successful probe run: "OK" plus a normal stop. */
function runOk(delayMs = 0) {
  return async function* () {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    yield { type: 'text-delta', text: 'O' }
    yield { type: 'text-delta', text: 'K' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One failure with a provider-neutral code. */
function runFail(code, message, delayMs = 0) {
  return async function* () {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    yield { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
  }
}

/** A stream that ends without the mandatory terminal finish. */
function runTruncated() {
  return async function* () {
    yield { type: 'text-delta', text: 'OK' }
  }
}

/** A controllable never-ending stream for the BUSY test. */
class HangingLlm extends FakeLlm {
  constructor() {
    super({ attempts: [] })
    this.pending = undefined
  }

  async *stream(options) {
    this.calls.push(options)
    this.pending ??= new Promise(() => {})
    await this.pending
  }
}

function mount({ services = {} } = {}) {
  let route
  const ctx = {
    get: name => services[name],
    connection: { requestRejection: req => (req?.headers?.['x-auth'] === 'no' ? 401 : undefined) },
    webServer: { register: value => { route = value; return () => {} } },
    effect: fn => { fn() },
    logger: { warn() {} },
  }
  apply(ctx, {})
  const call = async (body, { method = 'POST', auth = true, handleCloseEvent = true } = {}) => {
    let status
    let payload
    const request = {
      method,
      headers: auth ? {} : { 'x-auth': 'no' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield body },
      on() {},
    }
    await route.handler(request, {
      writeHead(value) { status = value },
      end(value) { payload = value === undefined ? undefined : JSON.parse(value) },
    })
    return { status, payload }
  }
  return { ctx, call }
}

test('the code label lookup keeps provider classes readable', () => {
  assert.equal(codeLabel('RATE_LIMIT'), '429 上游过载')
  assert.equal(codeLabel('QUOTA'), '额度不足')
  assert.equal(codeLabel(undefined), '失败')
})

test('a successful first attempt reports first text, total time, and zero retries', async () => {
  const { ctx, call } = mount({ services: { llm: new FakeLlm() } })
  const result = await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
  assert.equal(result.retries, 0)
  assert.equal(result.effort, 'high')
  assert.ok(result.firstTextMs >= 0)
  assert.ok(result.totalMs >= 0)
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].code, undefined)
  const request = ctx.llmService ?? undefined
  assert.ok(true)
})

test('the test prompt is fixed, tool-free, and effort is declared', async () => {
  const llm = new FakeLlm()
  const { ctx, call } = mount({ services: { llm } })
  await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined)
  assert.equal(llm.calls.length, 1)
  const options = llm.calls[0]
  const text = options.messages[0].content[0].text
  assert.equal(text, '只回复 OK，不调用工具')
  assert.deepEqual(options.messages[0].content[0], { type: 'text', text: '只回复 OK，不调用工具' })
  assert.equal(options.tools, undefined)
  assert.equal(options.reasoningEffort, 'high')
  assert.equal(options.provider, 'opencode-go')
  assert.equal(options.model, 'qwen3.8-flash')
})

test('retry follows the provider policy and counts honestly', async () => {
  const llm = new FakeLlm({ attempts: [runFail('RATE_LIMIT', 'too many requests'), runOk()] })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined)
  assert.equal(result.ok, true)
  assert.equal(result.retries, 1)
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].code, 'RATE_LIMIT')
  assert.equal(result.attempts[1].code, undefined)
  assert.ok(result.attempts[1].firstTextMs !== undefined)
  assert.ok(result.totalMs >= result.attempts[0].ms)
})

test('non-retryable failures stop immediately', async () => {
  const llm = new FakeLlm({ attempts: [runFail('AUTH', 'bad key', 2), runFail('AUTH', 'bad key', 2), runOk()] })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'locmodel', 'deepseek-v4.1-flash', undefined)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AUTH')
  assert.equal(result.retries, 0)
  assert.equal(result.attempts.length, 1)
})

test('empty responses are classified, not counted as success', async () => {
  const llm = new FakeLlm({ attempts: [runFail('EMPTY_RESPONSE', 'no content'), runOk()] })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined)
  assert.equal(result.ok, true)
  assert.equal(result.attempts[0].code, 'EMPTY_RESPONSE')
  assert.equal('firstTextMs' in result.attempts[0], false, 'failed attempts carry no first-text timing')
})

test('a stream without a terminal finish counts as interrupted', async () => {
  const llm = new FakeLlm({ attempts: [async function* () { yield { type: 'text-delta', text: 'OK' } }] })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STREAM_CLOSED')
})

test('the test budget aborts a stuck attempt instead of hanging', async () => {
  const slow = (ms, code) => async function* () {
    await new Promise(resolve => setTimeout(resolve, ms))
    yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'slow upstream' } } }
  }
  const llm = new FakeLlm({
    attempts: [slow(120, 'TIMEOUT'), slow(120, 'TIMEOUT'), slow(120, 'TIMEOUT'), slow(120, 'TIMEOUT')],
    policy: { mode: 'always', backoff: { initialDelayMs: 2, maxDelayMs: 3, jitterRatio: 0 } },
  })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined, 200)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MODEL_TEST_DEADLINE')
  assert.ok(result.retries >= 1)
  assert.ok(result.totalMs < 400, `total ${result.totalMs} should be bounded near the budget`)
  assert.match(result.message, /测试时间上限/)
})

test('normal-mode cap keeps within maxRetries and shows the last failure', async () => {
  const slow = (ms, code) => async function* () {
    await new Promise(resolve => setTimeout(resolve, ms))
    yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'flaky' } } }
  }
  const attempts = Array.from({ length: 9 }, () => slow(4, 'TIMEOUT'))
  const llm = new FakeLlm({ attempts, policy: { mode: 'normal', maxRetries: 2, retryableCodes: ['TIMEOUT'], backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } } })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'opencode-go', 'qwen3.8-flash', undefined, 500)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'TIMEOUT')
  assert.equal(result.retries, 2, 'initial attempt plus maxRetries retries')
})

test('an unregistered provider surfaces NO_ADAPTER without retries', async () => {
  const llm = new FakeLlm({ attempts: [runFail('NO_ADAPTER', 'no adapter registered', 2)] })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'unknown-gateway', 'whatever', undefined)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_ADAPTER')
  assert.equal(result.retries, 0)
})

test('unresolvable model metadata still runs the probe with provider defaults', async () => {
  const llm = new FakeLlm({ info: null, attempts: [runOk()] })
  const { ctx, call } = mount({ services: { llm } })
  const result = await runModelTest(ctx, 'opencode-go', 'mystery-model', undefined)
  assert.equal(result.ok, true)
  assert.equal(llm.calls[0].reasoningEffort, undefined)
  assert.equal(llm.calls[0].maxTokens, 64)
  assert.equal(result.effort, null)
})

test('reasoning models keep the adapter default output cap instead of a raw small one', async () => {
  const llm = new FakeLlm({
    info: { provider: 'p', id: 'm', name: 'm', defaultMaxTokens: 8192, reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } },
    attempts: [runOk()],
  })
  const { ctx, call } = mount({ services: { llm } })
  await runModelTest(ctx, 'p', 'm', undefined)
  assert.equal(llm.calls[0].maxTokens, undefined)
})

test('route rejects unauthenticated requests and invalid arguments', async () => {
  const { call } = mount({ services: { llm: new FakeLlm() } })
  const rejected = await call('{"provider":"a","model":"b"}', { auth: false })
  assert.equal(rejected.status, 401)
  const bad = await call('{"provider":123}')
  assert.equal(bad.status, 400)
  assert.equal(bad.payload.code, 'CLIENT')
})

test('the route answers NO_SERVICE when the llm service is missing', async () => {
  const { call } = mount({})
  const result = await call('{"provider":"a","model":"b"}')
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, false)
  assert.equal(result.payload.code, 'NO_SERVICE')
})

test('a second concurrent test for the same model answers BUSY', async () => {
  const { call } = mount({ services: { llm: new HangingLlm() } })
  const first = call('{"provider":"p","model":"m"}')
  const second = await call('{"provider":"p","model":"m"}')
  assert.equal(second.status, 200)
  assert.equal(second.payload.ok, false)
  assert.equal(second.payload.code, 'BUSY')
})
