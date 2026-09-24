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

/** 时刻 HH:MM（消息时间戳用） */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
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
