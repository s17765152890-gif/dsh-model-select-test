/**
 * dsh-model-select-test — the model menu's inline connectivity test.
 *
 * Host half. One authenticated `POST /x-model-test` route runs a single
 * fixed-prompt streaming call through the adapter stack the chat already uses
 * (`ctx.llm.stream`), following the provider's own resolved retry policy
 * (`ctx.llm.providerRetryPolicy`) the same way `dsh-llm-retry` executes it at
 * the agent's failed-step extension point. The service itself never re-runs a
 * request, retrying is intentionally re-implemented here from the same policy
 * so attempts and resets stay honest instead of invisible.
 *
 * The loop writes nothing durable: no session, no projection, no retry events —
 * the test is invisible to chat history by design.
 *
 * @module dsh-model-select-test
 */
/** Route path below the auth-scoped `/x-` prefix, kept out of `/api`. */
const ROUTE_PATH = '/x-model-test'

/** Whole-test budget: every attempt, retry delay, and metadata read inside. */
const TEST_TOTAL_BUDGET_MS = 45_000

/**
 * Upper bound on attempts when the provider runs an `always` retry policy,
 * which has no natural cap. Normal mode stays inside `policy.maxRetries`.
 */
const ALWAYS_MODE_ATTEMPT_CAP = 6

/** Defensive body cap: the route names one provider and one model. */
const MAX_BODY_BYTES = 4096

/** Fixed probe message: everything about the test is non-conversational. */
const TEST_PROMPT = '只回复 OK，不调用工具'

/** Required host services: the HTTP carrier and its trust checks. */
export const inject = ['webServer', 'connection']

/**
 * Concise failure-class labels for the pill; raw provider messages stay in the
 * per-attempt details the row's tooltip exposes.
 */
const CODE_LABELS = {
  RATE_LIMIT: '429 上游过载',
  TIMEOUT: '连接超时',
  QUOTA: '额度不足',
  ACCOUNT_QUOTA: '官方余额不足',
  AUTH: '密钥错误',
  MISSING_CREDENTIAL: '未配置密钥',
  INVALID_CREDENTIAL: '密钥无效',
  EMPTY_RESPONSE: '空响应',
  NO_ADAPTER: '无适配器',
  SERVER: '上游 5xx',
  TRANSPORT: '网络错误',
  CONTEXT_WINDOW_EXCEEDED: '上下文超限',
  INVALID_PREPARED_CALL: '调用配置失效',
  UNSUPPORTED_REASONING_EFFORT: '思考等级无效',
  MALFORMED_RESPONSE: '响应异常',
  STREAM_CLOSED: '响应中断',
  PI_AI_ERROR: '上游错误',
  INVALID_MODEL_INFO: '模型目录异常',
  ABORTED: '已中止',
  OUTPUT_CAPPED: '输出截断',
  TOOL_CALL: '模型要调工具',
  BUSY: '测试进行中',
  CLIENT: '页面请求失败',
  NO_SERVICE: 'llm 服务未挂载',
  MODEL_TEST_DEADLINE: '超时中止',
}

/** labels lookup for tests and probes */
export const codeLabel = code => CODE_LABELS[code] ?? (code === undefined || code === null || code === '' ? '失败' : code)

/**
 * One delay step of the provider's bounded exponential backoff — copied from
 * `dsh-llm-retry`'s `localDelay` so the test waits exactly like recovery does.
 * @param config - resolved backoff (`initialDelayMs`, `maxDelayMs`, `jitterRatio`).
 * @param retry - one-based retry number.
 * @param random - the harness random.
 * @returns delay in milliseconds.
 */
