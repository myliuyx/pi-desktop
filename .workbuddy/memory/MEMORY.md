# 项目长期记忆 · Tiktok_auto（桌面 Agent 设计系统）

> 只放**跨会话长期有价值**的事实与惯例，且**只放 `.plan/` 文档里没有的**。
> 阶段状态与结论的单一权威来源是 **`.plan/README.md`**（唯一入口，先读它，勿通读 `.plan/`）。
> 逐日细节见 `YYYY-MM-DD.md`；里程碑结论见 `.plan/archive/progress-M*.md`。

## 定位与阶段

- Ardot 画布 fileId `728255468414716`（设计稿是令牌唯一权威来源）。
- M0–M5 纯 UI 原型已定稿验收（2026-09-22），净工时 69.5h（14h 缓冲未动用）。8 屏六路由。
- **当前：Pi 对接阶段**。React 19 + TS + Vite 6 + Tailwind v4 + Zustand + lucide-react + shiki
  + react-markdown + remark-gfm + react-virtual（8 依赖冻结，勿新增）。
- **部署形态已裁决（2026-09-23）**：本地起服务 + 浏览器访问，默认绑 `127.0.0.1`；
  Electron 降级为可选外壳。连带：**本地 token 不能删**（任意网页可请求 127.0.0.1）、
  **需校验 `Host` 头防 DNS rebinding**（S4 初稿漏的一条）。
- **与 Pi 的分工**：给 Pi 套壳——能力层归 Pi 扩展生态（我们不写），呈现层归我们。
  工具 8 内置、默认启 4 个（read/bash/edit/write），04 屏 `TOOL_ENTRIES` 已对齐不用改。

## 硬约束（不可破）

G1 hex 只在 `tokens.css` ｜ G2 禁 `dark:` 变体 ｜ G3 正文≥4.5、辅助≥3 ｜
G4 图标恒 `#8A919E`（算对比度排除 svg/aria-hidden）｜ G5 不用 Tailwind 内置调色板 ｜
G6 无横向滚动 ｜ G7 键盘可达 ｜ G8 折叠必须有过渡。
颜色唯一来源 `tokens.css`；尺寸/时长唯一来源 `lib/layout.ts`（`style={{}}` 禁裸尺寸，≤1px 发丝线除外）。

## 命令口径

- **typecheck 必须带 `-p`**：`tsc --noEmit -p tsconfig.app.json`（裸 tsc 因 `files:[]` 恒假绿 EXIT=0）。
- 验收 `accept:m1..m5`；**跑 m2 必须显式 `M2_ORIGIN=http://127.0.0.1:5180`**；
  CDP 端口 m1=9333 / m2=9337 / m3=9341 / m4=9342 / m5=9343。
- `check:cn` / `check:adapter`——**期望值从 fixture 现读**，写死数字必误报。
- 跑脚本：`cd packages/ui && node.exe --experimental-strip-types scripts/xxx.mjs`。
- **MCP 门控**：默认不渲染，`isMcpEnabled()` 读 `?mcp=1`；accept:m2/m4 脚本已自带该参数；
  恢复只改该返回值。

## 流程铁律

主控写规格书 → 执行方实现（progress 只标「待主控复核」）→ **验收脚本必须非实现方写** →
主控独立复跑全部命令、**不采信执行方回报**。

## 教训与脚本规则 → [`​.plan/engineering-pitfalls.md`](../../.plan/engineering-pitfalls.md)（9 条教训 + 7 条脚本规则）

最常用：① `EXIT=0` ≠ 检查发生过（裸 tsc 假绿）、断言全绿 ≠ 验收完成；
② **内部类型形状 ≠ 事件形状**（spike 实踩：拿 `BashResult` 推事件字段两处全错）；
③ UI 断言取样限定屏级容器；④ cdp.eval 正则反斜杠双写、数字开头键加引号；
⑤ 同文件多次 Edit 必须串行、长命令必须后台跑。

## Pi 梳理（状态见 `.plan/README.md` 速览，此处只记未入档事实）

- S0–S4 完成，S5 降级为产品决策，剩 S6；core 骨架 spike 已通过。
  **两条裁决项已拍板（2026-09-23，见 `.plan/decision-rulings-2026-09-23.md`）**：
  A 信任门 = **A3 跟随 Pi**（实证：信任门是 `reload({resolveProjectTrust})` 显式两段式，SDK 默认绕过，
  core 须显式传回调）；B 拒绝后重试 = **暂不做**（Pi 有公开 `abort()`，后期扩展零障碍），
  拒绝理由明示随 core 顺手带上。
- **术语警告**：链路里两个同名无关的 `baseUrl`——①UI↔core（我们定义）②core↔模型（Pi 持有）。
  UI 从不直接请求模型。
- 火山方舟 `https://ark.cn-beijing.volces.com/api/coding/v3` 是 **openai-completions** 端点；
  `models.json` 用 `"apiKey": "$ARK_API_KEY"` 插值；SDK：`ModelRuntime.create({modelsPath})` →
  `setRuntimeApiKey()` → `getModel()`（`pi-ai` 顶层 getModel 已 deprecated）。
- **本机 bash 已解决（2026-09-23 spike-tools）**：`<agentDir>/settings.json` 配 `"shellPath"` 指向
  PortableGit bash（`~/.workbuddy/binaries/PortableGit/versions/1.2.0/bin/bash.exe`，有完整 coreutils）
  实测生效；**事件里没有 `exitCode`/`truncated`/`details`**（成功 `result` 只有 `content`）⇒
  TerminalBlock 按 `isError` 表达成败。dump：`pi/_poc/spike-core/result-tools.jsonl`。
