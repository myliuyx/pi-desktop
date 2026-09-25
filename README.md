# Pi-Desktop

基于 [Pi](https://github.com/earendil-works/pi)（npm 包 `@earendil-works/pi-coding-agent`）的桌面级 Coding Agent 工作台。

> 定位：**给 Pi 套壳**——能力层（工具、扩展、模型接入）归 Pi 的生态，本项目只做**呈现层**：
> 把 Pi 的会话、工具执行、授权、信任门等能力以完整的桌面级 / Web UI 呈现出来。

## 三种使用形态

| 形态 | 适合场景 | 说明 |
|---|---|---|
| **桌面版** | 本机日常使用 | Electron 壳内嵌 core 服务，**免装 Node**，安装即用（Windows / macOS / Linux） |
| **自托管 web** | 内网 / 远程访问 | core 跑在服务器上，浏览器随处访问，见 [`packages/core/docs/deploy.md`](packages/core/docs/deploy.md) |
| **本地开发** | 改代码 | mock 演示与真实链路双形态，见下文「快速开始」 |

三种形态共用同一份前端构建产物（`packages/ui/dist`）：桌面版由 Electron 加载内嵌 core，自托管由 core 同源托管，mock 形态任意静态托管即可。

## 功能一览

- **会话**：侧栏真实会话清单、点开即切（切换活动会话后续写落进所看会话）、「新建会话」页——**真实发生对话才创建 session**、继续最近会话
- **对话**：SSE 流式输出、工具授权卡（含可填参的 input 型）、项目信任门（跟随 Pi 语义）、Token 用量统计
- **模型管理**：设置页多 Provider 增删改、「导入模型…」拉真实清单勾选、思考档位切换、**无可用模型也能启动**（首启在设置页配置即可）
- **工作目录**：侧栏目录菜单、**运行期热切换**（不重启换项目）
- **安全**：随机 Bearer token（同源访问自动注入页面）、`Host` 头白名单防 DNS rebinding、API 全端点鉴权

## 仓库结构

```
packages/
├── ui/        前端（React 19 + TypeScript + Vite + Tailwind v4 + Zustand）
│              8 屏六路由：对话工作台 / 运行详情 / 技能 / 外壳预览 / 设置 / 令牌
├── core/      本地服务（Node + TypeScript，HTTP + SSE）
│              同源托管 ui/dist；会话持久化 / 工具授权闭环 / 信任门 / 模型清单读写
└── desktop/   桌面壳（Electron + electron-builder）
               ELECTRON_RUN_AS_NODE 子进程跑 core（用户机器免装 Node），
               读 <userData>/run/core.json 自动拿端口与 token
.github/workflows/build.yml   三平台构建流水线（tag `v*` 或手动触发）
```

## 快速开始

前置：Node 22+；一个 OpenAI-compatible 模型端点及 API Key（在设置页配置，或写进 `models.json`）。

### 桌面版

从 Releases（或 Actions 运行页的 artifact）下载对应平台安装包：

- **Windows**：NSIS 安装包；未签名，SmartScreen 提示时选「更多信息 → 仍要运行」
- **macOS**：未签名 dmg，首次打开需右键 →「打开」绕过 Gatekeeper
- **Linux**：AppImage / deb

想自己构建见下文「桌面打包」。

### 本地开发

```bash
# 1) 前端（mock 演示形态：浏览器开 http://127.0.0.1:5173）
cd packages/ui
npm install
npm run dev

# 2) 真实链路：core 同源托管构建产物
cd packages/ui && npm run build
cd ../core && npm install
CORE_PORT=5190 npm run smoke        # PowerShell 用 $env:CORE_PORT="5190"
# 浏览器开 http://127.0.0.1:5190/?live=1 （token 由 core 注入页面，免拼）
```

> ⚠️ dev server（5173）背后没有 core：`?live=1` 只对 core 同源地址（如 5190）有意义。
> 跨源调试可用 `http://127.0.0.1:5173/?live=1&core=http://127.0.0.1:5190&token=<token>`。

模型配置：`models.json` 固定取 `<agentDir>/models.json`（缺省 `~/.pi/agent/models.json`，
首次运行自动创建空清单，随后在设置页「模型」添加 Provider 即可）。
清单里可用 `"apiKey": "$ARK_API_KEY"` 插值 ⇒ 变量要在**启动 core 的 shell** 里 export。

### 自托管 web

完整指南（TLS 反代 Caddy/nginx 样例、SSE 直通、token 管理、安全边界）：
[`packages/core/docs/deploy.md`](packages/core/docs/deploy.md)。一句话版：

```bash
CORE_PORT=8787 CORE_HOST=0.0.0.0 CORE_ALLOWED_HOSTS=<访问用主机名> npm run smoke
```

## 桌面打包

```bash
cd packages/ui     && npm ci && npm run build   # 前端产物
cd ../core         && npm ci && npm run build   # core 产物（dist/）
cd ../desktop      && npm ci && npm run dist    # 产物在 release/
```

- 本机只能打当前平台的包（Windows 出 NSIS，mac 出 dmg，Linux 出 AppImage/deb）；三平台全出用 CI：推 `v*` tag 或在 Actions 页手动触发 `build` workflow。
- 国内网络需要镜像（electron 二进制 postinstall 失败是**静默**的）：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- 无窗口冒烟：`cd packages/desktop && npm run smoke`（起 core → 探活 → 整树杀，验证进程零残留）。

## 常用脚本

| 位置 | 脚本 | 说明 |
|---|---|---|
| `packages/ui` | `npm run dev` / `npm run build` | dev server（5173）/ 生产构建 |
| `packages/ui` | `npm run typecheck` | 类型检查 |
| `packages/ui` | `npm run accept:m1`~`m5` | 里程碑验收（CDP 驱动；先 `npm run dev -- --port 5180 --strictPort` 起对口） |
| `packages/ui` | `npm run probe:c4` `probe:auth` `probe:settings` 等 | 功能探针（mock）；`*:live` 系列起真实 core 验证 |
| `packages/ui` | `npm run live:smoke` | 真实链路冒烟 |
| `packages/core` | `npm run smoke` / `npm run build` | 起服务（tsx + 源码）/ 编译产物（`dist/`） |
| `packages/core` | `npm run check:c3`~`c6` | 授权 / 会话 / 资源 / 端到端验收 |
| `packages/core` | `npm run check:sessions-new` `check:sessions-load` | 惰性建会话 / 「点开即切」验收 |
| `packages/core` | `npm run check:run-dir` | `CORE_RUN_DIR` 覆盖口验收 |
| `packages/core` | `npm run security-check` / `smoke:check` | 安全三件套 / 真实会话冒烟 |
| `packages/desktop` | `npm run dev` / `smoke` / `dist` | 开发窗口 / 无窗口冒烟 / 打安装包 |

> 验收脚本可用 `CORE_ENTRY=<路径>/dist/main.js` 指向编译产物，验「产物可用」而非源码；
> 会起 core 的脚本请**串行**执行（共用端口与 run/ 目录）。

## 环境变量（core）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `CORE_PORT` | 随机 | 监听端口 |
| `CORE_HOST` | `127.0.0.1` | 绑定地址；`0.0.0.0` 对内网开放 |
| `CORE_ALLOWED_HOSTS` | 仅本机 | `Host` 白名单（逗号分隔，不含端口）；内网/反代访问必须加 |
| `CORE_TOKEN` | 随机 UUID | 固定 token；随机时写入 `core.json` |
| `CORE_AGENT_DIR` | `~/.pi/agent` | agent 目录（models.json / settings.json / 会话文件） |
| `CORE_CWD` | `process.cwd()` | 工作目录（决定 agent 可读写范围与信任门）；运行期可在界面热切换 |
| `CORE_UI_DIST` | `packages/ui/dist` | 同源托管的前端产物路径 |
| `CORE_RUN_DIR` | `packages/core/run` | 运行时文件目录（`core.json` / `events.jsonl`）；打包桌面端必设 |
| `CORE_SHELL_PATH` | 系统默认 | shell 路径（Windows 建议 PortableGit bash） |
| `CORE_TRUST_TIMEOUT_MS` | `120000` | 信任门 ask 态等待上限 |

桌面壳由 Electron 自动注入 `CORE_RUN_DIR`（userData）等，无需手工配置。

## 设计文档

架构决策、里程碑规格书与验收记录位于 `.plan/`（本地目录，不入库）；自托管部署见
[`packages/core/docs/deploy.md`](packages/core/docs/deploy.md)。

## License

仅供学习与研究使用。
