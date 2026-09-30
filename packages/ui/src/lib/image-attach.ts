/**
 * 粘贴图片批次（task-composer-paste-image.md §5.1）：剪贴板图片 → 待发附件的
 * 纯函数工具。**只做 UI 侧的即时校验**（类型白名单 + 大小/数量上限），不做
 * magic 嗅探、不做缩放/转码 —— 上游 `AgentSession.prompt` 内部的 `processImage`
 * 统一兜底（异格式转 PNG / autoResize / 失败降级 hints，见规格书 §二）。
 */

/** 待发图片附件（dataUrl 兼作缩略图预览与发送数据源） */
export interface ComposerImage {
  id: string;
  mimeType: string;
  /** `data:<mime>;base64,<...>` 形态（FileReader.readAsDataURL 原样产物） */
  dataUrl: string;
}

/** 单图原始字节上限 —— 与 core prompt-files.ts 的 IMAGE_MAX_BYTES 同一口径，改一处必须同步另一处 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 单条消息图片数量上限（D6：防 HTTP body 与状态体积爆炸；core 侧同值独立守） */
export const MAX_IMAGES_PER_MESSAGE = 8;

/**
 * 类型白名单 = Chromium `<img>` 能预览的集（png/jpeg/gif/webp/bmp）。
 * bmp 依赖上游转 PNG；白名单外的（HEIC 等）连预览都不可靠，直接拒。
 */
const MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/**
 * 生成待发图片的唯一 id。
 *
 * ⚠️ 不能直接用 `crypto.randomUUID()`：它只在**潜在可信来源**下存在
 * （https/wss，或 http + localhost/127.0.0.1/[::1]）。用内网 IP 走 http 访问
 * 本服务（run-web.sh 会打印内网地址，且排在第一个）时 isSecureContext=false、
 * `crypto.randomUUID` 直接是 undefined —— 粘贴在 FileReader.onload 里抛
 * `crypto.randomUUID is not a function`，图片被静默丢弃、无任何提示。
 * `getRandomValues` 在任何上下文都可用，故以此作回退。
 */
function newImageId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 v4 位形
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 剥 `;` 参数段 + `image/jpg` 归一为 `image/jpeg`（非标准别名，剪贴板偶发） */
function normalizeMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "image/jpg" ? "image/jpeg" : base;
}

export type AttachResult =
  | { ok: true; image: ComposerImage }
  | { ok: false; reason: string };

/** 把剪贴板取出的 Blob/File 校验并转成待发附件（失败返回可直出的 reason） */
export function attachFromBlob(blob: Blob): Promise<AttachResult> {
  const mime = normalizeMime(blob.type);
  if (!mime || !MIME_WHITELIST.has(mime)) {
    return Promise.resolve({ ok: false, reason: `不支持的图片格式：${blob.type || "未知"}` });
  }
  if (blob.size > IMAGE_MAX_BYTES) {
    return Promise.resolve({ ok: false, reason: "图片超过 8MB" });
  }
  if (blob.size === 0) {
    return Promise.resolve({ ok: false, reason: "空图片" });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, reason: "图片读取失败" });
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl.startsWith("data:")) {
        resolve({ ok: false, reason: "图片读取失败" });
        return;
      }
      /*
       * onload 里再包一层 try/catch：这是 FileReader 的异步回调，抛出的异常
       * **不会**被调用方的 await 捕获，会变成一个无主的 rejected promise ——
       * 结果是图片静默消失、连「图片读取失败」提示都看不到。
       */
      try {
        resolve({
          ok: true,
          image: { id: newImageId(), mimeType: mime, dataUrl },
        });
      } catch (err) {
        console.error("[image-attach] 生成图片 id 失败", err);
        resolve({ ok: false, reason: "图片读取失败" });
      }
    };
    reader.readAsDataURL(blob);
  });
}

/** 发送用：dataUrl → core `/prompt` images 项（`/prompt` body 与上游 ImageContent 同形） */
export function stripDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return { data: m[2], mimeType: m[1] };
}
