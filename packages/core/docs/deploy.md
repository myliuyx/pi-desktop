# core 自托管部署指南

本指南描述如何把 `packages/core`（Node HTTP/SSE 服务，同源托管 `packages/ui` 构建产物）部署到一台服务器或自己的电脑上，供内网/远程访问。通读全文约 10 分钟；**第 4 节的安全边界务必阅读**。

---

## 1. 前置与启动

### 1.1 前置条件

- Node.js >= 22.19（core 的 `engines` 要求）。
- 依赖已安装：`cd packages/core && npm ci`。
- 前端已构建：`cd packages/ui && npm run build`（产物在 `packages/ui/dist`，core 默认同源托管它；不构建也能启动，但浏览器界面不可用）。

### 1.2 启动

最简启动（缺省配置）：

```bash
cd packages/core
npm run smoke
```

等价命令：`node node_modules/tsx/dist/cli.mjs src/main.ts`。

生产形态（推荐长驻部署）：先 `npm run build`（产物在 `dist/`，不依赖 tsx），再 `node dist/main.js`，行为与源码形态一致。

缺省行为：只绑定 `127.0.0.1`、随机端口（`CORE_PORT=0`）、随机 token；端口和 token 会写入 `packages/core/run/core.json`。

### 1.3 环境变量

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `CORE_PORT` | `0`（随机口） | 固定端口便于反代，如 `8787` |
| `CORE_HOST` | `127.0.0.1` | 绑定地址；设 `0.0.0.0` 对内网开放 |
| `CORE_ALLOWED_HOSTS` | （空，仅允许 `127.0.0.1`/`localhost`） | 逗号分隔的主机名白名单（**不含端口**）。`Host` 头不在白名单内的请求一律 403 拒绝 |
| `CORE_TOKEN` | 随机 UUID | 固定 token（利弊见第 3 节）；随机时写入 `run/core.json` |
| `CORE_AGENT_DIR` | `~/.pi/agent` | agent 目录，`models.json` 位于其下 |
| `CORE_CWD` | `process.cwd()` | core 工作目录，决定 agent 可读写的文件范围与信任门 |
| `CORE_UI_DIST` | `../../ui/dist`（相对 core 包） | 同源托管的前端 dist 路径 |
| `CORE_RUN_DIR` | `packages/core/run` | 运行时文件目录（`core.json`、`events.jsonl` 等） |

### 1.4 对内网开放（可复制执行）

Git Bash / Linux / macOS：

```bash
cd packages/core
CORE_PORT=8787 CORE_HOST=0.0.0.0 CORE_ALLOWED_HOSTS=192.168.3.37 npm run smoke
```

PowerShell：

```powershell
cd packages/core
$env:CORE_PORT="8787"; $env:CORE_HOST="0.0.0.0"; $env:CORE_ALLOWED_HOSTS="192.168.3.37"
npm run smoke
```

- `CORE_ALLOWED_HOSTS` 填**客户端访问时用的主机名/IP**（不含端口），多个用逗号：`CORE_ALLOWED_HOSTS=192.168.3.37,chat.example.com`。默认白名单只有 `127.0.0.1` 和 `localhost`，内网 IP 访问会被 403 拒绝。
- 启动成功后控制台会打印监听地址，例如：`[core] 监听 http://0.0.0.0:8787 (SSE: /events, 健康: /health)`。
- 浏览器直接开 `http://HOST:PORT/?live=1` 即可使用界面，**免 token**——core 会把 `window.__CORE_TOKEN__` 注入到托管的 index.html 里。
- **所有 API 端点（含 `GET /health`）都需要 `Authorization: Bearer <token>`**；探活示例见 3.1 节的 curl。只有静态页面本身是公开的。

---

## 2. TLS 反向代理

**必须 HTTPS**（原因见第 4 节）。推荐做法：core 明文只监听 `127.0.0.1:8787`（`CORE_PORT=8787`，不要设 `CORE_HOST=0.0.0.0`），由反代在 443 上终止 TLS。

> Host 白名单提醒：反代把原始 `Host` 透传给 core 时（nginx `proxy_set_header Host $host;`、Caddy 默认行为），core 看到的主机名是**对外域名**，必须把它加进 `CORE_ALLOWED_HOSTS`，否则请求被 403 拒绝。例如 `CORE_ALLOWED_HOSTS=chat.example.com`。

### 2.1 Caddy（最简推荐）

`Caddyfile`：

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

- 证书自动申请、自动续期，无需其他配置。
- 对 SSE（`/events` 长连接事件流）：Caddy 的 `reverse_proxy` 默认即逐段 flush，流式响应不会被缓冲，**无需额外配置**。只有当你显式自定义了 `flush_interval` 时，才需要确保它是 `-1`。

