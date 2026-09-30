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
      resolve({
        ok: true,
        image: { id: crypto.randomUUID(), mimeType: mime, dataUrl },
      });
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
