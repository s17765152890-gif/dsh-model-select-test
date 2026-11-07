"""Build dsh-model-select-test's client half from the shipped model selection bundle.

The shipped `@deepseek-ai/dsh-client-ui-model-selection` client bundle is copied
intact, then four surgical edits are applied:

1. the loader module id becomes unique (`dsh-model-select-test`);
2. every model row's `children` gains `...dshModelTestCells(group, model)` — the
   inline result slot plus the stopPropagation test button;
3. the model group's `MenuGroup` render is wrapped so the OpenCode Go group
   carries a one-click "更新模型" button that refreshes the catalog and reloads
   the session's model directory;
4. the factory tail gains the whole subsystem (store, format, requests, class
   components, CSS injection).

Everything else — menu logic, keyboard navigation, search, CSS — stays
byte-identical, so behavior parity equals the shipped build.

Usage:
    python build.py [path/to/shipped/client.js]

The default source is this profile's installed copy; the extracted asar copy is
the fallback. The script fails loudly when an anchor is not unique.
"""
import os
import sys

DEFAULTS_HINT = (
    "pass the shipped client bundle path, e.g.\n"
    "  python build.py <profile>/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js\n"
    "or set DSH_MODEL_SELECTION_CLIENT to that path."
)
OUTPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib", "client.js")

OLD_ID = '"@deepseek-ai/dsh-client-ui-model-selection"'
NEW_ID = '"dsh-model-select-test"'

ROW_ANCHOR = "children: model.name"
ROW_SPLIT = "}), (0, react_jsx_runtime.jsx)(\"span\", {"
ROW_INJECT = "}), ...dshModelTestCells(group, model), (0, react_jsx_runtime.jsx)(\"span\", {"

GROUP_ANCHOR = "filteredGroups.map((group) => {"
GROUP_RETURN = "return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuGroup, {"
GROUP_RETURN_NEW = "return dshModelTestGroup(group, () => load(), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuGroup, {"
GROUP_CLOSE = "}, group.id);"
GROUP_CLOSE_NEW = "}, group.id));"

TAIL_ANCHOR = "exports.ModelDirectory = ModelDirectory;"