### 2.2 nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name chat.example.com;

    ssl_certificate     /etc/nginx/certs/chat.example.com.fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/chat.example.com.privkey.pem;

    # ---- SSE：/events 是长连接事件流，必须关缓冲，否则事件卡住不出字 ----
    location /events {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";        # 清空 Connection 头，保持长连接
        proxy_buffering off;                    # 关键：关闭响应缓冲
        proxy_cache off;                        # 关键：关闭缓存
        proxy_read_timeout 1h;                  # SSE 空闲期长，读超时放宽到 1 小时
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---- 其余全部反代到 core ----
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

改完 `nginx -t` 校验后 reload。因透传了 `$host`，需 `CORE_ALLOWED_HOSTS=chat.example.com`（见本节开头提醒）。

---

## 3. token 管理

### 3.1 随机 token（默认，推荐）

不设 `CORE_TOKEN` 时，每次启动生成随机 UUID token，并写入运行时文件（`run/` 已 gitignore，不会误提交）：

```bash
cat packages/core/run/core.json
# { "port": 8787, "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
```

带 token 调用 API：

```bash
TOKEN=$(node -e 'console.log(require("./packages/core/run/core.json").token)')
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/providers
```

浏览器走 `http://HOST:PORT/?live=1` 则免 token（token 已注入页面）。重启 core 会换新 token，相当于每次部署自动轮换。

### 3.2 固定 token：`CORE_TOKEN=xxx`

```bash
CORE_TOKEN=0f2a...full-random-long-token npm run smoke
```

- **利**：客户端脚本、多台设备的配置可以写死不变；容器/服务编排里无需每次启动去读 `core.json`；重启不失效。
- **弊**：token 长期有效，一旦泄漏（写进了脚本、日志、聊天记录、git）攻击窗口无限长；换 token 需要手动改配置并重启所有使用方。
- **建议**：默认用随机 token；确需固定时选强随机长串，通过密钥管理/环境变量注入，不进代码库、不打印进日志，泄漏后立即更换并重启。

---

## 4. 安全边界（务必阅读）

> **任何拿到 token 的人都可以让 AI agent 在跑 core 的机器上执行任意 shell 命令、读写 cwd 内文件。所以：必须 HTTPS、token 必须保密、不要把 core 直接暴露公网。**

基于这条边界，部署时遵守以下建议：

1. **必须 HTTPS**：token 以 `Authorization: Bearer` 明文传输，HTTP 下任何链路嗅探者都能拿走 token。用第 2 节的反代终止 TLS。
2. **仅内网/VPN 使用**：不要把 core 端口直接暴露公网；云服务器上把 `8787`（或你的 `CORE_PORT`）在安全组/防火墙里对公网关掉，只保留 443。远程访问走 VPN 或带认证的反代。
3. **不要裸公网直开**：`CORE_HOST=0.0.0.0` 只应配合防火墙限制在可信内网；公网可达 + token 泄漏 = 机器被完全控制。
4. **加层防护更稳**：在反代上再加 IP 白名单、Basic Auth 或 mTLS，可以挡住"token 泄漏但没到反代这一层"的请求。
5. **`CORE_CWD` 最小权限**：它决定 agent 可读写的文件范围，别指向含敏感凭据的目录。

---

## 5. 常见问题

### 5.1 打不开 / 请求被拒（Host 白名单）

**表现**：服务在跑、端口通，但页面或接口返回 `403`，响应体为 `{"error":"forbidden host"}`。这是 core 的 `Host` 头校验在拒绝：访问用的主机名不在 `CORE_ALLOWED_HOSTS` 白名单里。

**解决**：把客户端实际访问用的主机名（IP 或域名，**不含端口**）追加到 `CORE_ALLOWED_HOSTS`，逗号分隔，然后重启 core。注意经反代访问时 core 看到的是**反代透传的 Host**（即对外域名），要加的是域名而非 `127.0.0.1`。

### 5.2 SSE 卡住不出字（反代缓冲）

**表现**：页面能打开，但对话流式输出长时间空白、最后一次性吐出，或 `GET /events` 长时间无事件。

**原因**：反代对响应开了缓冲，SSE 事件被攒在缓冲区里不下发。

**解决**：
- nginx：`location /events` 必须有 `proxy_buffering off;`、`proxy_cache off;`、`proxy_read_timeout 1h;`，以及 HTTP/1.1 下的 `proxy_set_header Connection "";`（见 2.2 样例）。
- Caddy：默认即 flush，一般无需处理。
- 若链路上还有 CDN/企业代理，它们同样会缓冲 SSE，需单独放行或绕开。

### 5.3 models.json 在哪里？

`~/.pi/agent/models.json`，即 `CORE_AGENT_DIR`（缺省 `~/.pi/agent`）目录下的 `models.json`；用 `CORE_AGENT_DIR` 改了 agent 目录后路径随之变化。首次启动若不存在，core 会自动创建一个空文件，之后可在设置页添加 Provider。
