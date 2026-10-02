/**
 * fileImageUrl 纯函数检查 —— `check:fs-image-url`（file-image-preview 批次，task-5-brief §Step 2）。
 *
 * 写作方：**验收方（非实现方）** —— 项目铁律「验收脚本必须由非实现方写」。
 * 本文件**只从冻结契约推导断言**，不读 `src/lib/image-src.ts` 的实现细节：
 *   fileImageUrl(absPath: string, token?: string, baseUrl?: string, fsVersion?: number): string
 *   FILE_IMAGE_ROUTE === "/fs/image"
 *   空串 = 调用方据此不渲染 <img>。
 *
 * 与既有 `check:image-src` 的分工：本脚本锁 `/fs/image` 这条**新**路径的纯函数（含
 * `v=fsVersion` 缓存破门与 U11 的历史 imageUrl 逐字节零回归）；旧的历史断言仍留在
 * image-src-check.mjs 里，两者并入 test:ci。
 *
 * U12/U13 是**唯一的例外口径**：它们不是调函数，而是用 `node:fs` 读 PreviewPane.tsx /
 * core 的 prompt-files.ts / fs-image.ts **源码文本**做正则比对，守「8MB 限长」与
 * 「扩展名集」这两条跨包常量口径（此前只靠注释，改一处忘另一处即产生「无解释的
 * 裂图 + 文案说谎」）。不 import 组件的原因见 U12 上方注释。
 *
 * 运行：npm run check:fs-image-url（node --experimental-strip-types 直导 ../src/lib/image-src.ts）
 * 失败非 0 退出。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileImageUrl, FILE_IMAGE_ROUTE, imageUrl } from "../src/lib/image-src.ts";

let passed = 0;
let total = 0;
const check = (name, fn) => {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

/* ===== U1：缺省（无 token / 无 baseUrl / 无 fsVersion）⇒ 逐字节兼容的基础形态 ===== */
check("U1 fileImageUrl('/tmp/a.png') === '/fs/image?path=%2Ftmp%2Fa.png'（缺省逐字节兼容）", () => {
  assert.equal(fileImageUrl("/tmp/a.png"), "/fs/image?path=%2Ftmp%2Fa.png");
});

/* ===== U2：token 非空 ⇒ 追加在最后 ===== */
check("U2 token 非空 ⇒ 追加在最后（<img> 无法带 Authorization 头）", () => {
  const url = fileImageUrl("/tmp/a.png", "tk-123");
  assert.ok(url.startsWith("/fs/image?path=%2Ftmp%2Fa.png"), url);
  assert.ok(url.includes("token=tk-123"), url);
  // token 段必须是最后一个 query 参数
  assert.ok(url.endsWith("&token=tk-123"), url);
});

/* ===== U3：fsVersion 传入 ⇒ 含 &v=N（缓存破门的回归守卫） ===== */
check("U3 fsVersion 传入 ⇒ 含 &v=N（缓存破门：删了它磁盘图改写场景静默失效）", () => {
  const url = fileImageUrl("/tmp/a.png", undefined, undefined, 7);
  assert.ok(url.includes("&v=7"), url);
});

/* ===== U4：fsVersion === undefined ⇒ **不拼** v= ===== */
check("U4 fsVersion === undefined ⇒ 不拼 v=（避免每次渲染都改 URL）", () => {
  const url = fileImageUrl("/tmp/a.png");
  assert.ok(!url.includes("v="), url);
  // 显式传 undefined 与不传同解
  assert.equal(fileImageUrl("/tmp/a.png", undefined, undefined, undefined), url);
});

/* ===== U5：fsVersion === 0 ⇒ 拼 &v=0（首屏 fsVersion 恰为 0，漏拼则首图无破门） ===== */
check("U5 fsVersion === 0 ⇒ 拼 &v=0（0 是合法值，不能被 falsy 判空误杀）", () => {
  const url = fileImageUrl("/tmp/a.png", undefined, undefined, 0);
  assert.ok(url.includes("&v=0"), url);
});

/* ===== U6：baseUrl 前缀拼在最前 ===== */
check("U6 baseUrl 前缀拼在最前（跨源 dev 形态：否则打到 vite 返 SPA HTML ⇒ 图裂）", () => {
  const url = fileImageUrl("/tmp/a.png", "tk", "http://127.0.0.1:5190");
  assert.ok(url.startsWith("http://127.0.0.1:5190/fs/image?"), url);
});