HELPER_REGION = r"""
		//#region dsh-model-select-test: inline per-model connectivity tests
		/**
		 * Shared per-run state: one entry per `provider\u241Fmodel` row. Results
		 * survive closing and reopening the menu for the lifetime of the browser
		 * page; nothing is persisted and nothing is polled.
		 */
		const dshModelTestState = { map: new Map(), running: new Map(), listeners: new Set() };
		/** Provider routes whose group header gets the one-click catalog update. */
		const dshModelTestUpdateProviders = new Set(["opencode-go", "opencode-go-latest"]);
		function dshModelTestKey(provider, modelId) {
			return provider + "\u241F" + modelId;
		}
		function dshModelTestNotify() {
			for (const listener of [...dshModelTestState.listeners]) listener();
		}
		function dshModelTestSubscribe(callback) {
			dshModelTestState.listeners.add(callback);
			return () => dshModelTestState.listeners.delete(callback);
		}
		/** Seconds formatting for the inline line ("1.2s", "12s"). */
		function dshModelTestSec(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "\u2014";
			return (ms < 9950 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000)) + "s";
		}
		/** Failure-class labels; the provider's own message stays in the tooltip. */
		const dshModelTestCodeLabels = {
			RATE_LIMIT: "429 上游过载",
			TIMEOUT: "连接超时",
			QUOTA: "额度不足",
			ACCOUNT_QUOTA: "官方余额不足",
			AUTH: "密钥错误",
			MISSING_CREDENTIAL: "未配置密钥",
			INVALID_CREDENTIAL: "密钥无效",
			EMPTY_RESPONSE: "空响应",
			NO_ADAPTER: "无适配器",
			SERVER: "上游 5xx",
			TRANSPORT: "网络错误",
			CONTEXT_WINDOW_EXCEEDED: "上下文超限",
			INVALID_PREPARED_CALL: "调用配置失效",
			UNSUPPORTED_REASONING_EFFORT: "思考等级无效",
			MALFORMED_RESPONSE: "响应异常",
			STREAM_CLOSED: "响应中断",
			PI_AI_ERROR: "上游错误",
			INVALID_MODEL_INFO: "模型目录异常",
			ABORTED: "已中止",
			OUTPUT_CAPPED: "输出截断",
			TOOL_CALL: "模型要调工具",
			BUSY: "测试进行中",
			CLIENT: "页面请求失败",
			NO_SERVICE: "llm 服务未挂载",
			MODEL_TEST_DEADLINE: "超时中止",
			HOST_ERROR: "宿主错误"
		};
		function dshModelTestLabel(code) {
			return code === undefined || code === null || code === "" ? "失败" : dshModelTestCodeLabels[code] ?? code;
		}
		/** The compact inline line; the hover tooltip carries the full story. */
		function dshModelTestInline(record, running) {
			if (running) return "测试中\u2026";
			if (!record) return "";
			if (record.status === "ok") {
				return "\u2713 首字 " + dshModelTestSec(record.firstTextMs) + " \u00B7 总耗时 " + dshModelTestSec(record.totalMs) + " \u00B7 重试 " + (record.retries ?? 0) + "次";
			}
			return "\u2717 " + dshModelTestLabel(record.code) + (record.retries > 0 ? " \u00B7 重试 " + record.retries + "次" : "");
		}
		/** Hover story: outcome, effort used, per-attempt timings. */
		function dshModelTestTitle(provider, model, record, running) {
			const lines = [provider + " \u00B7 " + model.name];
			if (running) lines.push("正在测试（不切换当前模型，不写入聊天记录）\u2026");
			if (!running && !record) lines.push("点击「测试」用固定提示词“只回复 OK，不调用工具”发起一次连通性测试。");
			if (record) {
				lines.push(record.effort ? "本次思考强度: " + record.effort : "本次思考强度: 按模型/路由默认");
				if (record.status === "ok") {
					lines.push("\u2713 首字 " + dshModelTestSec(record.firstTextMs) + " \u00B7 总耗时 " + dshModelTestSec(record.totalMs) + " \u00B7 重试 " + (record.retries ?? 0) + "次");
				} else if (record.message) {
					lines.push("\u2717 " + dshModelTestLabel(record.code) + " \u00B7 " + record.message);
				}
				for (const attempt of record.attempts ?? []) {
					lines.push("第" + attempt.n + "次: " + (attempt.code === undefined || attempt.code === null ? "成功" : dshModelTestLabel(attempt.code)) + " \u00B7 总 " + dshModelTestSec(attempt.ms) + (attempt.firstTextMs !== undefined && attempt.firstTextMs !== null ? " \u00B7 首字 " + dshModelTestSec(attempt.firstTextMs) : ""));
				}
			}
			return lines.join("\n");
		}
		/** Fire one test; the row turns busy until the route answers. */
		function dshModelTestRequest(provider, model) {
			const key = dshModelTestKey(provider, model.id);
			if (dshModelTestState.running.has(key)) return;
			const controller = new AbortController();
			dshModelTestState.running.set(key, controller);
			dshModelTestNotify();
			const settle = (result) => {
				dshModelTestState.running.delete(key);
				dshModelTestState.map.set(key, { ...result, at: Date.now() });
				dshModelTestNotify();
			};
			fetch(new URL("x-model-test", document.baseURI), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ provider, model: model.id }),
				signal: controller.signal
			}).then((response) => response.ok || response.status === 400
					? response.json().catch(() => ({ ok: false, status: "fail", code: "CLIENT", message: "响应无法解析" }))
					: Promise.resolve(response.status === 401 || response.status === 403
						? { ok: false, status: "fail", code: "AUTH", message: "登录会话已失效，请刷新页面后重试" }
						: { ok: false, status: "fail", code: "CLIENT", message: "HTTP " + response.status }))
				.then((payload) => settle(payload?.status === undefined ? { ...payload, status: payload.ok === true ? "ok" : "fail" } : payload))
				.catch((error) => {
					const aborted = error?.name === "AbortError";
					settle({
						ok: false,
						status: "fail",
						code: aborted ? "ABORTED" : "CLIENT",
						message: aborted ? "已取消" : String(error?.message ?? error)
					});
				});
		}
		/**
		 * One-click catalog refresh on a provider group header: asks the host to
		 * re-sync the OpenCode Go catalog, then reloads this session's model
		 * directory so the menu reflects the new routes immediately.
		 */
		class DshModelTestUpdate extends react.Component {
			constructor(props) {
				super(props);
				this.state = { busy: false, note: "", error: "" };
			}
			run() {
				if (this.state.busy) return;
				this.setState({ busy: true, note: "", error: "" });
				fetch(new URL("x-opencode-go-catalog?refresh=1", document.baseURI), { credentials: "same-origin" })
					.then((response) => response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)))
					.then((payload) => {
						const sync = payload?.sync;
						const ok = sync?.ok === true;
						const added = ok ? sync.added?.length ?? 0 : 0;
						const removed = ok ? sync.removed?.length ?? 0 : 0;
						this.setState({
							busy: false,
							note: ok ? (added > 0 || removed > 0 ? "\u2713 已更新 +" + added + " -" + removed : "\u2713 已是最新") : "\u2717 更新失败",
							error: ok ? "" : String(sync?.error ?? "unknown")
						});
						if (this.props.reload) this.props.reload();
					})
					.catch((error) => this.setState({ busy: false, note: "\u2717 更新失败", error: String(error?.message ?? error) }));
			}
			render() {
				const { busy, note, error } = this.state;
				return (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dmt-group-update",
					tabIndex: -1,
					"data-busy": busy ? "true" : void 0,
					title: error ? "更新失败: " + error : "从 OpenCode 官方目录拉取最新模型，并刷新此菜单",
					onMouseDown: (event) => event.stopPropagation(),
					onClick: (event) => {
						event.stopPropagation();
						event.preventDefault();
						this.run();
					},
					children: busy ? "更新中\u2026" : (note || "\u27F3 更新模型")
				});
			}
		}
		/** Wrap one provider group, adding the update button only where configured. */
		function dshModelTestGroup(group, reload, element) {
			const provider = group?.id ?? group?.provider?.id;
			if (!dshModelTestUpdateProviders.has(provider)) return element;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dmt-group-wrap",
				children: [(0, react_jsx_runtime.jsx)(DshModelTestUpdate, { reload: reload }, "update"), element]
			}, "dmt-group-" + provider);
		}
		/**
		 * Per-row cells: the reserved inline result slot plus a test button that
		 * stops propagation, so the row's select click never fires. A class
		 * component keeps each row's subscription self-contained without touching
		 * the menu component's hook order.
		 */
		class DshModelTestCell extends react.Component {
			componentDidMount() {
				this.release = dshModelTestSubscribe(() => this.forceUpdate());
			}
			componentWillUnmount() {
				this.release?.();
				this.release = void 0;
			}
			render() {
				const { provider, model } = this.props;
				const key = dshModelTestKey(provider, model.id);
				const record = dshModelTestState.map.get(key);
				const running = dshModelTestState.running.has(key);
				const tone = running ? "" : record ? (record.ok === true || record.status === "ok" ? " dmt-ok" : " dmt-bad") : "";
				const testIt = (event) => {
					event.stopPropagation();
					event.preventDefault();
					if (running) return;
					dshModelTestRequest(provider, model);
				};
				return [
					react_jsx_runtime.jsx("span", {
						className: "dmt-result" + tone,
						"data-dmt-state": running ? "running" : record ? record.status : "idle",
						title: dshModelTestTitle(provider, model, record, running),
						children: dshModelTestInline(record, running)
					}, "dmt-result"),
					react_jsx_runtime.jsx("span", {
						role: "button",
						tabIndex: -1,
						className: "dmt-test-btn",
						"data-busy": running ? "true" : void 0,
						title: running ? "测试进行中\u2026" : "测试该模型连通性（不切换当前模型）",
						onMouseDown: (event) => event.stopPropagation(),
						onClick: testIt,
						onKeyDown: (event) => {
							if (event.key !== "Enter" && event.key !== " ") return;
							testIt(event);
						},
						children: running ? "\u2026" : "测试"
					}, "dmt-test")
				];
			}
		}
		function dshModelTestCells(group, model) {
			return [react_jsx_runtime.jsx(DshModelTestCell, { provider: group.id, model }, "dsh-model-test")];
		}
		function dshModelTestInit() {
			if (typeof document === "undefined") return;
			const styleId = "dsh-model-select-test/test-ui.css";
			if (document.querySelector('style[data-plugin-css="' + styleId + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", styleId);
			tag.textContent = [
				".dmt-result{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;flex:0 1 148px;min-width:0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}",
				".dmt-result.dmt-ok{color:var(--dsw-alias-state-success-primary)}",
				".dmt-result.dmt-bad{color:var(--dsw-alias-state-error-primary)}",
				".dmt-result[data-dmt-state=running]{color:var(--dsw-alias-label-tertiary)}",
				".dmt-test-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:22px;padding:0 8px;border-radius:max(4px,calc(var(--dsw-radius-md,6px) - 2px));border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;cursor:pointer;background:transparent;user-select:none}",
				".dmt-test-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
				".dmt-test-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
				".dmt-test-btn[data-busy=true]{opacity:.55;cursor:default}",
				".dmt-group-wrap{position:relative}",
				".dmt-group-update{position:absolute;top:-1px;right:4px;z-index:2;font-size:10.5px;line-height:16px;height:18px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap;user-select:none}",
				".dmt-group-update:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
				".dmt-group-update[data-busy=true]{opacity:.6;cursor:default}"
			].join("");
			document.head.appendChild(tag);
		}
		dshModelTestInit();
		//#endregion dsh-model-select-test

		"""


