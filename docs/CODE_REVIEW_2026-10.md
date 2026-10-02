# Pi Workbench 整体代码 Review 报告

> ## ⚠️ 状态：已部分修复（2026-10，复核后更新）
>
> | 条目 | 现状 |
> |---|---|
> | **P0-1** 畸形 URL 杀进程 | ✅ **已修复**（`4c77a66`）。三层防御 + 回归防线 `check:security-hardening`（13 项断言，已入 `test:ci`） |
> | **P0-2** `apiKey` 前缀 `!` → RCE | ✅ **已修复**（`4c77a66` / `53946f0`）。HTTP 入口拒绝 `!` 前缀；磁盘上的 `!cmd` 仍可保存、Pi 读盘时仍解析 |
> | **P0-4** CI 的 web 门禁必然失败 | ❌ **本条结论不成立（虚警）**，已从下方删除理由。core/ui 的 `test:ci` 均含 `build`，CI 顺序 core→ui→desktop→web，到 web 那步两个 dist 已存在 |
> | **P0-6** 打包体积 | ⚠️ 结论方向成立但**数字与归因已过期**：实测 core/node_modules 由 428.8MB 涨至 462MB；28 个平台 `@esbuild/*`（284M）实际位于 **`pi-coding-agent/node_modules/@esbuild`**（上游 shrinkwrap 带入），顶层 `core/node_modules/@esbuild` 只有 `win32-x64` 一个。裁剪方案需按真实路径写 |
> | **P0-1 影响面** | ⚠️ 自托管 `CORE_HOST=0.0.0.0` 形态下，投毒需 Host 头在内网白名单内（`server.ts:386` 会 403），原文「内网任何主机」不精确 |
> | 其余 P0/P1/P2 | 未处理，以下方原文为准 |
>
> 下文保留审查当时的原始结论与行号（审查基线 `0a7e834`），未随代码变动重写。**引用行号仅对基线 commit 有效。**

> 审查对象：`F:\DevelopWork\WorkBuddyWork\Tiktok_auto`（产品名 **Pi Workbench**）
> 基线 commit：`0a7e834`（分支 `dev`，与 `origin/dev` 同步）
> 审查方式：只读 + 实测基线。**未修改任何产品代码**。
> 排除范围：`pi/`（上游 clone，318k 行，gitignore 不入库）、`node_modules/`、`dist/`、`build/`、`release/`。
> 实际审查代码量：本项目自有 TS/TSX 约 **57k 行**（ui 38.3k / core 17.2k / desktop 1.0k / web 0.9k）。

---

## 摘要

这个项目的**工程质量明显高于同类原型**：文档记录了 why 与用户裁决、验收脚本把行为断言固化下来、核心 check 有 117 项断言的硬核用例（连"复刻与源码两遍同源"这种自证式断言都有）。基线 `typecheck` 四包全绿、ui/web/desktop 的 `test:ci` 全绿。

但审查发现了 **1 个可实测复现的远程拒绝服务漏洞** 和 **1 条与对话无关的单请求任意命令执行路径**，另有若干结构性风险。核心矛盾是：**项目把大量精力投入到"防静默降级"上（这是对的），却缺少几道最基础的服务端健壮性防线**——一个畸形 URL 就能让整个 core 进程退出。

| 分级 | 数量 | 说明 |
|---|---|---|
| **P0** | 6 | 已实测的 DoS、单请求 RCE、架构性 CI 阻断、依赖版本与声明不一致 |
| **P1** | 14 | 结构性工程债、竞态、安全加固、文档漂移 |
| **P2** | 12 | 改善项 |
| **已排除（非问题）** | 7 | 文档已裁决的设计取舍，或经复核确认安全 |

另外，审查过程中我**推翻了自己和子代理的 4 条初始判断**，这些记录在 §6，因为"什么不是问题"和"什么是问题"同样重要。

---

## 1. 基线实测结果（Phase 0）

命令：本项目自带的 `test:ci`，在**完全权限**下运行（沙箱内无法执行，见 §1.3）。

| 包 | 命令 | 结果 |
|---|---|---|
| core | `npm run typecheck` | ✅ exit 0 |
| ui | `npm run typecheck` | ✅ exit 0 |
| core | `npm run test:ci` | ❌ **exit 1**，耗时 76s |
| ui | `npm run test:ci` | ✅ exit 0，耗时 26s |
| web | `npm run test:ci` | ✅ exit 0 |
| desktop | `npm run build` | ✅ exit 0 |

### 1.1 唯一的红项：`check:session-cache-index` 的 A6

```
✗ A6 索引文件权限 0600  "666"      17/18 通过
```

`packages/core/scripts/session-cache-index-check.mjs:48` 断言 `(fs.statSync(...).mode & 0o777) === 0o600`，实测 `666`。

- **代码本身是对的**：`packages/core/src/session-list-cache.ts:469` 写了 `writeFileSync(tmp, ..., { mode: 0o600 })`。
- **失败原因是平台语义**：Windows 上 `fs.writeFileSync` 的 `mode` 不产生 POSIX 权限位，Node 只在特定条件下映射只读位。
- **这是测试的平台依赖性缺陷，不是安全漏洞**：CI 跑 `ubuntu-latest`（`build.yml:30`），Linux 上该断言会通过。
- **值得注意的对比**：同仓的 `check:file-perms` 就正确地做了平台跳过——`check:file-perms: SKIP-POSIX-ONLY（win32 不支持 POSIX 权限位）`。同一个项目里两种处理方式，说明缺的是统一约定，不是能力。

**影响**：Windows 开发者本地 `test:ci` 永远红，会训练出"红项无所谓"的习惯——这恰好侵蚀项目最看重的验收纪律。**代价：小**（加平台 skip，与 `file-perms-check` 对齐）。

### 1.2 CI 门禁的真实覆盖面（关键结论）

**CI 跑的是自研脚本，不是测试框架。** 全仓 `*.test.*` / `*.spec.*` 文件数 = **0**；`packages/core/test/` 里**只有 fixtures**；四个包都没有 vitest/jest/mocha/node:test 依赖。

CI 实际运行（`.github/workflows/build.yml:28-65`，`runs-on: ubuntu-latest`）：

| 包 | 跑什么 |
|---|---|
| core | `typecheck` + `build` + 20 个 `check:*` + `security-check` |
| ui | `typecheck` + 19 个 `check:*` + `build` |
| desktop | `typecheck` + `check:boot-env` + `check:last-run` + `build` |
| web | `npm run assemble`（**只拷产物，零验证**） |

**完全不在 CI 里的**：
- 全部 CDP 浏览器验收：`accept:m1`~`m5`、`shots:m1`、20+ 个 `probe:*`、`live:smoke`。这些依赖系统 Chrome（`packages/ui/scripts/chrome-path.mjs:32-53`），而 CI 既没装 Chrome 也没设 `CHROME_PATH`。**⇒ UI 交互层在 CI 上零覆盖。**
- `packages/web/scripts/smoke.mjs` —— 这是**真正的发布前防线**（起 tarball 里的 core、探 `/health`、探 `/skills` 与 `/packages` 并要求非空数组）。`assemble.mjs:17-22` 的注释说明它守的是"过期 core 产物缺路由 → SPA 回退返回 200 + index.html"那次真实事故。
- desktop 的 `npm run smoke`。
- `check:c3/c4/c5/c6`、`check:providers`（`build.yml:26-27` 明确说明因需真实模型凭证而排除，属已知取舍）。
- **`on:` 只有 `workflow_dispatch` 与 `push: tags: v*`** —— PR 与分支推送**完全不触发**。v0.2.0 之后 dev 上累积的 21 个 commit，在 CI 上一次都没被验证过。

