#!/usr/bin/env bash
# run-web.sh —— 一键「构建 + 重启」Pi Workbench 的自托管 web 形态。
#
# 解决的问题：验收正门 http://<内网IP>:5190/?live=1 每次换分支/改代码后，
# 都得先想一遍「停旧进程 → 重建产物 → 带对环境变量重启」，漏一步就是旧代码在服务
# （2026-09-28 实锤事故：core/dist 停在 9-25 缺 /skills 路由，页面报「读取技能
# 清单失败（HTTP 200）」——HTML 落进了 API 缺口）。本脚本把这条链路封死。
#
# 做什么：
#   1. 杀掉占用端口、且确认是本仓库 pi-web 的旧进程（TERM → 宽限 → KILL）
#   2. 调 build-dist.mjs 全量重建 ui/core/desktop/web 四份产物
#   3. setsid 脱离终端重启，轮询到 /health 真的应答为止
#
# 不做（刻意）：
#   - 不杀端口上「不是本仓库」的进程：那是别人的服务，脚本只报错退出，
#     要强杀请显式 --kill-any。
#   - 不自己实现构建：构建口径唯一来源是 build-dist.mjs（含 assemble 的
#     新鲜度闸），脚本只调它，避免两处漂移。
#
# 用法：
#   ./run-web.sh                    # 构建 + 重启（最常用）
#   ./run-web.sh --no-build         # 只重启（产物已是最新时用这个，秒级）
#   ./run-web.sh --port 5200        # 换个端口
#   ./run-web.sh --kill-only        # 只杀旧进程，不构建不启动
#   ./run-web.sh --log /tmp/x.log   # 换日志路径
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${CORE_PORT:-5190}"
HOST="${CORE_HOST:-0.0.0.0}"
CWD="${CORE_CWD:-$ROOT/packages/web}"
LOG="/tmp/pi-web-${PORT}.log"
PIDFILE="/tmp/pi-web-${PORT}.pid"
DO_BUILD=1
KILL_ONLY=0
KILL_ANY=0

die() { printf '\033[31m[run-web] ✗ %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m[run-web]\033[0m %s\n' "$*"; }
ok() { printf '\033[32m[run-web] ✓\033[0m %s\n' "$*"; }

usage() {
	sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit 0
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--no-build) DO_BUILD=0 ;;
	--kill-only) KILL_ONLY=1; DO_BUILD=0 ;;
	--kill-any) KILL_ANY=1 ;;
	--port) PORT="${2:?--port 需要端口号}"; shift ;;
	--log) LOG="${2:?--log 需要路径}"; shift ;;
	-h | --help) usage ;;
	*) die "未知参数：$1（--help 看用法）" ;;
	esac
	shift
done

command -v node >/dev/null || die "找不到 node"
[[ -f build-dist.mjs ]] || die "不在仓库根目录（缺 build-dist.mjs）"

# ── 0. 内网放行 Host：没显式给就自动探测本机内网 IP ────────────────────────
# core 的 Host 白名单默认只放行回环，跨机访问要先放行对应 IP，否则 403。
# 自动探测让脚本跟着机器走（换网络/IP 不用改脚本），docker 网段排除掉。
if [[ -z "${CORE_ALLOWED_HOSTS:-}" ]]; then
	lan_ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
	[[ -z "$lan_ip" ]] && lan_ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -vE '^172\.(1[6-9]|2[0-9]|3[01])\.' | head -1)"
	[[ -n "$lan_ip" ]] || die "探测不到内网 IP，请显式给 CORE_ALLOWED_HOSTS=<你的IP> ./run-web.sh"
	CORE_ALLOWED_HOSTS="$lan_ip"
	info "内网放行 Host：$CORE_ALLOWED_HOSTS（自动探测，可用 CORE_ALLOWED_HOSTS 覆盖）"
fi

# ── 1. 找出占用端口的进程 ───────────────────────────────────────────────────
# 用 lsof 拿真正 LISTEN 在该端口的 pid（不猜「最近的 pi-web」）。
port_pids() { lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true; }

