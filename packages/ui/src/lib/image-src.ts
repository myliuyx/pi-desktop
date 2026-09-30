/**
 * 历史图片 URL 拼装（2026-10-01 图片预览批次）—— 纯函数，可进 CI 检查。
 *
 * `ImageBlock` 只带定位三元组，这里拼出取图端点 URL。刻意做成无 React / 无 store
 * 依赖的纯函数：Node --experimental-strip-types 加载不了 `@/` 别名
 * （TESTING.md 已记录），要进 check 脚本的逻辑必须这样切。
 */

/** 取图端点路径（与 core 的 API_ROUTES 字面对应，改一处必须同步另一处） */
export const SESSION_IMAGE_ROUTE = "/sessions/image";

/** 由 ImageBlock 拼取图 URL；任一定位字段缺失时返回空串（调用方据此不渲染 img） */
export function imageUrl(block: {
  sessionId?: string;
  entryId?: string;
  partIndex?: number;
}): string {
  const { sessionId, entryId, partIndex } = block;
  if (!sessionId || !entryId || !Number.isInteger(partIndex) || (partIndex ?? -1) < 0) return "";
  // 不用 URLSearchParams.toString()：它是表单编码，空格出 "+" 而不是 "%20"
  // （check 第 2 条锁死 %20 口径）。逐值 encodeURIComponent，参数序固定。
  const q = (
    [
      ["sessionId", sessionId],
      ["entryId", entryId],
      ["partIndex", String(partIndex)],
    ] as const
  )
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${SESSION_IMAGE_ROUTE}?${q}`;
}

/** 历史图片缩略图/大图的 alt 文案（1-based 序号，读屏友好） */
export function imageThumbnailAlt(index: number): string {
  return `图片 ${index + 1}`;
}
