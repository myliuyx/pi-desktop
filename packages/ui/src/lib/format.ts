/**
 * 数值格式化 —— 纯函数，无副作用、无依赖。
 *
 * 抽出来的理由：TokenStats（M2）与 03 运行详情（M4）都要用同一套规则，
 * 各写一份必然出现 `12.4k` 与 `12.4K` 这类不一致。
 */

/**
 * 紧凑数值：≥1000 折算成 k。
 *
 * 规则（据设计稿第 5 轮定稿的 TokenStats 四段实测值反推）：
 * - `12.4k`（12400 → k 值非整数 → 保留一位小数）
 * - `128k`（128000 → k 值恰为整数 → 省略小数，**不写成 128.0k**）
 * - `999`（不足 1000 → 原样输出，不折算）
 *
 * ⚠️ 注意这里与 `.plan/screens.md` 里那句 `(n / 1000).toFixed(1) + "k"` 的差异：
 * 那句会把上下文写成 `128.0k`，与设计稿的 `128k` 不符。以本函数为准。
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value < 1000) return String(Math.round(value));
  const k = value / 1000;
  // 用「保留一位小数后」的值判进位：999_950 起的 k 会四舍五入成 1000.0k，应升到 M。
  // 输出格式仍看**原始** k 是否为整数（1995 ⇒ 2.0k，保持既有行为不变）。
  if (Math.round(k * 10) / 10 < 1000) {
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return formatMillions(value);
}

/** ≥1M（含从 k 进位上来的 999_950..999_999）：M 值 ≥10 时取整，避免出现 "10.0M" */
function formatMillions(value: number): string {
  const m = value / 1_000_000;
  return Math.round(m * 10) / 10 < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

/**
 * 全量数值的千分位分组（计算器式逗号，2026-09-27 用户裁决）：8278 → `8,278`。
 *
 * 固定 en-US 而不用裸 `toLocaleString()`：后者随系统 locale 变脸
 * （de-DE 会渲染成 `8.278`），「逗号分组」的口径就守不住了。
 * 只用于整数（token 计数）；小数走各自场景的格式化，不经此函数。
 */
export function formatThousands(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US").format(Math.trunc(value));
}

/* ---------------------------------------------------------------------------
 * token 速度徽章分档（2026-09-27 用户裁决，模型行徽章用）
 * ------------------------------------------------------------------------- */

export type SpeedTone = "danger" | "warning" | "success" | "info";

/**
 * 生成速度 → 语义档位。阈值（t/s，用户裁定，边界归右档）：
 * <15 红（慢） / 15–35 黄（偏慢） / 35–70 绿（正常） / ≥70 蓝（快）。
 * 四档一一映射 tokens.css 的语义令牌（soft 底对比度已验证），G5 验收安全。
 */
export function speedTone(tps: number): SpeedTone {
  if (!Number.isFinite(tps)) return "danger";
  if (tps < 15) return "danger";
  if (tps < 35) return "warning";
  if (tps < 70) return "success";
  return "info";
}

/** 时刻 HH:MM（消息时间戳用） */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/* ---------------------------------------------------------------------------
 * 上下文占用环分档（task-composer-inline-toolbar.md，2026-09-30 主控裁决 D1=A1）
 * ------------------------------------------------------------------------- */

export type ContextTone = "neutral" | "warning" | "danger";

/**
 * 上下文占用率 → 环的三档分色：≥90% 红（逼近窗口上限）/ ≥70% 黄（偏高）/
 * 其余中性灰（安静态——多数时候占用离上限很远，不抢注意力）。
 * 与 speedTone 同一纪律：一一映射 tokens.css 的语义令牌（G1/G5 安全）。
 */
export function contextTone(percent: number): ContextTone {
  if (!Number.isFinite(percent)) return "neutral";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "neutral";
}

/**
 * 上下文占用率文案：一位小数、去尾零（`14.5%` / `24%` / `0%`）。
 * 「一位小数」对齐旧 TokenStats 与 Pi CLI（`0.1%`）的口径；去尾零让
 * `14.53125%` 这类值落成 `14.5%`、整数占用不出现 `24.0%`。
 */
export function formatContextPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return "0%";
  const fixed = percent.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

/** 按行数截断文本，返回可见部分与被省略的行数 */
export function truncateLines(text: string, maxLines: number): { visible: string; hiddenCount: number } {
  const lines = text.split("\n");
  if (maxLines <= 0 || lines.length <= maxLines) return { visible: text, hiddenCount: 0 };
  return { visible: lines.slice(0, maxLines).join("\n"), hiddenCount: lines.length - maxLines };
}

/**
 * 相对时间文案（侧边栏历史会话元信息行用）。
 *
 * 必须传显式 `now` 而不是内部取 Date.now()：mock 时间戳是固定基准（见 mock/sessions.ts），
 * 「now」也必须随之固定，相对时间文案才可复跑（验收 1-6 会把条目文案记入证据）。
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`;
  return `${Math.floor(diff / DAY)}天前`;
}

/* ---------------------------------------------------------------------------
 * 消息时间标签（2026-09-27 消息时间批次，MessageFooter 右下角小字用）
 * ------------------------------------------------------------------------- */

/**
 * 消息时间标签文案。
 *
 * 规则（2026-09-27 定稿）：今天只显示时刻（18:25）；昨天加「昨天」前缀；
 * 今年其他日期 `MM-DD HH:mm`；跨年补全年份 `YYYY-MM-DD HH:mm`。
 *
 * 返回 null 表示「不显示」：timestamp 为 0（reduce.ts 对缺失时间戳的兜底值）时
 * 调用方必须整体不渲染时间，绝不能落成「1970-01-01 08:00」。
 *
 * 与 formatRelativeTime 同一条纪律：**必须显式传 `now`**、不内部取 Date.now()，
 * 「今天与否」的判定才可被验收脚本固定复跑；Date.now() 只在组件边界取。
 */
export function formatMessageTime(timestamp: number, now: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const time = formatClock(timestamp);
  if (sameDay(date, today)) return time;
  // 昨天按日历推算（getDate()-1 由 Date 构造器归一化），不用 now-86400000 ——
  // 后者在夏令时切换日会把「昨天」算错一小时（本地无夏令时，口径仍取稳的）。
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${time}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === today.getFullYear()
    ? `${md} ${time}`
    : `${date.getFullYear()}-${md} ${time}`;
}

/** 悬停 title 用的完整秒级时间（本地时区），如 `2026-09-27 18:25:03` */
export function formatFullTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