/* ===== U7：空/空白 path ⇒ 空串 ===== */
check("U7 空/空白 path ⇒ 空串（调用方据此隐藏 img）", () => {
  assert.equal(fileImageUrl(""), "");
  assert.equal(fileImageUrl("   "), "");
  assert.equal(fileImageUrl("\t\n "), "");
});

/* ===== U8：孤立代理 ⇒ 空串、不抛 URIError ===== */
check("U8 孤立代理路径 ⇒ 空串、不抛 URIError（调用方裸调无 try/catch）", () => {
  assert.equal(fileImageUrl("\uD800"), "");
});

/* ===== U9：Windows 反斜杠路径被 encode（含 %5C） ===== */
check("U9 Windows 反斜杠路径被 encode（含 %5C）", () => {
  const url = fileImageUrl("C:\\Users\\dev\\a.png");
  assert.ok(url.includes("%5C"), url);
  assert.ok(!url.includes("\\"), url);
});

/* ===== U10：FILE_IMAGE_ROUTE === "/fs/image"（与 core API_ROUTES 字面一致） ===== */
check("U10 FILE_IMAGE_ROUTE === '/fs/image'（与 core 路由字面一致）", () => {
  assert.equal(FILE_IMAGE_ROUTE, "/fs/image");
});

/* ===== U11：历史 imageUrl 逐字节未被破坏（既有断言原样保留） ===== */
check("U11 历史 imageUrl 逐字节未被破坏：缺省三元组 URL 不变", () => {
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 2 }), "/sessions/image?sessionId=s1&entryId=e1&partIndex=2");
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 0 }), "/sessions/image?sessionId=s1&entryId=e1&partIndex=0");
});

check("U11 历史 imageUrl 逐字节未被破坏：缺省/空 token/空 baseUrl 形态不变", () => {
  const block = { sessionId: "s1", entryId: "e1", partIndex: 0 };
  const expected = "/sessions/image?sessionId=s1&entryId=e1&partIndex=0";
  assert.equal(imageUrl(block), expected);
  assert.equal(imageUrl(block, "", ""), expected);
  assert.equal(imageUrl(block, undefined, ""), expected);
});

check("U11 历史 imageUrl 逐字节未被破坏：token 与特殊字符编码形态不变", () => {
  const block = { sessionId: "a b&c", entryId: "e/1", partIndex: 0 };
  const url = imageUrl(block, "tk-123");
  assert.ok(url.includes("sessionId=a%20b%26c"), url);
  assert.ok(url.includes("entryId=e%2F1"), url);
  assert.ok(url.includes("token=tk-123"), url);
});

check("U11 历史 imageUrl 逐字节未被破坏：partIndex 闸门与 alt 文案不变", () => {
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1", partIndex: -1 }), "");
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 1.5 }), "");
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1" }), "");
  assert.equal(imageUrl({ sessionId: "", entryId: "e1", partIndex: 0 }), "");
});