### 1.3 测试体系的结构性缺陷（这条影响很大）

`packages/core/src/main.ts` 是一个**只能被 spawn、无法被 import** 的入口：它从第 144 行起在模块顶层直接 `await startServer(...)`，且全文件无 `export`。

后果：**所有需要"起一个 core"的检查脚本都只能 `spawn` 一个子进程**（`core/scripts/` 里 17 个脚本用 `spawn(process.execPath, [tsxPath, mainPath])`），每个都要付一次 tsx 转译 + 进程启动成本。这就是 core `test:ci` 耗时 76 秒的根因。

对比：`trust-policy-check`、`fs-list-check`、`fs-search-check`、`sessions-manage-check` 等都各自独立 spawn 一个 core 并轮询 `/health` 等它就绪。**把 `startServer` 作为可导入的 API 暴露（或把自动启动移到 `if (import.meta.main)` 之后），能让大部分检查进程内起服务，预计把 76s 压到 10-20s，并让它们不再依赖子进程管道。**

**附带的现实影响**：因为 42 个 check/probe 脚本依赖子进程（core 19 + ui 23，其中 30+ 走 CDP 驱动真实浏览器），**整套验收在有管道限制的沙箱环境里根本跑不起来**（我实测 `ui` 的链在第 8 项 `check:sidebar-layout` 就因 esbuild `spawn EPERM` 中断）。这不是项目缺陷，但它意味着"验收可复跑"这条纪律对环境有隐含要求。

---

## 2. P0 —— 阻塞级问题

### P0-1 一条畸形 URL 即可让 core 进程退出（**已实测复现**，无需 token）

**证据**：`packages/core/src/server.ts:333`

```ts
let rel = decodeURIComponent(urlPath.split("?")[0]);
```

`decodeURIComponent` 对畸形百分号编码抛 `URIError`。整条调用链上没有任何 try：

- `server.ts:1125-1126` — `if (req.method === "GET") return serveStatic(res, urlPath);`（不在 try 内）
- `server.ts:377` — `createServer(async (req, res) => {...})`，返回的 rejected promise 无人 await
- `packages/core/src/main.ts` 全文只有 `SIGINT`/`SIGTERM` 处理（`:191-192`），**没有 `uncaughtException`/`unhandledRejection` 兜底**

**实测结果**（用原始 socket 发送，脚本见 `review-artifact-dos-probe.mjs`）：

```
[1] core 已监听，/health → HTTP/1.1 401 Unauthorized
[2] 对照 GET /index.html      → HTTP/1.1 200 OK
[3] 投毒 GET /%               → SOCKET_ERR ECONNRESET
    ⇒ 进程仍在 = false   code=1 signal=null

URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at serveStatic (...\packages\core\src\server.ts:333:13)
    at Server.<anonymous> (...\packages\core\src\server.ts:1126:11)
```

**关键点：这条路径在鉴权之前。** `/%` 不在 `API_ROUTES`（`server.ts:109-215`）里，所以 `server.ts:393` 的 Bearer 校验被跳过，**任何能访问该端口的人都能触发**，不需要 token。

**已确认的其它触发载荷**：`/%`、`/%zz`、`/a%2`、`/%E4%B8` 全部抛 `URIError`（`new URL("/%", base)` 本身不抛，抛的是 `decodeURIComponent`）。合法编码如 `/%E4%B8%AD` 正常。

**影响面**：
- 桌面版：core 是 `ELECTRON_RUN_AS_NODE` 子进程，`packages/desktop/src/main.ts:285-291` 在 core 就绪后死亡时会弹窗并 `app.quit()` —— 即**用户的应用会被一条本地请求关掉**。
- 自托管版（`CORE_HOST=0.0.0.0` 内网开放，`docs/deploy.md` 明确支持）：**内网任何主机都能远程打死服务**。
- 本机场景：任何网页只要能让浏览器发一个该 URL 的请求……（浏览器会规范化 `/%`，这条路径在浏览器侧不可达），因此**主要威胁来自本机进程与内网主机**，但这已足够是 P0。

**修复方向**（代价：小，约 5 行）：
1. `serveStatic` 内把 `decodeURIComponent` 包 try/catch，失败返回 400；
2. 给 `createServer` 的 handler 加顶层 try/catch（返回 500，永不逃逸）；
3. `main.ts` 加 `process.on("unhandledRejection")` / `uncaughtException`，记录后优雅退出而非裸崩。

**置信度：高（已实测）。**

---

### P0-2 `apiKey` 前缀 `!` 触发 shell 执行 —— 与对话无关的单请求 RCE

**证据**：`packages/core/src/providers.ts:610-624`

```ts
function resolveCredential(raw: string): ResolvedCredential {
	if (!raw) return { key: "", missingEnvVars: [] };
	if (raw.startsWith("!")) {
		try {
			const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
			const out = execSync(raw.slice(1), { shell, timeout: 8000, encoding: "utf8" }).trim();
			return { key: out, missingEnvVars: [] };
```

`raw` 的**唯一来源是 HTTP 请求体**：
- `server.ts:1089-1100` — `POST /models/test`，`body.apiKey` 直接进 `runtime.testModel(body)`
- `server.ts:1103-1114` — `POST /providers/models`
- `contract.ts:734-737` 的契约注释明写 `!`/`$ENV` 插值由 core 解析

**无任何前置条件**：不需要流式空闲、不需要配过 `models.json`、不需要目录受信任。

**PoC**（我未执行，但调用链逐一核对过）：

```bash
curl -X POST http://127.0.0.1:5190/models/test \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"baseUrl":"http://127.0.0.1:1","modelId":"x","api":"openai-completions","apiKey":"!<任意命令>"}'
```

**与"文档已接受的设计"的关系**（这点很重要）：`packages/core/docs/deploy.md:159` 确实声明"拿到 token 的人可让 agent 执行任意 shell 命令"。但那是**经对话驱动 agent 工具**，有授权卡、有信任门、有审计痕迹。本条是**与对话/模型/授权完全无关的单请求 shell 面**，而且 `docs/PROJECT_CONTEXT.md` 只记录了 `$ENV_VAR` 插值（§5），**从未提及 `!` 前缀会在 core 进程内执行 shell**。所以这是独立的、未文档化的能力面。

**修复方向**：代价小 —— 两个入口拒绝以 `!` 开头的 `apiKey`；代价中 —— 挪到显式开关 + 每次执行发 SSE 事件。

**置信度：高（代码与调用链已亲自核对）。**

---

### P0-3 SSRF：`baseUrl` 无任何限制

**证据**：`packages/core/src/providers.ts:637-644`（`buildTestEndpoint` 只做尾部斜杠规整）、`providers.ts:978-1005`（`fetch` 并把上游状态码与响应体前 300 字符回显）、`providers.ts:650-663`（请求体可自带任意 `headers`）。

入口同样是 `POST /models/test` 与 `POST /providers/models`，通读 `providers.ts` 全文确认**无任何 URL/host/scheme 校验**。

**影响**：token 持有者可把 core 当内网探测代理（`baseUrl=http://192.168.1.1:80`）、打云元数据端点（`http://169.254.169.254/latest/meta-data/...`），并可用自定义 `headers` 构造带 `Cookie`/`Host`/`X-Forwarded-For` 的请求。自托管/内网形态下风险更实质。

**修复方向**：代价中 —— `assertSafeUpstream(url)` 拒绝私有/回环/链路本地地址 + 开关放行本机 llama.cpp 这类合法用法。

