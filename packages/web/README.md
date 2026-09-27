# @myliuyx/pi-web

[Pi-Desktop](https://github.com/myliuyx/pi-desktop) 的**自托管 web 形态**：一条命令把 Coding Agent 工作台跑起来，浏览器随处访问（内网 / 服务器 / 本机皆可）。

## 快速开始

前置：Node 22+；一个 OpenAI-compatible 模型端点及 API Key（首启后进设置页配置，或写进 `~/.pi/agent/models.json`）。

```bash
npx @myliuyx/pi-web            # 免安装直跑
# 或
npm i -g @myliuyx/pi-web && pi-web
```

启动后按提示打开 `http://127.0.0.1:<端口>`（token 自动写入运行时目录的 `core.json` 并注入页面，免拼）。

## 常用环境变量

| 变量 | 缺省 | 说明 |
|---|---|---|
| `CORE_PORT` | 随机 | 监听端口 |
| `CORE_HOST` | `127.0.0.1` | 绑定地址；`0.0.0.0` 对内网开放 |
| `CORE_ALLOWED_HOSTS` | 仅本机 | `Host` 白名单（逗号分隔，不含端口）；内网/反代访问必须加 |
| `CORE_RUN_DIR` | `~/.pi-web` | 运行时文件目录（`core.json` / `events.jsonl`） |
| `CORE_CWD` | 当前目录 | agent 工作目录（决定可读写范围与信任门）；界面里可热切换 |

完整变量表、TLS 反代（Caddy/nginx）与 SSE 直通配置见[仓库部署指南](https://github.com/myliuyx/pi-desktop/blob/main/packages/core/docs/deploy.md)。

## 安全

随机 Bearer token、`Host` 头白名单防 DNS rebinding、全端点鉴权。定位是**内网 / 个人自托管**，不是多租户服务；对公网暴露请务必走 TLS 反代并收紧白名单。

## License

MIT © myliuyx。上游 [Pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）同为 MIT。