# 是不是「本仓库的 pi-web」：cwd 在仓库内，或命令行指到本仓库的 bin。
# 两条任一成立即认——历史上有人从仓库根跑、有人从 packages/web 跑。
is_ours() {
	local pid="$1" cwd cmd
	cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
	cmd="$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
	[[ -n "$cmd" ]] || return 1
	if [[ "$cmd" == *"pi-web.mjs"* || "$cmd" == *"pi-web.js"* ]]; then
		[[ "$cwd" == "$ROOT" || "$cwd" == "$ROOT"/* ]] && return 0
	fi
	[[ "$cmd" == *"${ROOT}/packages/web/bin/"* ]] && return 0
	return 1
}

kill_ours() {
	local pids pid n
	pids="$(port_pids)"
	[[ -n "$pids" ]] || return 0
	for pid in $pids; do
		if is_ours "$pid"; then
			info "发现旧进程 pid=$pid（$(tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | cut -c1-60)），先温和终止"
			kill -TERM "$pid" 2>/dev/null || true
		elif [[ "$KILL_ANY" == "1" ]]; then
			info "--kill-any：强杀非本仓库进程 pid=$pid"
			kill -TERM "$pid" 2>/dev/null || true
		else
			die "端口 ${PORT} 被非本仓库进程占用（pid=$pid）。确认后可加 --kill-any 强杀，或用 --port 换端口。"
		fi
	done
	# 宽限 5s 给它收尾（SSE 长连接要断），超了才 KILL
	for _ in $(seq 1 25); do
		pids="$(port_pids)"
		[[ -n "$pids" ]] || { ok "旧进程已退出，端口 ${PORT} 已释放"; return 0; }
		sleep 0.2
	done
	for pid in $(port_pids); do
		info "pid=$pid 未响应 TERM，强制 KILL"
		kill -KILL "$pid" 2>/dev/null || true
	done
	sleep 0.5
	[[ -z "$(port_pids)" ]] || die "端口 ${PORT} 仍被占用，放弃启动"
}

info "检查端口 ${PORT} 上的旧进程…"
kill_ours

if [[ "$KILL_ONLY" == "1" ]]; then
	ok "--kill-only：已清理完毕，未构建也未启动"
	exit 0
fi

# ── 2. 全量重建 ────────────────────────────────────────────────────────────
# 走 build-dist.mjs 而不是各包自己 build：它是构建口径的唯一来源
# （ui → core → desktop → web 顺序 + assemble 新鲜度闸）。
if [[ "$DO_BUILD" == "1" ]]; then
	info "开始全量重建（约 20s，产物：ui/dist、core/dist、desktop/dist、web/dist+ui）…"
	node build-dist.mjs || die "构建失败——已中止，未启动（不要用旧产物凑合）"
	ok "构建完成"
else
	info "--no-build：跳过构建，直接用现有产物启动"
fi

# ── 3. 启动 ────────────────────────────────────────────────────────────────
# setsid + nohup：脱离当前终端，关掉窗口/断 SSH 不影响服务。
info "启动 pi-web（PORT=${PORT} HOST=${HOST}）…"
: >"$LOG"
CORE_PORT="$PORT" CORE_HOST="$HOST" CORE_ALLOWED_HOSTS="$CORE_ALLOWED_HOSTS" CORE_CWD="$CWD" \
	setsid nohup node packages/web/bin/pi-web.mjs >"$LOG" 2>&1 &
NEW_PID=$!
disown "$NEW_PID" 2>/dev/null || true
echo "$NEW_PID" >"$PIDFILE"
info "新进程 pid=$NEW_PID，日志：$LOG"

# ── 4. 就绪判定：轮询到 /health 真的应答 ────────────────────────────────────
# 关键：不以「进程还活着」当就绪（起了但没 listen 也算没起来），
# 而以「HTTP 真的应答」为准。/health 要 Bearer token，
# 所以裸 curl 返回 401 = 服务已在应答（再拿 token 复核一次拿 200）。
wait_ready() {
	local code
	for _ in $(seq 1 80); do # 最多约 40s
		kill -0 "$NEW_PID" 2>/dev/null || return 2 # 进程中途死了
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo 000)"
		[[ "$code" == "401" || "$code" == "200" ]] && return 0
		sleep 0.5
	done
	return 1
}

if ! wait_ready; then
	echo "----- 日志尾部 -----" >&2
	tail -20 "$LOG" >&2
	die "40s 内 /health 未应答，启动失败（日志见上，完整日志 $LOG）"
fi

# 拿 token 复核一次真正的 200，并确认 core.json 记的就是这个端口
RUN_DIR="${CORE_RUN_DIR:-$HOME/.pi-web}"
COREFILE="$RUN_DIR/core.json"
if [[ -f "$COREFILE" ]]; then
	token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$COREFILE" | head -1)"
	if [[ -n "$token" ]]; then
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
			-H "Authorization: Bearer ${token}" "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo 000)"
		[[ "$code" == "200" ]] || die "带 token 的 /health 返回 ${code}（非 200），鉴权链路异常，见 $LOG"
	fi
fi

ok "已就绪：/health 应答正常"
echo
info "浏览器打开（强刷 Ctrl+Shift+R，避免旧 index.html 缓存）："
printf '    \033[1mhttp://%s:%s/?live=1\033[0m\n' "$CORE_ALLOWED_HOSTS" "$PORT"
printf '    \033[2mhttp://127.0.0.1:%s/?live=1\033[0m\n' "$PORT"
echo
info "停服务：kill \$(cat ${PIDFILE})   ｜   看日志：tail -f ${LOG}"