**置信度：高。**

---

### P0-4 CI 的 `web` 门禁在干净环境必然失败，从而阻断整条流水线

> #### ❌ 本条结论不成立（2026-10 复核推翻，虚警）
>
> 原推理漏看了**同一个 job 内前序 step 已经把产物构建出来**：
> - `packages/core` 的 `test:ci` = `typecheck` + `build`（`tsc -p tsconfig.build.json`）⇒ 产出 `core/dist` ✅
> - `packages/ui` 的 `test:ci` **含 `build`** ✅ ⇒ 产出 `ui/dist` ✅
> - `build.yml` 的 step 顺序为 core → ui → desktop → **web**，web 的 `assemble` 到达时两个 dist 均已存在
>
> ⇒ CI 不会因这条断。真实代价只是**白跑**（core 的 76s 检查在 web 之前纯浪费），属性能问题而非阻断问题。
> 本条恰是「该触发一次 CI 却没触发」的典型——原报告自己也标了「置信度 中高、未实际触发 CI」。
> 下面保留原文供追溯。

**证据**：
- `build.yml:61-65` 在干净 checkout 上跑 `packages/web` 的 `npm run test:ci`
- `packages/web/package.json:41` → `"test:ci": "npm run assemble"`
- `packages/web/scripts/assemble.mjs:81-89` 要求 `packages/core/dist` 与 `packages/ui/dist` 已存在，否则 `process.exit(1)`
- 这两个目录被根 `.gitignore:12` 的 `dist/` 规则排除，`git ls-files` 确认未入库
- `packages/web` 不依赖 core/ui，`npm ci` 不会去兄弟目录取产物

**后果**：`test` job 失败 ⇒ `build` 的 `needs: test` 不满足 ⇒ **三平台构建、Release、npm 发布一个都不会跑**。而表面症状是"web test 失败"，会把排查引向错误方向。

**修复方向**（代价：小）：test job 里在 web 之前先 build ui 与 core；或把 `packages/web/scripts/smoke.mjs`（自带 assemble 且真的起服务验证）作为 web 的 `test:ci`。

**置信度：中高** —— 这是从代码前置检查 + tracked 文件状态推出的，**未实际触发 CI 验证**。但逻辑链完整，且 `dist/` 未入库是硬事实。

---

### P0-5 `pi-coding-agent` 三个版本并存：声明 ≠ lock ≠ 实装

| 位置 | 值 |
|---|---|
| `packages/core/package.json:47`、`packages/web/package.json:44` 声明 | `^0.99.2` |
| `packages/core/package-lock.json:24-26` 锁定 | `0.99.2`（来源 npmmirror） |
| **本机 `node_modules` 实装** | **`0.99.1`** |
| 源码注释锚点 | 混用：`session.ts:1142` 写"0.99.1 声明是 SessionEntry \| undefined"（只对 0.99.1 实查过），其余多处写 0.99.2 |

**后果**：本机所有 `test:ci`（typecheck + 20/19 个 check）验的是 **0.99.1** 的类型面，CI 用 `npm ci` 装的是 **0.99.2** —— 门禁与开发机验的不是同一份 SDK。而升级提交 `31abf2b` 之后本机没有重装，0.99.2 的 API 变化没有任何人复核过。

这个项目把"静默降级"视为头号忌讳（`packages/core/src/main.ts:79` 原话、多处 check 专门断言"未静默降级"），**而这恰好发生在最核心的依赖上**。

**修复方向**（代价：小到中）：重跑 `npm ci` 装 0.99.2，对 0.99.2 重跑全链并复核 `session.ts`/`contract.ts`/`tools.ts` 的锚点注释；建议把 `^0.99.2` 收成精确版本。

**置信度：高（已核对四处）。**

---

### P0-6 桌面安装包把 429MB 的 `core/node_modules` 原样打进三平台

**证据**：`packages/desktop/package.json:46-49`

```json
{ "from": "../core/node_modules", "to": "core/node_modules" }
```

**实测体积**：`packages/core/node_modules` = **428.8 MB**，其中 `@earendil-works` 占 **392.2 MB**。构成是 **esbuild 的约 28 个平台预编译包**：

| 单项 | 大小 |
|---|---|
| `@esbuild/android-x64/esbuild.wasm` | 13.3 MB |
| `@esbuild/android-arm/esbuild.wasm` | 13.3 MB |
| `@esbuild/openharmony-arm64/esbuild.wasm` | 13.3 MB |
| `@esbuild/aix-ppc64/bin/esbuild` | 12.0 MB |
| `@esbuild/win32-x64/esbuild.exe` | 11.2 MB |
| `@esbuild/linux-x64/bin/esbuild` | 10.9 MB |
| `@esbuild/darwin-x64/bin/esbuild` | 11.1 MB |
| …（linux-mips64el / linux-s390x / linux-loong64 / linux-ppc64 / linux-ia32 / linux-arm / freebsd / netbsd / openbsd / sunos-x64 / android-arm64 / win32-ia32 / win32-arm64 / darwin-arm64 …） | 各 10-13 MB |

另有 `typescript` 22.5 MB（`devDependencies`，运行时不需要）。

**后果**：Windows 安装包里带着 Android、AIX、FreeBSD、SunOS、OpenHarmony 的 esbuild 二进制，Linux 包里带着 `esbuild.exe`。这是纯浪费，且随每次打包规模固定支出。

**修复方向**（代价：小到中）：打包前对 `core/node_modules` 做一次平台裁剪（只留当前 target 的 `@esbuild/<platform>` 与 `@earendil-works`），或改用 electron-builder 的 `files` 过滤器排除 `**/@esbuild/{android,aix,freebsd,netbsd,openbsd,sunos,openharmony}*/**`，并在 `scripts/package-*.mjs` 里按平台参数化。

**置信度：高（体积已实测）。** 注：我**未实际运行 electron-builder 解包核对**，结论基于配置 + 目录体积。

---

## 3. P1 —— 结构性工程债

### 3.1 架构与耦合

**P1-1 四个包相互独立，不是 workspace；根目录没有 `package.json`。**
`packages/{ui,core,desktop,web}` 各有自己的 `package.json` + `package-lock.json`（4 份 lock 均入库）。**对 npm 不构成 workspace**，每个包各自安装各自的依赖树。后果：
- 依赖版本漂移无约束（实测：`@types/node` core 用 `^22.10.2`、desktop 用 `^22.20.4`；`typescript` core/ui 用 `^5.7.2`、desktop 用 `^5.9.3`）；
- 构建顺序（ui/dist → core 同源托管 → desktop 打包 → web 组装 tarball）只靠**文档与 CI step 顺序**保证，没有任何机械约束；
- 跨包类型共享只能靠"手工镜像 + 文本检查脚本"（见 P1-7）。

**P1-2 契约镜像机制 `contract-mirror-check.mjs` 有 5 类确认的盲区。**
脚本自身诚实记录了部分局限（`packages/ui/scripts/contract-mirror-check.mjs:22-25`、`:147-175`）。我实测确认：
- **只比字段名，完全不比类型签名与可选性** ⇒ 把 `apiKey?: string` 改成 `apiKey: string` 不会红；
- **`export type` 别名整类不受检**：`contract.ts` 有 14 个 `^export type`（含 `ThinkingLevelName` 的 7 档联合、`SlashCommandSource`、`ProviderCompat`），脚本正则只认 `^export\s+interface`（`:62`）⇒ 7 档思考档位这类"改了会静默改变行为"的字面量联合**全在盲区**；
- 判据 B 的空集守卫可被 `mock/types.ts:77` 的一行 `import type` 尾部匹配污染，导致"静默丢项却报全绿"；
- 脚本注释自己记录：`mock/types.ts` 的块注释含字面 `}` 曾导致 21 个条目只解析出 18 个而**没红**——**"解析器悄悄失灵却报全绿"在本仓库已真实发生过一次**；
- 守护的是"已存在的镜像是否漂移"，**不是"是否应该用镜像"**——新写一个手抄副本不会触发任何检查。

