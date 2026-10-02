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
 *
 * `baseUrl` 可选：core 的基址。与 `agent-transport` 的 `${cfg.baseUrl}${path}` 同口径 ——
 * core 同源托管 UI 时 `baseUrl` 为 `""`（相对路径即可）；**跨源 dev 形态**（README:70 记的
 * `5173/?live=1&core=http://127.0.0.1:5190`）下必须带上，否则 `/sessions/image` 会打到
 * vite dev server —— 那里没这个路由，core 的 SPA 回退会把 index.html 当 200 返回，
 * `<img>` 解 HTML 失败 ⇒ 历史图全裂且无任何报错。缺省 `""` ⇒ 逐字节不变。
 */
export function imageUrl(
  block: {
    sessionId?: string;
    entryId?: string;
    partIndex?: number;
  },
  token?: string,
  baseUrl?: string,
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
    return `${baseUrl ?? ""}${SESSION_IMAGE_ROUTE}?${q}`;
  } catch {
    return "";
  }
}

/** 历史图片缩略图/大图的 alt 文案（1-based 序号，读屏友好） */
export function imageThumbnailAlt(index: number): string {
  return `图片 ${index + 1}`;
}

/* -------------------------------------------------- 工作目录图片（文件预览） */

/** 取图端点路径（与 core 的 API_ROUTES 字面对应，改一处必须同步另一处） */
export const FILE_IMAGE_ROUTE = "/fs/image";

/**
 * 由工作目录里的图片绝对路径拼取图 URL；空串 = 调用方据此不渲染 img。
 *
 * 与上方历史图 `imageUrl` 的**同与异**：
 * - 同：`token` 必须拼进 URL——调用方是 `<img src>`，带不了 Authorization 头，
 *   core 为此对 `/fs/image` 豁免 `?token=`（与 `/sessions/image` 并列两点，
 *   见 server.ts:180 `TOKEN_IN_URL_ROUTES`）。
 *   缺省/空串 ⇒ 不拼该段；`baseUrl` 缺省空串 ⇒ 逐字节不变（同源托管形态）。
 * - 同：手拼 query 而非 `URLSearchParams.toString()`，沿用 agent-transport 口径；
 *   `encodeURIComponent` 遇孤立代理会抛 URIError，故 try/catch 兜底空串
 *   （一个 URL 拼装函数不该把调用方的整棵消息树搞崩）。
 * - **异 1**：入参是**路径**而非定位三元组——文件树点开的就是绝对路径，
 *   无需 sessionId/entryId。
 * - **异 2**：多一个 `fsVersion` ⇒ `&v=N`。磁盘图片**会被 agent 改写**，
 *   而 core 的 `/fs/image` 用 `Cache-Control: no-cache`（不是 `/sessions/image` 的
 *   immutable，那是 append-only 会话 JSONL 的特例）。URL 不带版本号时，
 *   `fsVersion` 变化触发的重拉拿到的是同一 URL，浏览器会直接吐缓存旧字节 ⇒
 *   agent 刚改完的图在预览区纹丝不动。`v=` 是这条链上唯一的缓存破门。
 */
export function fileImageUrl(
  absPath: string,
  token?: string,
  baseUrl?: string,
  fsVersion?: number,
): string {
  if (!absPath || !absPath.trim()) return "";
  try {
    const segments: [string, string][] = [
      ["path", absPath],
      ...(token ? ([["token", token]] as [string, string][]) : []),
      ...(fsVersion !== undefined ? ([["v", String(fsVersion)]] as [string, string][]) : []),
    ];
    const q = segments.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `${baseUrl ?? ""}${FILE_IMAGE_ROUTE}?${q}`;
  } catch {
    // 孤立代理（lone surrogate）抛 URIError：兜底空串，复用「空串 = 不渲染 img」
    return "";
  }
}