- POC/spike 资产在 `pi/_poc/`（密钥 `pi/_poc/.env.local`；`pi/` 整体 gitignore，
  还原 `git clone https://github.com/earendil-works/pi pi`）。仍未验：换 npm 发布包后重跑探针。

## 版本管理

git init、首提交 `175a208`（126 文件 / 29609 行）、**无远端**；`.gitignore` 含 `pi/`；
git 身份是占位 `myliu@localhost`（local 级），推远端前需改真实身份。
**M6 开发在 `dev-m6` 分支**（master 停在梳理期收尾）；提交消息走临时文件 + `git commit -F`
（bash shim 无 `cat`，heredoc 会静默失败）；**每次 shell 调用必须显式 cd**（cwd 不延续）。

## M6 进度（2026-09-23）

- **C0–C2 完成并通过主控复核**（规格书 `.plan/task-M6-C0-C2.md`）：
  `packages/core`（依赖 npm 发布包 `@earendil-works/pi-coding-agent@0.87.1`，本地 pi/ 不再是依赖）
  = HTTP+SSE + 安全三件套（Bearer 401 / Host 白名单 403 / 无 CORS）+ 持有 Pi 会话 + SSE 批处理（~0.78）；
  契约在 `packages/core/src/contract.ts`（UI 相对路径 `import type`）；
  UI 侧 `?live=1&core=<url>&token=<bearer>` 走真实链路，默认仍 mock（同 MCP 门控范式）。
- 复核证据（主控独立复跑）：live-smoke 12/12、accept:m1~m5 全绿（32/15/16/21）、
  check:cn 20/20、adapter 32/32、两包 tsc EXIT=0、build 10.6s 且 dist 零真实 pi/core 引用。
- **C3–C5 完成并通过复核（同日）**：C3 授权闭环 + 信任门 A3（`check:c3` 36/36：真实往返 / 幂等 /
  信任门 never·always·ask+拒绝·信任·超时·cancel 五态；UI 超时失效态探针 4/4）；C4 会话
  （`check:c4` 25/25，`SessionEntry[]→Message[]` 独立映射、主干取 `getBranch()`）；C5 04/05 屏真数据
  （`check:c5` 26/26；UI 探针 7/7 + 8/8）；期间修掉 C2 遗留的 `core-smoke` 红灯。
- **命令口径（M6 新增）**：core `npm run check:c3|c4|c5|c6`、`security-check`、`smoke:check`；
  ui `npm run probe:c4|c5`、`live:smoke`。**check:c6 是 M6 总验收**（全链路端到端 + UI 探针引用，
  33/33；前置：packages/ui 先 build 出 dist）。**shim 无 `head`/`tail`，别用管道**。
- **★ 一页式体验（core 同源托管）**：core 默认 serve `packages/ui/dist`（`CORE_UI_DIST` 可覆盖）
  且静态资源免鉴权 ⇒ **一条 URL 看全部**：
  `cd packages/core` → `export CORE_PORT=5190 CORE_AGENT_DIR=<测试夹具 agentdir-ext>
  CORE_MODELS_PATH=<pi/_poc/models.json> CORE_SHELL_PATH=<PortableGit bash>` →
  `node --env-file=../../pi/_poc/.env.local node_modules/tsx/dist/cli.mjs src/main.ts` →
  浏览器开 `http://127.0.0.1:5190/?live=1`。
  **免 token（2026-09-23 起）**：core 会向 index.html 注入 `window.__CORE_TOKEN__`
  （`server.ts`，HTML 按扩展名判定注入；`getLiveConfig()` 优先 `?token=` 其次注入值）
  ⇒ 地址不再需要手工拼 token；跨源 dev（vite→core）仍用 `?core=&token=`。
  带 `agentdir-ext` 夹具可演示授权卡；`/health` 会回 `extensions` 与 `trust` 状态。
  ⚠️ **tsx 不热载**——改 core 源码后必须重启 core 才生效（实踩）。
- **★ M6 已完成（C0–C6，2026-09-23；C6 待主控复核）**：`continue-recent` 已**重建**活动会话
  （公开路径 `createAgentSession({sessionManager: SessionManager.open(file)})`，续写落同一文件）；
  04 屏工具开关 live 读写 `GET/POST /tools/active`（`getActiveToolNames`/`setActiveToolsByName`，
  写入下一 agent 轮次生效）；分支/fork UI 确认记后期。验收记录 `.plan/progress-M6.md`。
- **日常使用（最终形态）**：`cd packages/core && npm run smoke` → 浏览器
  `http://127.0.0.1:<core端口>/?live=1`（core 同源托管 ui/dist、免 token；ui dist 需先 build）。
  自检：侧边栏 live 显示真实 sessions、mock 形态是 8 条演示会话。

## Windows 踩坑

bash shim 缺 `rm`/`ls`/`npm` 等 → **node 侧做文件操作**；npm 走 `npm.cmd`（`npm.ps1` 被执行策略拦）；
PowerShell stdout 常不回传 → node 写文件再 Read；长命令 `run_in_background`；
CDP 用系统 Chrome（**不装 puppeteer/playwright**）；「构建卡住」先清 vite dev server 与陈旧 `tsbuildinfo`。
中文脚本勿用多行 `node -e`（shell 转义会崩），写独立脚本文件跑。

## 遗留（均非阻断）

06 屏缩略窗（scale 0.42）文字不可读（单壳 `#/shells?os=` 替代）；主包 520 kB（可对 03~06 屏 React.lazy）；
DEV 下 `window.__chatStore` 桩接 Pi 后要改回真实 UI 驱动（范式：同 MCP 门控）。
