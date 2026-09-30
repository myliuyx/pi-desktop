/**
 * image-src 纯函数检查 —— 2026-10-01 图片预览批次。
 *
 * 为什么单独建脚本：Node --experimental-strip-types 无法加载 `@/` 别名
 * （TESTING.md 已记录 226 处），所以要进 CI 的逻辑必须是无依赖的纯函数，
 * 用相对路径 import 源文件。
 */
import assert from "node:assert/strict";
import { imageUrl, imageThumbnailAlt } from "../src/lib/image-src.ts";

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

check("拼出 /sessions/image 三元组 URL", () => {
  const url = imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 2 });
  assert.equal(url, "/sessions/image?sessionId=s1&entryId=e1&partIndex=2");
});

check("特殊字符被 URL 编码", () => {
  const url = imageUrl({ sessionId: "a b&c", entryId: "e/1", partIndex: 0 });
  assert.ok(url.includes("sessionId=a%20b%26c"), url);
  assert.ok(url.includes("entryId=e%2F1"), url);
});

check("缺字段不抛错、返回空串（调用方据此隐藏 img）", () => {
  assert.equal(imageUrl({ sessionId: "", entryId: "e1", partIndex: 0 }), "");
  assert.equal(imageUrl({ sessionId: "s1", entryId: "", partIndex: 0 }), "");
});

check("alt 文案含序号", () => {
  assert.ok(imageThumbnailAlt(0).includes("1"));
  assert.ok(imageThumbnailAlt(3).includes("4"));
});

console.log(`\n=== image-src: ${passed}/4 通过 ===`);
