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
 * 运行：npm run check:fs-image-url（node --experimental-strip-types 直导 ../src/lib/image-src.ts）
 * 失败非 0 退出。
 */
import assert from "node:assert/strict";
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

console.log(`\n=== fileImageUrl: ${passed}/${total} 通过 ===`);
if (passed !== total) process.exit(1);