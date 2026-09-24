# pi-desktop

一个基于 [Pi](https://github.com/earendil-works/pi) 包装的桌面版 Coding Agent 工作台。

> 定位：**给 Pi 套壳**——能力层（工具、扩展、MCP）归 Pi 的扩展生态，本项目只做**呈现层**：
> 把 Pi 的会话、工具执行、授权、信任门等能力以完整的桌面级 UI 呈现出来。

## 形态

本地 **core 服务**（Node 进程，HTTP + SSE）+ **浏览器访问**，默认绑 `127.0.0.1`；
Electron 仅作为可选外壳。UI 默认展示 mock 数据，带 `?live=1` 即走真实链路。

## 仓库结构（Monorepo）

```
packages/
├── ui/      前端（React 19 + TypeScript + Vite 6 + Tailwind v4 + Zustand）
│            8 屏六路由：对话工作台 / 运行详情 / 技能 / 外壳预览 / 设置 / 令牌
│            构建产物 dist/ 由 core 同源托管
└── core/    本地服务（Node + TypeScript，依赖 npm 包 @earendil-works/pi-coding-agent）
             HTTP+SSE 长连接、会话持久化（继续/重建最近会话）、
             工具授权闭环（授权卡 + 应答幂等）、项目信任门（跟随 Pi 语义）、
             工具开关热切换（GET/POST /tools/active）
```

安全设计：随机 Bearer token（同源访问时自动注入页面，无需手工拼）、`Host` 头白名单防 DNS rebinding、无 CORS（跨源 dev 模式才显式传 `?core=&token=`）。

## 快速开始

前置条件：Node 22+；一个 OpenAI-compatible 模型端点（如火山方舟 coding 端点）及 API Key。

```bash
# 1. 构建前端（产物 packages/ui/dist 会被 core 托管）
cd packages/ui
npm install
npm run build

# 2. 启动 core
cd ../core
npm install

# 提供模型配置与 Key（示例）
#   models.json 固定取 <agentDir>/models.json（缺省 ~/.pi/agent/models.json，首次运行自动创建空清单）
#   其中可用 "apiKey": "$ARK_API_KEY" 插值 ⇒ 变量要在**启动 core 的 shell** 里 export
export ARK_API_KEY=<你的 key>
export CORE_AGENT_DIR=<agent 目录>               # 可选，缺省用默认 agentdir（清单就在它下面）
export CORE_SHELL_PATH=<bash 路径>               # Windows 建议指向 PortableGit bash（有完整 coreutils）
export CORE_PORT=5190                            # 可选，缺省随机端口

npm run smoke
```

启动后按控制台提示打开 `http://127.0.0.1:<port>/?live=1`。健康检查在 `/health`；
token 落盘在 `packages/core/run/core.json`（已 gitignore，绝不提交）。

**自检**：侧边栏 live 态显示真实会话列表即成功；不带 `?live=1` 时是 8 条演示会话的 mock 形态。

## 常用脚本

| 位置 | 脚本 | 说明 |
|---|---|---|
| `packages/ui` | `npm run typecheck` | 类型检查（必须带 `-p`，裸 `tsc` 会假绿） |
| `packages/ui` | `npm run check:contract` | UI 契约镜像与 core `contract.ts` 齐平检查（字段级） |
| `packages/ui` | `npm run build` | 构建生产 dist |
| `packages/ui` | `npm run accept:m1`~`m5` | 里程碑验收（CDP 驱动，需系统 Chrome） |
| `packages/ui` | `npm run live:smoke` | 真实链路冒烟（12 项断言） |
| `packages/core` | `npm run smoke` | 启动服务（等价于 main.ts 直跑） |
| `packages/core` | `npm run security-check` / `smoke:check` | 安全三件套 / 真实会话冒烟 |
| `packages/core` | `npm run check:c3`~`c6` | 授权 / 会话 / 资源 / 全链路端到端验收（`check:c6` 为总验收） |

## 环境变量

| 变量 | 说明 |
|---|---|
| `ARK_API_KEY` | 模型 API Key（仅经环境变量注入，不落任何被提交文件） |
| `CORE_AGENT_DIR` | Pi agent 目录（models.json / settings.json / 扩展等，缺省 `~/.pi/agent`） |
| `CORE_SHELL_PATH` | shell 可执行文件路径（Windows 建议 PortableGit bash） |
| `CORE_PORT` | 监听端口（缺省随机） |
| `CORE_TOKEN` | 固定 token（缺省每次启动随机生成） |
| `CORE_UI_DIST` | UI dist 覆盖路径（缺省 `packages/ui/dist`） |
| `CORE_TRUST_TIMEOUT_MS` | 信任门 ask 态等待上限（缺省 120s，超时按不信任处理） |

## 设计文档

架构决策、里程碑规格书与验收记录（M0–M6）位于本仓库 `.plan/`（本地目录，不入库）。

## License

仅供学习与研究使用。
