/**
 * 共享的 unknown 收窄工具 —— core 内多处解析 Pi / 文件数据都要用，别各写一份
 * （此前 sessions/session/adapt/resources/server 共有 5 份 `isRecord`、2 份 `num`）。
 */

/** 非 null 的对象（**含数组**，与历史实现一致，勿改语义） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** 有限数值，否则 0（Pi 的 Usage 全为 number，但旧文件可能是 null/undefined） */
export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}