/* ===== U12/U13：跨包常量口径守卫 =====
 *
 * 为什么是「读源码文本 + 正则」而不是 import 组件：
 *   PreviewPane.tsx 经 `@/` 别名引 store/图标，`node --experimental-strip-types`
 *   不解析 tsconfig paths（见本文件头对 image-src.ts 纯函数切分的同一条理由），
 *   import 它会直接死在模块解析阶段。故 U12/U13 走纯文本比对：零依赖、零行为面。
 *
 * 这两条守的是**跨 4 个 Task、4 个文件**的口径（此前只靠注释）：
 *   8MB 限长   prompt-files.ts(基准) ← 真 import → fs-image.ts ← 字面量 → PreviewPane.tsx / image-attach.ts
 *   扩展名集   fs-image.ts 的 MIME_WHITELIST(基准) ← 字面量 → PreviewPane.tsx 的 IMAGE_EXTS
 * 漂移后果都是「无解释的裂图 + 文案说谎」：
 *   UI 上限 > core ⇒ UI 不判超限 ⇒ core 回 413 ⇒ `<img>` 只看到裂图 ⇒
 *     「图片过大」占位永不出现，用户看到的是完全错误的理由；
 *   IMAGE_EXTS 收了 core 不认的扩展名（如 ico）⇒ 同样是无解释的裂图。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..", "..");
/** 惰性 + 记忆化：读不到/改名时以一条 ✗ 报出，而不是模块加载期抛栈把前面的用例全吞掉 */
const srcCache = new Map();
const readSrc = (rel) => {
  if (!srcCache.has(rel)) srcCache.set(rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"));
  return srcCache.get(rel);
};
const CORE_PROMPT_FILES = () => readSrc("packages/core/src/prompt-files.ts");
const CORE_FS_IMAGE = () => readSrc("packages/core/src/fs-image.ts");
const UI_PREVIEW_PANE = () => readSrc("packages/ui/src/components/shell/PreviewPane.tsx");

/** 抓 `<const|export const> NAME … = <表达式>;` 的表达式原文（空白归一化后比较） */
function grabExpr(src, name) {
  const m = src.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*([^;]+);`));
  assert.ok(m, `源码里抓不到常量 ${name}（改名/换写法会让本守卫静默失效，必须一并改断言）`);
  return m[1].replace(/\s+/g, " ").trim();
}

/** 抓 `const NAME … = new Set([ … ])` 里全部字符串字面量 */
function grabSetLiterals(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\b[^=]*=\\s*new Set\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`));
  assert.ok(m, `源码里抓不到 ${name} 的 new Set([...])（改名/换写法会让本守卫静默失效）`);
  const items = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(items.length > 0, `${name} 抓到 0 个字符串字面量`);
  return items;
}

check("U12 PreviewPane 的 FILE_IMAGE_MAX_BYTES 与 core prompt-files 的 IMAGE_MAX_BYTES 表达式逐字相同", () => {
  const uiExpr = grabExpr(UI_PREVIEW_PANE(), "FILE_IMAGE_MAX_BYTES");
  const coreExpr = grabExpr(CORE_PROMPT_FILES(), "IMAGE_MAX_BYTES");
  assert.equal(uiExpr, coreExpr, `8MB 限长两侧漂移：PreviewPane=\`${uiExpr}\` vs prompt-files=\`${coreExpr}\`（UI 大于 core ⇒ core 回 413 而 UI 不判超限 ⇒「图片过大」占位永不出现）`);
});

check("U13 PreviewPane 的 IMAGE_EXTS 与 core fs-image 的 MIME_WHITELIST 一一对位（扩展名双向覆盖）", () => {
  /** 扩展名 → MIME。jpg/jpeg 同映射，这是两侧「集完全一致」得以成立的关键 */
  const EXT_MIME = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  const uiExts = grabSetLiterals(UI_PREVIEW_PANE(), "IMAGE_EXTS");
  const coreMimes = new Set(grabSetLiterals(CORE_FS_IMAGE(), "MIME_WHITELIST"));

  // 方向一：UI 放行的每个扩展名，映射出的 MIME 都必须在 core 白名单里
  const uiMimes = new Set();
  for (const ext of uiExts) {
    const mime = EXT_MIME[ext];
    assert.ok(mime, `IMAGE_EXTS 里的 \`${ext}\` 不在扩展名→MIME 映射表内，且 core 白名单只有 ${[...coreMimes].join("/")} —— 加进来会让预览区出现无解释的裂图`);
    assert.ok(coreMimes.has(mime), `IMAGE_EXTS 放行了 \`${ext}\`（${mime}），core MIME_WHITELIST 不含该 MIME ⇒ 魔数嗅探回 415 ⇒ 无解释的裂图`);
    uiMimes.add(mime);
  }

  // 方向二：core 白名单里的每个 MIME，UI 侧也必须能走到（否则 core 支持的图 UI 打不开）
  const missing = [...coreMimes].filter((m) => !uiMimes.has(m));
  assert.equal(missing.length, 0, `core MIME_WHITELIST 收 ${missing.join("/")}，但 PreviewPane 的 IMAGE_EXTS 未覆盖（core 支持的图 UI 打不开）`);
  assert.deepEqual([...uiMimes].sort(), [...coreMimes].sort(), "IMAGE_EXTS 映射出的 MIME 集与 core MIME_WHITELIST 集不一致");
});

console.log(`\n=== fileImageUrl: ${passed}/${total} 通过 ===`);
if (passed !== total) process.exit(1);