function localDelay(config, retry, random = Math.random) {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

/**
 * Turn one terminal finish reason into the attempt record.
 * @param reason - the `finish` chunk's reason (`stop`/`max-tokens`/`tool-calls`/`error`/`aborted`).
 * @returns `{ ok, code, message }`.
 */
function classifyFinish(reason) {
  const kind = reason?.kind
  if (kind === 'stop') return { ok: true, code: undefined, message: undefined }
  if (kind === 'max-tokens') {
    return { ok: false, code: 'OUTPUT_CAPPED', message: '流式输出在完成前被 max-tokens 截断' }
  }
  if (kind === 'tool-calls') {
    return { ok: false, code: 'TOOL_CALL', message: '模型在无工具attach的探测请求里发起了工具调用' }
  }
  if (kind === 'aborted') {
    return { ok: false, code: reason?.failure?.code ?? 'ABORTED', message: reason?.failure?.message ?? '流被中止' }
  }
  const failure = reason?.failure
  return { ok: false, code: failure?.code ?? 'LLM_INTERNAL', message: failure?.message ?? '流以未知错误结束' }
}

/**
 * Resolve the provider's retry policy defensively: a row may name a provider
 * whose adapter is gone; the attempt still runs, it just never retries.
 */
function safePolicy(llm, provider) {
  try {
    const policy = llm.providerRetryPolicy(provider)
    return policy ?? null
  } catch {
    return null
  }
}

/**
 * Resolve exact model metadata for the effort display and output cap.
 * @param llm - the `llm` service.
 * @param provider - provider route id.
 * @param model - model id.
 * @param signal - test signal; aborts capability lookup.
 * @returns resolved info, or null when unresolvable (the attempt still runs).
 */
async function safeModelInfo(llm, provider, model, signal) {
  try {
    return (await llm.resolveModelInfo(provider, model, signal)) ?? null
  } catch {
    return null
  }
}

/**
 * Run one full test: attempts the exact model with the fixed probe through the
 * real adapter, mirrors the provider retry policy between failures, and
 * reports honest per-attempt timings.
 * @param ctx - host plugin context with `llm` mounted.
 * @param provider - provider route id, e.g. `opencode-go`.
 * @param model - model id as shown in the menu row.
 * @param requestSignal - the HTTP request's lifetime signal.
 * @returns the summary the client row renders.
 */
export async function runModelTest(ctx, provider, model, requestSignal, budgetMs = TEST_TOTAL_BUDGET_MS) {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    return { ok: false, status: 'fail', code: 'NO_SERVICE', message: 'llm 服务未挂载', provider, model, retries: 0, effort: undefined, attempts: [], totalMs: 0 }
  }

  const startedAt = Date.now()
  const testController = new AbortController()
  const lifetimeSignals = requestSignal === undefined ? [testController.signal] : [testController.signal, requestSignal]
  const testSignal = lifetimeSignals.length === 1 ? lifetimeSignals[0] : AbortSignal.any(lifetimeSignals)
  const deadlineTimer = setTimeout(() => { testController.abort() }, budgetMs)
  try {
    const policy = safePolicy(llm, provider)
    const info = await safeModelInfo(llm, provider, model, testSignal)
    if (info !== null && info.provider !== provider) {
      return { ok: false, status: 'fail', code: 'INVALID_MODEL_INFO', message: '模型目录返回的 provider 不匹配', provider, model, retries: 0, effort: undefined, attempts: [], totalMs: Date.now() - startedAt }
    }
    const reasoning = info?.reasoning
    const effort = reasoning?.defaultEffort ?? null
    // An explicit small cap keeps the probe cheap when the adapter publishes
    // no default; otherwise the adapter's own cap materializes as in chat.
    const maxTokens = info?.defaultMaxTokens === undefined ? (reasoning !== undefined ? 1024 : 64) : undefined

    /**
     * One `ctx.llm.stream()` attempt with per-attempt first visible text.
     * @param n - one-based attempt number.
     * @returns the attempt record.
     */
    async function attempt(n) {
      const attemptStartedAt = Date.now()
      let firstTextMs
      let terminal
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          messages: [{ role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] }],
          // A session-shaped unique id keeps route compat layers that key
          // transports by session (e.g. OpenCode's x-opencode-session header)
          // on their real chat path without touching any live conversation.
          sessionId: `dsh-model-test-${startedAt.toString(36)}-${n}`,
          ...(effort === null ? {} : { reasoningEffort: effort }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          signal: testSignal,
        })) {
          if (firstTextMs === undefined && chunk?.type === 'text-delta' && /\S/.test(chunk.text ?? '')) {
            firstTextMs = Date.now() - attemptStartedAt
          }
          if (chunk?.type === 'finish') terminal = chunk
        }
      } catch (error) {
        terminal = {
          type: 'finish',
          reason: { kind: 'error', failure: { code: error?.code ?? 'LLM_INTERNAL', message: String(error?.message ?? error) } },
        }
      }
      if (terminal === undefined) {
        // The adapter contract ends with exactly one finish; a stream breaking
        // early without one is a transport-level failure, not a success.
        return { n, ms: Date.now() - attemptStartedAt, firstTextMs: firstTextMs ?? null, ok: false, code: 'STREAM_CLOSED', message: '流在没有终结块的情况下结束' }
      }
      if (terminal.reason?.kind === 'aborted' && testDeadlineReached(testController)) {
        return { n, ms: Date.now() - attemptStartedAt, firstTextMs: firstTextMs ?? null, ok: false, code: 'MODEL_TEST_DEADLINE', message: '测试时间上限，已中止' }
      }
      const verdict = classifyFinish(terminal.reason)
      return { n, ms: Date.now() - attemptStartedAt, firstTextMs: firstTextMs ?? null, ...verdict }
    }

    const attempts = []
    let last
    for (;;) {
      last = await attempt(attempts.length + 1)
      attempts.push(last)
      if (last.ok === true) break
      if (testController.signal.aborted) break

      if (policy === null) break
      if (policy.mode === 'always') {
        if (attempts.length >= ALWAYS_MODE_ATTEMPT_CAP) break
      } else {
        const retry = attempts.length - 1
        if (!policy.retryableCodes.includes(last.code)) break
        if (retry >= policy.maxRetries) break
      }

      let delayMs
      const providerDelay = last.providerRetryAfterMs
      if (typeof providerDelay === 'number' && Number.isFinite(providerDelay) && providerDelay > 0) {
        if (providerDelay > policy.maxDelayMs) {
          if (policy.mode === 'normal') break
          delayMs = localDelay(policy, attempts.length)
        } else {
          delayMs = providerDelay
        }
      } else {
        delayMs = localDelay(policy, attempts.length)
      }
      const remaining = budgetMs - (Date.now() - startedAt)
      if (remaining <= 0) break
      const abortedEarly = await waitCancellable(Math.min(delayMs, remaining), testSignal)
      if (abortedEarly === false) break
    }

    const ok = last.ok === true
    // The deadline stop names itself as the verdict: the loop ended because the
    // test budget ran out, while the provider's own last failure stays in the
    // attempt list and the message.
    const deadlineAborted = !ok && testController.signal.aborted
    return {
      ok,
      status: ok ? 'ok' : 'fail',
      code: deadlineAborted ? 'MODEL_TEST_DEADLINE' : last.code,
      message: deadlineAborted
        ? `测试时间上限（${budgetMs}ms），已停止；最后一次失败: ${last.message ?? codeLabel(last.code)}`
        : last.message,
      provider,
      model,
      totalMs: Date.now() - startedAt,
      firstTextMs: ok ? last.firstTextMs : null,
      retries: attempts.length - 1,
      effort,
      attempts: attempts.map(({ n, ms, firstTextMs, code, message }) => ({
        n,
        ms,
        ...firstTextMs !== undefined && firstTextMs !== null ? { firstTextMs } : {},
        ...code === undefined ? {} : { code },
        ...message === undefined ? {} : { message },
      })),
    }
  } finally {
    clearTimeout(deadlineTimer)
  }
}