`contract.ts` 有 **59 个 interface + 14 个 type**，只有 11 个走手抄镜像，其余靠真 re-export（天然同源）。所以风险集中在"有人又手抄了一份"。

**P1-3 `packages/core/src/session.ts` 68.5KB / `server.ts` 51KB / `contract.ts` 47.5KB 过大。**
`session.ts` 单文件 1427 行，同时承担：会话生命周期、扩展绑定、cwd 热切换、资源重载、prompt 驱动、授权桥接、包管理、技能安装。`server.ts` 1149 行把所有 HTTP 路由内联在单个 async handler 里。这两个文件是本次审查中**大部分竞态缺陷的共同来源**（见 §4）。UI 侧同理：`MessageList.tsx` 59.5KB、`agent-transport.ts` 44.9KB、`chat-store.ts` 41.3KB。

**P1-4 `mock/` 目录承担了双重角色，且 live 路径存在真实分支。**
- `packages/ui/src/mock/types.ts` 是**共享类型中枢**（`export type {...} from "../../../core/src/contract.ts"` 真 re-export 56 个类型），生产组件普遍 `import type { ... } from "@/mock/types"` —— 这个用法是**刻意的**（`PROJECT_CONTEXT.md:6` 有说明）。
- 但生产组件同时 import **mock 数据常量**，且 live 路径有分支，与 `PROJECT_CONTEXT.md:65` 的"mock/live 共用同一套渲染逻辑，**零特判**"不符：
  - `Sidebar.tsx:338-339` — `const summaries = live ? liveSummaries : SESSION_SUMMARIES; const relativeAnchor = live ? Date.now() : SESSION_LIST_NOW;`
  - `MessageList.tsx:997` — 模型标签回退链 `live 的 /models 清单 → mock 的 COMPOSER_MODELS → 原始 id`
  - `PluginsSettingsTab.tsx:69` / `SkillsSettingsTab.tsx:55` — `isLiveEnabled() ? null : MOCK_*`
  - `WorkingDirectoryMenu.tsx:111,161`、`ComposerToolbar.tsx:78,151`、`SettingsGeneralTab.tsx:103`、`ModelProvidersTab.tsx:262`

**这是文档与代码的漂移，不一定是缺陷**（回退到 mock 常量作为兜底是合理设计），但"零特判"这条纪律已经被突破且无人更新文档——对以文档驱动协作为主的项目，这会让新协作者（人类或 AI）做出错误假设。

### 3.2 安全加固（非阻塞，但值得做）

**P1-5 `GET /providers` 明文回显 `apiKey`。** `providers.ts:528-537` 的 `apiKey: asString(rec.apiKey)` 原样进响应，`:16-17` 注释承认"按 D6 原文返回、不脱敏"。`PROJECT_CONTEXT.md` 与 `deploy.md` **都没记录这条口径**。建议掩码 + `PUT` 时空/掩码值视为保留原值。**代价：小。**

**P1-6 信任门出厂默认 `always`。** `packages/core/src/trust.ts:135-138` 的 `?? "always"`（不是 `ask`），`trust.ts:167-169` always 直接放行不提问。配合 `POST /cwd` 指向任意目录 ⇒ 该目录的 `.pi/extensions/*` 会被加载执行。旁证：项目自己的安全自检 `packages/core/scripts/core-security-check.mjs:28` 反而显式写 `defaultProjectTrust: "never"`。
`trust.ts:37-39` 注释称这是"有意的安全基线翻转"，所以**这是产品裁决而非 bug**——但值得重新评估，因为这条与"桌面版安全加固候选"（`PROJECT_CONTEXT.md:83`）是同一类问题。**代价：1 行（但属行为变更，需你裁决）。**

**P1-7 静态响应缺三件套安全头。** `server.ts:361` 注入 token 的 HTML 响应只有 `Content-Type`，**没有** `X-Content-Type-Options: nosniff`、**没有** CSP、**没有** `Referrer-Policy`。对比 `server.ts:665` 的 `/sessions/image` 就正确地加了 `nosniff`。

关于"任意网站 `<script src>` 偷 token"这条结论，**我复核后判定不成立**（跨源 `<script>` 对 `text/html` 响应不会执行，浏览器拒绝非 JS MIME 的脚本）。但缺头本身是真实的纵深防御缺口，且 `/sessions/image` 的 `?token=` 豁免（`server.ts:395-414`）没有 `Referrer-Policy` 兜底。**代价：小（3 行）。**

**P1-8 Host 白名单大小写敏感、`::1` 不在默认清单。** `server.ts:386` 的 `allowed.includes(hostnameOf(host))` 是大小写敏感比对 ⇒ `Host: LOCALHOST` 会被 403（假阴性，不是安全问题）；`::1` 不在默认 `["127.0.0.1","localhost"]`（`packages/core/src/main.ts:72`）。**代价：小。**

**P1-9 错误响应直出 `String(e)`，与既有纪律矛盾。** `server.ts` 有 20+ 处 `String(e)` / `e.message` 直接进 HTTP 响应。而 `skills-install.ts` 已专门建立"只带 errno code"的纪律（`packages/core/src/main.ts:79` 也把"静默降级/信息泄露"列为忌讳）。缺一个统一的 `errorText(e)` 出口。**代价：小。**

### 3.3 可靠性

**P1-10 换会话竞态：生成被静默丢弃，UI 停在流式且无任何提示。**（经对抗性验证确认机制成立，但描述修正）

`session.ts:930-934`（`newSession`）与 `:871-874`（`switchCwd`）在 `await ready` 后**只检查一次** `session?.isStreaming`，之后进入长窗口（`:939 await resourceLoader.reload()`、`:889 await bootProject(target)` 含最长 120s 信任门），窗口结束时 `:966` / `:901` 执行 `previous?.dispose()`。

上游 `dispose()` 的实现（`packages/core/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:968-987`）是全同步的：`agent.abort()` → `_extensionRunner.invalidate()` → `_disconnectFromAgent()` → `_eventListeners = []`。而终态事件是**异步补发**的（`pi-agent-core/dist/agent.js:341-379`），那时监听数组已空 ⇒ **旧会话之后不会再有任何事件到达 core/SSE**。

UI 只在 `agent_settled` 复位 streaming（`adapter/reduce.ts:166-173`），`usage` 事件不碰 streaming（`chat-store.ts:247-250`）。

**修正后的准确描述**：
- `newSession` 路径：生成被静默丢弃、UI 停在流式、**无终态也无错误提示**，需用户手动点停止自救（`Composer.tsx:246-255` + `chat-store.ts:551-557`）。
- `switchCwd` 路径：**不会**永久卡流式——`session.ts:899-902` 先 dispose 再发 `cwd_changed`，UI 收到后 `startNewSession()`（`chat-store.ts:258-262`）会复位。表现为"生成被硬切 + 消息区被清空"。

**代价：中**（换会话做成互斥临界区 + `await` 后二次校验）。