def find_unique(text, needle, start=0):
    first = text.find(needle, start)
    if first < 0:
        raise SystemExit(f"anchor not found: {needle[:60]!r}")
    second = text.find(needle, first + 1)
    if second >= 0:
        raise SystemExit(f"anchor not unique ({first}, {second}): {needle[:60]!r}")
    return first


def main() -> None:
    source = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DSH_MODEL_SELECTION_CLIENT", "")
    if source == "" or not os.path.isfile(source):
        raise SystemExit(DEFAULTS_HINT)
    with open(source, encoding="utf8") as fh:
        text = fh.read()
    original_length = len(text)

    # 1. unique module id. The package name also appears on the CSS tag's
    # dataset marker later in the file; only the loader head may change.
    id_at = text.find(OLD_ID)
    if id_at < 0 or id_at > 200:
        raise SystemExit(f"loader id not at the head (at {id_at})")
    text = text[:id_at] + NEW_ID + text[id_at + len(OLD_ID):]

    # 2. per-row test cells
    row_at = find_unique(text, ROW_ANCHOR)
    split_at = text.find(ROW_SPLIT, row_at)
    if split_at < 0:
        raise SystemExit("row split anchor not found after the row anchor")
    text = text[:split_at] + ROW_INJECT + text[split_at + len(ROW_SPLIT):]

    # 3. group header wrapper (only the MenuGroup call inside the group map)
    group_at = find_unique(text, GROUP_ANCHOR)
    group_return_at = text.find(GROUP_RETURN, group_at)
    if group_return_at < 0:
        raise SystemExit("MenuGroup return not found after the group map")
    text = text[:group_return_at] + GROUP_RETURN_NEW + text[group_return_at + len(GROUP_RETURN):]
    close_at = find_unique(text, GROUP_CLOSE, group_return_at)
    text = text[:close_at] + GROUP_CLOSE_NEW + text[close_at + len(GROUP_CLOSE):]

    # 4. helper subsystem before the exports block
    tail_at = find_unique(text, TAIL_ANCHOR)
    text = text[:tail_at] + HELPER_REGION + text[tail_at:]

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w", encoding="utf8", newline="\n") as fh:
        fh.write(text)

    added = len(text) - original_length
    print(f"source: {source}")
    print(f"output: {OUTPUT} ({original_length} -> {len(text)} bytes, +{added})")
    print("edits: id renamed, row cells injected, group wrapper added, helper region appended")


if __name__ == "__main__":
    main()
