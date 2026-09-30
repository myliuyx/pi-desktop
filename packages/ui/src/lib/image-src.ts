/**
 * 历史图片 URL 拼装（2026-10-01 图片预览批次）—— 纯函数，可进 CI 检查。
 *
 * `ImageBlock` 只带定位三元组，这里拼出取图端点 URL。刻意做成无 React / 无 store
 * 依赖的纯函数：Node --experimental-strip-types 加载不了 `@/` 别名
 * （TESTING.md 已记录），要进 check 脚本的逻辑必须这样切。
 */

/** 取图端点路径（与 core 的 API_ROUTES 字面对应，改一处必须同步另一处） */
export const SESSION_IMAGE_ROUTE = "/sessions/image";

/**
 * 由 ImageBlock 拼取图 URL；输入不合法时返回空串（调用方据此不渲染 img）。
 *
 * 闸门那四条件是本函数**唯一的输入校验**，也是 core 端 `/sessions/image` 校验的对位物
 * （core 收的是 `Number(partIndexRaw)` + `Number.isInteger`）—— 两侧口径必须一致：
 * 放行小数/负数会让 core 拿着非整数下标去 JSONL 里找 part。
 *
 * `token` 可选：`<img>` 拿不到 Authorization 头（core 侧 `/sessions/image` 为此单点豁免
 * `?token=`，见 server.ts 鉴权段注释），所以把 token 拼进 URL。缺省/空串 ⇒ 不拼该段
 * （保持既有调用点逐字节兼容）。
 */
export function imageUrl(
  block: {
    sessionId?: string;
    entryId?: string;
    partIndex?: number;
  },
  token?: string,
): string {
  const { sessionId, entryId, partIndex } = block;
  if (!sessionId || !entryId || !Number.isInteger(partIndex) || (partIndex ?? -1) < 0) return "";
  // 参数序固定；token 非空时追加在最后。
  //
  // 为什么手拼而不 URLSearchParams.toString()：本仓既有惯例如此 ——
  // `services/agent-transport.ts` 的 query 一律逐值 encodeURIComponent 手拼；
  // 这里沿用同一口径，check 脚本的断言也锁死了这个形态（两处口径一起改）。
  //
  // ⚠️ encodeURIComponent 遇**孤立代理**（lone surrogate，如 "\uD800"）会抛 URIError
  // （实测）。当前 sessionId 来自 randomUUID、不可达；但 Task 7 会裸调本函数且无
  // try/catch —— 一个 URL 拼装函数不该把调用方的整棵消息树搞崩，故捕获后返回空串，
  // 复用「空串 = 不渲染 img」这条既有语义（与上方缺字段同义）。
  try {
    const q = (
      [
        ["sessionId", sessionId],
        ["entryId", entryId],
        ["partIndex", String(partIndex)],
        ...(token ? ([["token", token]] as [string, string][]) : []),
      ] as [string, string][]
    )
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${SESSION_IMAGE_ROUTE}?${q}`;
  } catch {
    return "";
  }
}

/** 历史图片缩略图/大图的 alt 文案（1-based 序号，读屏友好） */
export function imageThumbnailAlt(index: number): string {
  return `图片 ${index + 1}`;
}