**P1-11 并发点击会话导致状态错配，且 core 侧 `rebuildSession` 无互斥。**
UI：`chat-store.ts:691-728` 的 `loadSessionById` 无请求代序守卫，`:712-723` 在 `await` 后整批覆盖 `messages/sessionTitle/liveSessionId` ⇒ 慢响应必然覆盖新选择。调用点**不串行**：`Sidebar.tsx:340,443` 直接把 `loadSessionById` 挂到 `onClick`，无 loading/disabled/去抖。
core：`session.ts:1119-1127` 的 `loadSession` 在非流式时 `await rebuildSession(path)`，而 `rebuildSession`（`:828-852`）在 await 之间操作**模块级** `session`（`:844 await bindExtensions` 时 `session` 可能已被另一个并发调用改写）⇒ 交错时可能把监听器订阅到错误会话（双订阅 ⇒ SSE 事件重复下发）并 dispose 掉刚建的实例。
**代价：小（UI 加代序号）+ 中（core 加互斥）**。

**P1-12 SSE 断线重连的复位缺口。**（原判 P1，对抗验证后**下调为 P2 级严重度**，但缺口真实）
`agent-transport.ts:434-460`：正常 EOF 走 `done → break`（`:436`），**不经过** `:451` 的 catch ⇒ 不调 `notifyOutage`；而 UI 的 streaming 复位**只**挂在 `onConnectionError`（`chat-store.ts:191-200`），`onConnectionRestored`（`:202-217`）不复位 streaming。
- 若 core 真死了：下一轮重连 fetch 失败会触发 `notifyOutage` ⇒ 会复位（延迟约一次退避）。桌面壳在 core 就绪后死亡是直接弹窗退出，不会静默重启。
- **真正会卡住的是**：流干净结束、但同端口上已换了新 core（dev 重启 core 场景），此时重连成功、`outageNotified` 恒 false ⇒ 不复位、不提示。
另：`/events` 无 `id:`/`Last-Event-ID`，断线期间事件永久丢失。**代价：中。**

**P1-13 `readBody` 无长度上限、无 `error`/`aborted` 处理。**（原判 P1，**下调为 P2**）
`server.ts:259-271` 只挂 `'data'`/`'end'`。对抗验证实测：`d += <1MB Buffer>` 在 536,870,888 字符处抛 `RangeError: Invalid string length`（V8 最大字符串上限），且 `main.ts` 无 `uncaughtException` 兜底 ⇒ 监听器内异常 = 进程退出。
**但**：所有 `readBody` 调用点都在 `:393` 鉴权之后，所以需要**有效 token**。另：客户端中途断开时该 Promise 永不 settle（无 `'error'`/`'aborted'`）⇒ 闭包与响应对象泄漏。

### 3.4 工程化与发布

**P1-14 零 lint/format 工具链的实际代价（有实证）。**
全仓无 eslint/biome/prettier 配置，但有自研 `check:format`（实为**数值格式化断言**，检查 `formatCompact()` 的 14 个取值，不检查代码格式——`packages/ui/scripts/format-check.mjs`）。实证的六项代价：
1. **同一仓库跨包缩进风格分裂**（实测，已剥离注释行与块注释续行后统计代码行首缩进）：

   | 包 | tab 缩进行 | 空格缩进行 | 空格占比 |
   |---|---|---|---|
   | `packages/core/src` | 2763 | 1154 | 29.5% |
   | `packages/ui/src` | 1557 | 10306 | **86.9%** |
   | `packages/desktop/src` | 325 | 33 | 9.2% |

   即 `core`/`desktop` 以 tab 为主、`ui` 以空格为主，且**每个包内部都不纯**。同包内具体混合：`core/src/server.ts` 761 行 tab vs 9 行空格；`ui/src/services/agent-transport.ts` 29 行 tab vs 580 行空格（同一文件两种缩进）。
   另有函数体内缩进层级跑偏的实例：`core/src/session.ts:960-970` 的 `newSession` 函数体尾部（`:967-969`）只缩进 1 层，而函数体主体（`:960-966`）是 2 层，闭合的 `};`（`:970`）回到 0 层——同一函数体内三种层级。
2. **同文件内格式已跑偏**：`packages/ui/package.json:59` 的 `"check:message-height"` **行首零缩进**，上下相邻行都是 4 空格（我亲自确认）。
3. **失效的 `eslint-disable` 注释**：`screens/settings/ModelProvidersTab.tsx:112` 与 `screens/SettingsDialog.tsx:147` 各有一行 `// eslint-disable-next-line react-hooks/exhaustive-deps`，而规则集根本不存在 ⇒ 这两个 `useEffect` 依赖数组违规**从来没人检查**。这是"以为有 lint"的典型代价。
4. **46 处空 catch**（core/src 35 处、ui/src 11 处）无机械守护。对一个把"静默降级"列为头号忌讳的项目，这 46 个位点全靠自觉。
5. **JSON 重复键**：`packages/core/package.json:14` 与 `:18` 都是 `"check:trust"`（本次恰好同值，但只改一行就会得到"改了没生效"的幽灵 bug）。
6. **`test:ci` 是 700+ 字符的 `&&` 长串**（`packages/ui/package.json:60`，19 个脚本串联），链中任一脚本改名只能在 CI 上以"命令不存在"暴露。

建议上 Biome（格式化 + lint + import 组织一体），并给 `check:format` 改名为 `check:number-format` 以免误导。**代价：中（一次性 3 万行 diff，需配 `.git-blame-ignore-revs`）。**