/** Whether the whole-test deadline already fired. */
function testDeadlineReached(controller) {
  return controller.signal.aborted
}

/**
 * Pending timer that resolves `true` on completion and `false` when aborted,
 * mirroring `dsh-llm-retry`'s cancellable delay so aborts never round another
 * backoff step.
 * @param delayMs - delay before the next attempt.
 * @param signal - test lifetime signal.
 * @returns whether the wait completed.
 */
function waitCancellable(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Mount the test route.
 * @param ctx - host plugin context.
 * @param config - unused; the budget is fixed in code until tunables are needed.
 */
export function apply(ctx, config) {
  const running = new Set()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const send = (status, value) => {
        const body = Buffer.from(JSON.stringify(value), 'utf8')
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.byteLength),
          'cache-control': 'no-store',
        })
        res.end(body)
      }

      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }

      if (req.method !== 'POST') { send(405, { ok: false, status: 'fail', code: 'CLIENT', message: '仅支持 POST' }); return }
      let payload
      const controller = new AbortController()
      // A browser that disconnects mid-test aborts the probe. Watch the socket,
      // not the message: IncomingMessage 'close' fires as soon as the body is
      // consumed, which here happens long before the response is written.
      req.socket?.on('close', () => { if (res.writableEnded !== true) controller.abort() })
      try {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 400 })
        }
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })
        }
        if (typeof parsed?.provider !== 'string' || typeof parsed?.model !== 'string') {
          throw Object.assign(new Error('provider 与 model 必须是字符串'), { status: 400 })
        }
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(parsed.provider) || !/^[A-Za-z0-9._-]{1,128}$/.test(parsed.model)) {
          throw Object.assign(new Error('provider 或 model 含非法字符'), { status: 400 })
        }
        if (ctx.get('llm') === undefined) {
          send(200, { ok: false, status: 'fail', code: 'NO_SERVICE', message: 'llm 服务未挂载', provider: parsed.provider, model: parsed.model, retries: 0, attempts: [], totalMs: 0 })
          return
        }
        const inflightKey = `${parsed.provider}\u241F${parsed.model}`
        if (running.has(inflightKey)) {
          send(200, { ok: false, status: 'fail', code: 'BUSY', message: '该模型的测试已在进行中', provider: parsed.provider, model: parsed.model, retries: 0, attempts: [], totalMs: 0 })
          return
        }
        running.add(inflightKey)
        try {
          payload = await runModelTest(ctx, parsed.provider, parsed.model, controller.signal)
        } finally {
          running.delete(inflightKey)
        }
        send(200, payload)
      } catch (error) {
        if (error?.status === 400) {
          send(400, { ok: false, status: 'fail', code: 'CLIENT', message: error.message })
        } else {
          ctx.logger?.warn?.(`dsh-model-select-test: test failure ${String(error)}`)
          send(500, { ok: false, status: 'fail', code: 'HOST_ERROR', message: '测试过程出现宿主错误' })
        }
      }
    },
  }), 'dsh-model-select-test: model connectivity test route')
}
