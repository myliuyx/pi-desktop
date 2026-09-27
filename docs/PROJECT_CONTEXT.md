# Pi-Desktop 项目上下文

> 给新协作者（人类或 AI 代理）的全景图：项目是什么、为什么这么设计、现在做到哪了、怎么干活。
> 结构与 API 以代码为准，本文记录 **why 与现状**。最后更新：2026-09-27。

## 1. 定位与边界

**Pi-Desktop** 是基于 [Pi](https://github.com/earendil-works/pi)（npm 包 `@earendil-works/pi-coding-agent`）的桌面级 Coding Agent 工作台。

一句话定位：**给 Pi 套壳**。能力层（工具实现、扩展机制、模型接入）归 Pi 的生态，本项目只做**呈现层**——把 Pi 的会话、工具执行、授权闭环、信任门等能力，以完整的桌面级 / Web UI 呈现出来。

因此本项目**不做**的事情：自己实现 agent 循环、自己定义工具协议、自己管模型 API 调用。这些全部委托给 Pi；core 的职责是「适配 + 暴露 HTTP/SSE」，UI 的职责是「呈现 + 交互闭环」。

## 2. 三种使用形态

三种形态共用同一份前端构建产物（`packages/ui/dist`）：

| 形态 | 场景 | 说明 |
|---|---|---|
| **桌面版** | 本机日常使用 | Electron 壳内嵌 core 服务，`ELECTRON_RUN_AS_NODE` 子进程跑 core（用户机器免装 Node），读 `<userData>/run/core.json` 自动拿端口与 token |
| **自托管 web** | 内网 / 远程访问 | **npm 包 `@myliuyx/pi-web`**（`npx` 即跑，bin 兜 CORE_UI_DIST=包内 ui/ 与 CORE_RUN_DIR=~/.pi-web 默认值）；或源码跑 core 同源托管 ui/dist；部署指南 `packages/core/docs/deploy.md` |
| **本地开发** | 改代码 | mock 演示与真实链路双形态（见 §5），README「快速开始」 |

## 3. 仓库结构

```
packages/
├── ui/        前端（React 19 + TypeScript + Vite + Tailwind v4 + Zustand）
├── core/      本地服务（Node 22+ + TypeScript，HTTP + SSE）
├── desktop/   桌面壳（Electron + electron-builder）
└── web/       npm 发布包 @myliuyx/pi-web（自托管 web 的 CLI 分发：bin + 组装脚本；
               tarball 内容 = core/dist + ui/dist，发布前由 scripts/assemble.mjs 拷入，
               scripts/smoke.mjs 做隔离冒烟；CI 在 build.yml 的 publish job 发包）
docs/          项目文档（本文 + pi-agent-core 调研）
.github/workflows/build.yml   三平台构建 + Release + npm 发布流水线（tag v* 或手动触发）
```

两个特殊目录：

- **`pi/`** — 上游 earendil-works/pi 的本地 clone（无本地改动），**gitignore 不入库**；仅本地调研参考，需要时 `git clone https://github.com/earendil-works/pi pi` 还原。上游本身 MIT 协议。
- **`.plan/`** — 本地规格书 / 里程碑验收记录（架构决策、任务 spec），gitignore 不入库。

各包源码速览：

- `core/src/`：`main.ts` 入口 → `server.ts` HTTP 路由 → `contract.ts` 契约类型 → `adapt.ts` Pi 事件适配 → `session(s).ts` 会话、`tools.ts` 工具、`trust.ts` 信任门、`models.ts`/`providers.ts`/`resources.ts` 模型与资源、`fs-list.ts`/`fs-read.ts` 文件浏览、`guards.ts` 安全。
- `ui/src/`：`adapter/`（live 形态适配器）与 `mock/`（演示形态数据源）双实现 → `store/`（chat / models / notice / ui 四个 Zustand store）→ `components/`（chat / shell / screens / common / primitives）→ `screens/`（工作台之外的屏）→ `lib/`（纯函数：layout、format、turns 等）。

## 4. 架构：一条消息的旅程

```
UI(React) --POST /prompt--> core --> @earendil-works/pi-coding-agent（agent 循环 + 工具执行）
    ^                                        |
    |            事件流（assistant 文本 / thinking / tool_call / 用量 / settled）
    +--------GET /events (SSE)--<------------+
```

1. 用户在工作台发消息 → `POST /prompt`。
2. core 驱动 Pi 跑 agent 循环；需要授权的工具先产出 approval 事件，UI 弹**授权卡**（含可填参 input 型），`POST /approve` / `POST /cancel-approval` 闭环。
3. 所有事件经 `GET /events`（SSE）推给 UI；`adapter/` 把事件写进 chat-store，渲染层只认 store。
4. 会话由 Pi 落盘持久化，core 用 `/sessions*` 端点列举 / 装载 / 新建；**真实发生对话才创建 session**。
5. 模型配置固定取 `<agentDir>/models.json`（缺省 `~/.pi/agent/models.json`），`apiKey` 支持 `"$ENV_VAR"` 插值；设置页可增删 Provider、拉真实模型清单勾选。

**契约镜像**：core 的 `contract.ts` 与 ui 的类型是镜像关系，`npm run check:contract`（contract-mirror-check）守护两端不漂移。

**mock / live 双形态**：`mock/` 是**默认形态数据源**——无 core 也能全功能演示（打字机流式、授权卡、用量统计俱全），`?live=1` 切真实链路。纪律：**mock/live 共用同一套渲染逻辑，零特判**；涉及数据的 store 字段（如 `settledTurnKeys`）仅 live 写入、mock 恒空，让演示面自然等于「没有该能力」而不是另写一套。

## 5. core HTTP API 面

全部端点要求 Bearer token 鉴权（`guards.ts`）。速查（详见 `core/src/server.ts`）：

| 组 | 端点 |
|---|---|
| 基础 | `GET /health`、`GET /events`（SSE） |
| 对话 | `POST /prompt`、`POST /abort` |
| 授权 | `POST /approve`、`POST /cancel-approval` |
| 会话 | `GET /sessions`、`POST /sessions/load`、`POST /sessions/continue-recent`、`POST /sessions/new` |
| 工作目录 | `POST /cwd`（运行期热切换）、`GET /fs/list`、`GET /fs/read` |
| 模型 | `GET /models`、`POST /models/select`、`GET /models/catalog`、`POST /models/test`、`GET /providers`、`PUT /providers`、`POST /providers/models` |
| 其它 | `POST /thinking`、`GET /tools/active`、`POST /tools/active`、`GET /resources` |

安全三件套：随机 Bearer token（写入 `run/core.json`，同源访问自动注入页面）、`Host` 头白名单防 DNS rebinding、全端点鉴权。信任门跟随 Pi 语义（`CORE_CWD` 决定信任范围，ask 态等待上限 `CORE_TRUST_TIMEOUT_MS`）。

## 6. 前端结构与路由

- **路由**：hash 路由，无 router 依赖（刻意，见 `App.tsx` 注释）。屏：`#/` 工作台（默认）、`#/run-detail`、`#/skills`、`#/tokens`（体检页）、`#/shells`；**设置是全局弹窗**（任意屏可弹出），另有「新建会话」页。
- **store**：`chat-store`（消息流 / 会话 / 授权 / settledTurnKeys）、`models-store`、`notice-store`（全局失败反馈）、`ui-store`（主题 / 弹窗等 UI 态）。
- **主题**：`data-theme` 机制换肤；颜色一律用语义令牌（CSS 变量 rgb()），**禁写 #hex**。
- **探针契约**：验收脚本依赖稳定 testid（`data-total-count`、`message-item`、`process-details`、`message-speed` 等），改组件时不得破坏。

## 7. 工程纪律（为什么这么干）

1. **验收可复跑**：一切行为验收都落在脚本里（CDP 驱动），不靠手动点；起 core 的脚本**串行**执行（共用端口与 run/ 目录）。
2. **诚实纪律**：不造数据。无真实来源的字段就不显示（如历史会话无耗时 → 不显示速度徽章）；mock 里也是「能力缺席」而非假数据。
3. **纯函数下沉**：可测逻辑（turns 分轮、speedTone 分档、formatMessageTime）收进 `lib/`，配独立 check 脚本（`check:turns` 等）。
4. **同类豁免纪律**：给 live 加新 store 字段时，mock 恒定缺省值，渲染层零特判（先例：`TerminalBlock.collapsed`、`settledTurnKeys`）。
5. **提交前拉远端**：stash → `pull --rebase` → pop，交叉文件复跑检查；dev 为工作分支，main 为稳定线，**快进合入**（`git merge --ff-only dev`）后推送。
6. **改动核对口径**：`typecheck` → 各 check 脚本 → `accept:m1`~`m5` → `probe:*`（截图过）。已知基线：`accept:m2` 31/32，G5 为 PreviewPane 有意白底、非回归（截至 2026-09-27）。

## 8. 现状快照（2026-09-27）

- `main = dev` 同步推进；`v0.1.1` tag → GitHub Release 挂 5 个平台安装包（CI build.yml：构建 + 自动发 Release + npm 发布三段）。
- npm 包 `@myliuyx/pi-web@0.1.1`：自托管 web 形态 CLI 分发，`npx` 即跑；CI 发包需仓库 secret `NPM_TOKEN`（未配置时该 job 警告跳过，不影响构建与 Release）。
- 已收官批次：对话工作台与里程碑 m1~m5、会话列举/装载/新建、授权闭环、信任门、模型管理（多 Provider + 导入清单 + 思考档位）、工作目录热切换、目录树侧栏、新建会话页、消息时间戳、模型标签 + token 速度徽章、回复完结后「处理详情」折叠行、桌面打包发版闭环（Release 自动挂包 + Linux 打包修复）、npm 自托管包。
- 待办远期项：目录树批次验收脚本补写（见 `.plan` 遗留清单）；mac x64（Intel）安装包矩阵。

## 9. 开发工作流速查

| 端口 | 用途 |
|---|---|
| 5173 | `packages/ui` dev server（mock 演示） |
| 5180 | mock 验收正门（accept 脚本先起 `npm run dev -- --port 5180 --strictPort`） |
| 5190 | live 验收正门（`CORE_PORT=5190 npm run smoke`，开 `http://127.0.0.1:5190/?live=1`） |
| 8787 | 自托管示例端口 |

常用命令、环境变量表（`CORE_PORT` / `CORE_CWD` / `CORE_RUN_DIR` 等）、桌面打包与镜像配置见 README「常用脚本」「环境变量」「桌面打包」三节。

⚠️ 两个易踩坑：改 **core** 代码后要重启 core 进程（tsx 直跑非编译）；改 **UI** 后 live 形态要重建 dist 才生效。探针脚本自起的 core 会覆写 `packages/core/run/core.json`，可能顶掉手工 core 的 token。

## 10. 许可证

本项目以 [MIT](../LICENSE) 协议开源。上游 [Pi](https://github.com/earendil-works/pi) 同为 MIT（© Mario Zechner），本项目通过 npm 依赖 `@earendil-works/pi-coding-agent` 使用其能力，特此致谢。