**P1-15 4 份 lockfile 的 `resolved` 指向 `registry.npmmirror.com`，而仓库没有 `.npmrc`。**
实测：`packages/desktop/package-lock.json` npmmirror 287 处 / npmjs 0 处；`packages/ui` 272 / 0；`core` 33 / 146；`web` 1 / 146（后两个混了两套 registry）。`.npmrc` 在仓库、上级目录直到 `F:\` 均不存在。
**后果**：GitHub Actions 上 `npm ci` 会按 lock 的 `resolved` 去拉国内镜像（含 electron/electron-builder 二进制链），镜像一旦被墙/限流/返回异体字节（integrity 不匹配）⇒ `build` 矩阵全线红。**代价：中（加 `.npmrc` + 用官方源重生 4 份 lock）。**

**P1-16 流水线不校验 tag 与包版本一致性，也无发布前置校验。**
`build.yml:135` 与 `:168` 只有 `if: ${{ !cancelled() && github.ref_type == 'tag' }}`，全文件 212 行**没有任何 version ↔ tag 比对**。四包 `version` 都是 `0.2.0`，而 `v0.2.0` 之后 dev 已累积 21 个 commit。
**后果**：`git tag v0.2.5` 会以 `package.json` 里的 `0.2.0` 发包；release 与 publish 并行无依赖 ⇒ 可能出现"Release 页有 v0.2.5 安装包、npm 上还是旧版"的半发布状态；tag 可从 stale 分支（`main`/`dev-build` 均 behind 15）推送 ⇒ 发旧代码。**代价：小（加版本比对 + `git merge-base --is-ancestor` 守卫）。**

**P1-17 无 `concurrency`，重复发版风险。** `build.yml` 全文件无 `concurrency:`，同一 tag 重跑会让两个 run 并行走到 `action-gh-release` 与 `npm publish`（后者第二次必 E403）。**代价：小。**

**P1-18 环境可复现性：CI Node 22 vs 本机 Node 24。** 四包 `engines.node` 一致为 `>=22.19.0`（这点是好的），但**无** `.nvmrc`/`.node-version`；CI 固定 `node-version: 22`，本机实测 `v24.14.0`。`packages/ui/package.json:7` 的 `packageManager: npm@10.9.7` 与本机 npm 11.9.0 也不一致。**代价：小。**

---

## 4. P2 —— 改善项

| # | 问题 | 证据 | 代价 |
|---|---|---|---|
| P2-1 | `check:session-cache-index` 的 A6 缺平台 skip，Windows 本地永远红 | `packages/core/scripts/session-cache-index-check.mjs:48`（对比 `packages/core/scripts/file-perms-check.mjs:175` 的正确做法） | 小 |
| P2-2 | 授权卡点击无本地锁定，可重复提交且失败静默 | `chat-store.ts:580-597` 只更新 `messages` 不清 `pendingApprovals`；`transport.resolveApproval(...).catch(() => {})` | 小 |
| P2-3 | `fs-search.ts:82-98` 用同步 `execFileSync` 跑 git（timeout 5s / maxBuffer 64MB），阻塞 core 事件循环含 SSE 心跳 | `fs-search.ts:82-98` | 中 |
| P2-4 | `fs-search` 的 git 分支 `path.join(target, ...rel.split("/"))` 未过滤 `..` 段 | `fs-search.ts:193-206`（`walk` 分支无此形状） | 小 |
| P2-5 | `shutdown` 非幂等，重复信号走两遍 `close()`/`dispose()` | `packages/core/src/main.ts:185-192` | 小 |
| P2-6 | `providers.save` 并发 PUT 末位胜（读回磁盘→合并→原子写，无互斥） | `providers.ts:777-807` | 小 |
| P2-7 | `u-${Date.now()}` 同毫秒双发会撞 user id，届时 handled 撤回会一次删两条（注：同批的 `a-${messages.length}` 复用问题已经对抗性验证**推翻**，见 §6.2，仅 `u-` 这一半保留） | `adapter/reduce.ts:184,239`；`chat-store.ts:469-474` | 小 |
| P2-8 | `MessageList.measureRow` 在占位行处提前 return，导致虚拟器测量表与 `heightMemory` 对同一索引给出不同值 | `MessageList.tsx:194-200,338-348,796-797` | 小 |
| P2-9 | `rebuildSession` 无 `disposed` 检查、无失败回滚（与 `bootProject`/`newSession` 不对称），抛错会留半初始化活动会话且旧实例不 dispose | `session.ts:828-852` | 小 |
| P2-10 | `ui-context.dispose()` 只 resolve 不下发 `approval_settled`，SSE 仍连着时浮层卡残留到下次重连 | `ui-context.ts:147-153` | 小 |
| P2-11 | `tag`↔`version` 四处版本号手工维护；无 `/version` 端点，线上跑哪个版本只能人工追溯 | 四份 `package.json` + 4 份 lock 顶层 version | 小 |
| P2-12 | 跨包类型共享靠手工镜像；`contract.ts` 59 interface + 14 type 仅 11 个走镜像 | 见 P1-2 | 中 |

---

## 5. 文档与代码的漂移（Phase 6）

`docs/PROJECT_CONTEXT.md` 质量很高（记录 why 与用户裁决，这在同类项目里罕见）。用它的陈述逐条核对代码后，发现以下不一致：

| # | 文档陈述 | 代码实际 | 位置 |
|---|---|---|---|
| D1 | §2 说偏好分裂是 "**localStorage** 里…各存一份的旧问题" | `packages/desktop/src/main.ts:45-46` 的注释写的是 "**leveldb** 实证：10 个 origin 各存一份" | `PROJECT_CONTEXT.md:21` vs `packages/desktop/src/main.ts:45-46` |
| D2 | §3 说 `ui/src/` 的结构是 "`adapter/`（live 形态适配器）与 `mock/`（演示形态数据源）双实现 → `store/` → `components/` → `screens/`" | `ui/src/adapter/` 只有 `pi-events.ts`(0.7KB) + `reduce.ts`(16.5KB)；live 适配器实际在 `services/agent-transport.ts`(44.9KB)，状态在 `store/chat-store.ts`(41.3KB) | `PROJECT_CONTEXT.md:46` |
| D3 | §4 纪律："mock/live 共用同一套渲染逻辑，**零特判**" | live 路径有大量真实分支：`Sidebar.tsx:338`、`MessageList.tsx:997`、`PluginsSettingsTab.tsx:69`、`SkillsSettingsTab.tsx:55`、`WorkingDirectoryMenu.tsx:111,161`、`ComposerToolbar.tsx:78,151`、`SettingsGeneralTab.tsx:103`、`ModelProvidersTab.tsx:262` | `PROJECT_CONTEXT.md:65` |
| D4 | §6 说屏是"8 屏六路由"（根 `README.md:31` 同） | 实证：`App.tsx:33-39` 的 `SCREEN_BY_HASH` 恰有 **5 个键**，`:157-172` 的 switch 也恰处理 **5 个屏**（`tokens` 在 `:164`）；设置是**弹窗不是路由**（`:178`，`PROJECT_CONTEXT.md:87` 自己也这么写）。根 README 的"8 屏六路由"与代码对不上。另：`App.tsx:21-22` 的注释自己说"M5 已扩到 6 屏"、同时又列出 8 个目标 —— 同一处注释内部就不一致 | 根 `README.md:31`、`PROJECT_CONTEXT.md:87` vs `packages/ui/src/App.tsx:21-24,30-39,157-172` |
| D5 | §7.6 给出核对口径 "`typecheck` → 各 check 脚本 → `accept:m1`~`m5` → `probe:*`（截图过）"，附录"已知基线：`accept:m2` 31/32" | 其中 `accept:*` 与 `probe:*` **全部不在 CI 里**（§1.2）；且 §8 待办里又写"目录树批次验收脚本补写"，说明 `accept` 批次本身不完整 | `PROJECT_CONTEXT.md:99,107` |
| D6 | §5 记录 `/fs/*` 越界为"（CR-018 选项 B：文档声明接受、零代码改动）" | **复核判定文档陈述准确**（`fs-list.ts:99`/`fs-read.ts:82`/`fs-search.ts:167` 都是 `path.resolve(expandHome(raw) \|\| cwd)`，无 cwd 前缀校验）。但比文档**更宽**两处：(a) 越界读不止这三条，还有 `/sessions?all=1` 跨项目读会话；(b) §5 的措辞容易被读成"写路径一律受 cwd 约束"，实际 `POST /cwd` 换根后 `/skills/install {scope:"project"}` 会写到新根 | `PROJECT_CONTEXT.md:83` |
| D7 | `lib/highlight.ts:9-11` 说 `bundle/web` 入口"只预置了常用集合…产物体积可控" | 实测 `ui/dist` 有 **120+ 个 shiki 语言/主题 chunk**（`cpp` 785KB、`wasm` 622KB、`angular-ts` 184KB…），总计 **5.77 MB / 128 文件**。代码只请求 12 种语言（`highlight.ts:30-43`）且是动态 import，运行时不会全下载 ⇒ 影响有限，但"体积可控"的表述与实际产物范围不符 | `ui/src/lib/highlight.ts:8-13` |
| D8 | `README.md:107-121` 的「常用脚本」表 | 未列 `npm run test:ci`（CI 实际依赖它）；`packages/web/scripts/smoke.mjs` 未在表里出现；`docs/deploy.md` 被 README 引用存在 ✓ | `README.md:107-121` |

D3 与 D6 最值得优先更新——它们会让协作者对系统行为做出错误假设。

---

## 6. 已排除的"非问题"与我修正过的误判

这一节和上面的清单同等重要：审查若不记录"什么已经确认没问题"，就会导致重复排查。

### 6.1 经复核确认**不是问题**的

| 项 | 结论 |
|---|---|
| **XSS** | `Markdown.tsx:122` 未启用 `rehype-raw`（全仓唯一 markdown 插件配置）；三处 `dangerouslySetInnerHTML` 全是 shiki 输出或自研 `escapeHtml` 兜底（`PreviewPane.tsx:207-208,264`、`Markdown.tsx:56`、`ToolWritePreview.tsx:53`）；HTML 文件预览用 `<iframe sandbox="">`（`PreviewPane.tsx:180-184`）禁脚本。**未找到可用落点。** |
| **Electron 壳安全** | `packages/desktop/src/main.ts:447-452` 是 `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`（未关 `webSecurity`）；`preload.ts:24-35` 只暴露 5 个窗口控制方法；`packages/desktop/src/main.ts:479-492` 只注册 4 个固定 IPC 通道；`:461-465` 无条件 `preventDefault` + `setWindowOpenHandler` 只放行 http/https 给系统浏览器；`:268-272` spawn 用 argv 数组无注入；`boot-env.ts:70-96` 丢弃宿主 `CORE_*` 并钉死 `CORE_HOST=127.0.0.1`、清空 `CORE_ALLOWED_HOSTS`、删除 `CORE_TOKEN`。**做得很好。** |
| **API_ROUTES 无漏网** | `server.ts:393` 的 `Set.has(urlPath)` 在所有 handler 之前；分派全用 `new URL().pathname`（已规范化：`/a/../health`→`/health`、`%68ealth`→`/health`、`?` 被剥离）；未声明路径 GET 只走静态。**逐个 POST/PUT 路由核对过，无漏登记。** |
| **静态目录穿越** | `server.ts:333-341` 已正确防护（normalize + startsWith 校验，越界 403）。 |
| **`/sessions/image` 的 `?token=` 豁免** | `server.ts:395-414` 的论证成立（`<img>` 无法带 Authorization 头），且严格限定单一路由、比对用严格相等。缺少 `Referrer-Policy` 是纵深问题，当前不可利用（`Markdown.tsx:87-91` 外链带 `rel="noreferrer"`）。 |
| **`skills-install` 的路径安全** | `SOURCE_PATTERN` 只收 `owner/repo`（`skills-install.ts:40`）；`sanitizeDirName`（`:97-100`）去除非 `[\w.-]` 字符与首尾点/横线；有符号链接拒绝、条目上限 5000、`.git` 过滤、staging 原子落盘。且 `check:skills-install` 有 **117 项断言**专门守这些，包括反事实对拍。 |
| **token 非常量时间比较** | `server.ts:415` 用 `!==`。但 token 是 `randomUUID()`（122 bit 熵）+ HTTP 抖动 ⇒ **实际不可利用**，仅作加固。 |

### 6.2 我推翻的初始判断（含子代理结论的对抗性验证）

| 初始结论 | 裁决 | 依据 |
|---|---|---|
| **P0-3（子代理）：`message_start` 用 `a-${messages.length}` 导致 id 复用** | **推翻** | 做了不变式推演：UI 中**唯一**缩短 `messages` 的路径是 `chat-store.ts:470` 的 `filter(m => m.id !== userMsg.id)`，删的是 **user** 消息（`u-` 前缀）；新 assistant id 与仍在数组中的 `a-N` 冲突当且仅当"最后一次创建后无追加且被删的正是那条新 assistant"，而 filter 永远删不到 `a-` 前缀。且 handled 分支与模型事件互斥（`session.ts:1020-1041` 命中即 return）。历史消息 id 是 `m-${entry.id}`（`sessions.ts:309/324/...`），不同域。 |
| **P1-2（子代理）：会话索引 debounce 闭包捕获导致写到错误目录** | **推翻** | 闭包捕获属实，但前提错误：`indexFilePath` = `<agentDir>/session-index.json`（`session-list-cache.ts:378-389`），而切 cwd 只改 `sessionDir` 末段、`agentDir` 恒定（`:376` 注释已明说，上游 `session-manager.js:290-302` 证实形如 `<agentDir>/sessions/--<编码 cwd>--`）。且索引 Map 本身是单一全局。⇒ 不产生错误落盘。 |
| **P0-1（子代理）：任意网站 `<script src>` 偷 token** | **利用链不成立** | 跨源 `<script>` 对 `Content-Type: text/html` 的响应**不会执行**（浏览器拒绝非 JS MIME 的脚本）。缺 `nosniff`/CSP 属实，但只作为纵深加固项（已记为 P1-7）。 |
| **P1-6（无 Origin 校验）：本机任意网页可发写请求** | **影响面下调至 P2/P3** | Host 白名单（`server.ts:386`）+ 全端点 Bearer（`:393-419`）已挡住：带 `Authorization` 会触发预检而 `OPTIONS` 先撞 401 且无 ACAO；简单请求则 token 为空 ⇒ 401。token 是 `randomUUID` 且只落 `run/core.json`，浏览器页面读不到。⇒ 是纵深缺口而非可利用漏洞。 |

**另外我修正了自己的一条判断**：shiki 全量语言 chunk 我最初倾向判为"打包事故"，读完 `highlight.ts:4-13,30-59` 后确认作者是**有意**用 `bundle/web` + 显式 `langs` 列表 + 动态 import，运行时只加载 12 种语言 ⇒ 降级为文档表述漂移（D7）。

---

## 7. 优先级路线图

按"风险 × 修复成本"排序。**第 1-3 项建议立刻做**（都是小改动、高风险收敛）。

> **2026-10 执行状态**：第 1 项（P0-1）✅ 已完成（`4c77a66`）、第 2 项（P0-2）✅ 已完成（`4c77a66`）、第 3 项（P0-4）❌ 已推翻（虚警，无需做）、第 4 项（P2-1 A6 平台 skip）未做。

### 第 1 批：立刻（每项 ≤ 半天）

1. **修 P0-1 的进程崩溃**（`server.ts` 加 try/catch + `main.ts` 加 `unhandledRejection` 兜底）—— 这是唯一**已实测可利用**的漏洞，且修复 5 行。
2. **禁止 `apiKey` 以 `!` 开头从 HTTP 入口传入**（P0-2）—— 两处入口各加一行校验，关掉一条未文档化的 RCE 路径。
3. **修 CI 的 web 门禁**（P0-4）—— 让流水线恢复可用；顺手把 `packages/web/scripts/smoke.mjs` 接进 CI（它本就是为那次真实事故写的防线）。
4. **修 A6 的平台 skip**（P2-1）—— 让 Windows 开发者本地 `test:ci` 变绿，恢复验收纪律的可信度。

### 第 2 批：本周（结构性但低风险）

5. **对齐 `pi-coding-agent` 版本**（P0-5）：重跑 `npm ci` 装 0.99.2、复跑全链、复核源码锚点注释；考虑收紧为精确版本。
6. **加 `.npmrc` 并在 CI 显式设 registry**（P1-15）；用官方源重生 4 份 lock。
7. **桌面打包裁剪 `core/node_modules`**（P0-6）：排除跨平台 `@esbuild/*` 与 `typescript`。
8. **CI 加 tag↔version 一致性守卫 + `concurrency`**（P1-16、P1-17）。
9. **补三件套安全头**（P1-7）：`nosniff` + CSP `script-src 'self'` + `Referrer-Policy: no-referrer`。
10. **文档漂移修正**（§5 的 D1/D2/D3/D4/D6/D7/D8）—— 尤其 D3、D6，它们会误导协作者。

### 第 3 批：本迭代（需要设计与回归）

11. **让 `startServer` 可导入**（§1.3）：把自动启动移到 `if (import.meta.main)` 之后，让检查脚本进程内起服务 —— 这把 core `test:ci` 从 76s 压到十几秒，并解开"必须 spawn"的结构性约束。
12. **上 Biome**（P1-14）：一次性格式化 + lint，配 `.git-blame-ignore-revs`；清掉 2 处失效的 `eslint-disable` 与 46 处空 catch 的显式豁免。
13. **引入真测试框架**（§1.2）：vitest（ui，含 jsdom）+ node:test（core），先把 `lib/` 的纯函数与 store 层覆盖起来。注意 `packages/ui/TESTING.md` 记录的三个技术障碍（`@/` 别名 226 处、无扩展名相对导入、构造函数参数属性）。
14. **契约镜像去手工化**（P1-2）：优先让 `provider-contract.ts` 直接 `import type` 引 core；退而扩脚本覆盖 `export type` 与字面量联合。
15. **换会话临界区互斥**（P1-10）与**会话切换请求代序**（P1-11）。
16. **拆分 `session.ts` / `server.ts`**（P1-3）—— 本次审查中大部分竞态缺陷都源自这两个文件的状态管理密度。

### 第 4 批：评估再定

17. **信任门默认值 `always` → `ask`**（P1-6）—— 属产品行为变更，需你裁决。
18. **`/fs/*` 收敛到 cwd + 越界开关**（D6）—— 文档已声明接受，但配合 P0-1/P0-2 修复后值得重新评估。
19. **CI 接入 CDP 验收**（§1.2）—— 需在 CI 装 Chrome 与 dev server，工程量大，但这是 UI 交互层唯一的自动化防线。

---

## 8. 审查产物与遗留文件

**我在工作区留下了 4 个未跟踪文件**（你要求不改代码，所以我没有删；四者都在 `git status` 里可见，均未提交）：

| 文件 | 说明 | 建议 |
|---|---|---|
| `docs/CODE_REVIEW_2026-10.md` | **本报告** | 交付物。注意它在 `docs/` 下**会被 git 跟踪**。 |
| `docs/security-review-phase3.md` | 安全分域审查的完整报告（39KB，含全部行号与代码片段）。由子代理生成，**内容已被我复核**（其中"任意网站偷 token"一条我判定利用链不成立）。 | 可留作参考，或删除（内容已并入本报告 §3.2）。 |
| `review-artifact-dos-probe.mjs` | P0-1 的复现脚本（起临时 core + 原始 socket 发 `/%`）。 | 用于复现与回归验证；P0-1 修完后可作为回归脚本保留，或删除。 |
| `review-artifact-citation-check.mjs` | 本报告的行号引用校验器：抽出全文所有 `path:line` 引用，核对文件存在与行号范围（实测 23/23 通过，并借此发现并修正了 3 处不完整路径）。 | **建议保留**——它把"报告里的行号是否可信"变成可复跑断言，与项目自身"验收可复跑"的纪律同构；后续 review 可直接复用。 |

**基线的副作用**：运行 `test:ci` 重新生成了 `packages/core/dist`、`packages/ui/dist`、`packages/web/ui/`（均已 gitignore）与各 `run/*-evidence.json`。`git status --porcelain` 除上述 **4 个**文件外为空。

**关于本次审查的一个方法说明**：安全域与工程化域由子代理分头深挖，但**所有 P0/高危结论我都亲自复核了代码行**，并另起一个子代理对缺陷清单做**对抗性验证**（其职责是尝试推翻）。结果是我自己的 1 条判断和子代理的 3 条结论被修正或推翻——§6.2 完整记录。这是本报告可信度的主要来源：清单里剩下的每一条，其行号与代码我都亲自读过。

**未覆盖区域**（诚实声明）：
- `packages/core/src/providers.ts` 除 600-624 / 637-663 / 778-807 段外的部分；`resources.ts`、`models.ts`、`skills.ts`、`skills-search.ts`、`fs-list.ts`、`fs-read.ts`、`prompt-files.ts` 未逐行读。
- UI 侧 `MessageList.tsx` 的 1-160 与 840-1267 段、`Composer.tsx` 其余段、`TurnRail.tsx`、`WorkingDirFileTree.tsx`、`lib/layout.ts`、`lib/turns.ts` **未逐行读**。
- 上游 `@earendil-works/pi-coding-agent` 的两处行为未验证：`DefaultPackageManager.installAndPersist/update`（由 `POST /packages/install` 的 `source` 驱动）是否会触发 `postinstall`——若是，则是**第三条未文档化的 RCE 路径**；Pi 自身对 `models.json` 中 `!apiKey` 的处理（本项目 `providers.ts:613` 已确认执行 shell，上游是否另有一处未知）。**建议单独审一轮。**
- `packages/core/docs/deploy.md`（9.9KB）未逐行审，因此自托管部署的运维要求（反代、TLS、token 轮换）没有结论。
- **未运行 electron-builder 实际打包**，P0-6 的体积结论基于配置 + 目录实测。
- **未实际触发 CI**，P0-4 是从代码前置检查 + tracked 文件状态推出的（逻辑链完整，但建议重跑一次 tag 验证）。

### **8.1 报告定稿后补做的核实（本轮）**

以下四条是首版报告的"未覆盖"项，本轮已亲自核实，结论并入上文：

| 项 | 核实结果 |
|---|---|
| **`deleteSession` 是否可删任意文件**（首版列为"上游未验证"的疑点之一） | **正式排除。** `packages/core/src/sessions.ts:529-531` → 上游 `SessionManager.findById`（`core/node_modules/.../session-manager.js:1421-1442`）：`join(dir, file)` 的 `file` 来自 `readdirSync(dir)` 且只接受 `.jsonl`，`id` 仅用于 `header?.id !== id` 相等比较，**从不进入路径构造**。故 `session.ts:1005` 的 `unlinkSync(file)` 无法越出 sessions 目录。源码注释（`packages/core/src/sessions.ts:528`）的自证**属实**。 |
| **`switchCwd` 路径是否会让 UI 永久停在 streaming** | **确认不会。** `session.ts:901` 先 `previousSession?.dispose()`、`:902` 才 `emitAgent({type:"cwd_changed"})`；UI `chat-store.ts:258-262` 收到后调 `startNewSession()`，而该方法在 `:780` 显式 `streaming: false`（并同批清 `awaitingModel`/`pendingSince`，符合 `:63,:71` 记录的清理纪律）。⇒ 该路径表现为"生成被硬切 + 消息区清空"，P1-10 的修正描述成立。 |
| **`newSession` 竞态窗口** | **确认。** 亲读 `session.ts:930-970`：`:932` 只检查一次 `session?.isStreaming`，随后 `:939 await resourceLoader.reload()` → `:940 await createAgentSession(...)` → `:966 previous?.dispose()`，窗口内无二次校验。 |
| **`prompt` 是否有流式/换会话二次校验** | **确认无。** `session.ts:1015-1018` 在 `await ready` 后取 `const s = session`（捕获当时引用），`:1043 await s.prompt(...)` 直接驱动它——窗口内若 `s` 已被 `:966`/`:901` dispose，则该轮生成静默消失（详见 P1-10）。这是 P1-10 的**另一半根因**：护栏在"入口检查一次"与"真正驱动会话"之间没有任何互斥或二次校验。 |

**注意**：§4 的 P2-7（消息 id 复用）经对抗性验证**已推翻**，此处不再作为待办；保留在 §6.2 以记录判断修正过程。
