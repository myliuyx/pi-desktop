/**
 * image-src 纯函数检查 —— 2026-10-01 图片预览批次。
 *
 * 为什么单独建脚本：Node --experimental-strip-types 无法加载 `@/` 别名
 * （TESTING.md 已记录 226 处），所以要进 CI 的逻辑必须是无依赖的纯函数，
 * 用相对路径 import 源文件。
 *
 * 断言口径（2026-10-01 补强）：partIndex 闸门是 image-src.ts 里**唯一**的输入校验，
 * 也是 core `/sessions/image` 校验的对位物 —— 之前只锁了「缺字段」与「正常值」两个
 * 方向，下面 4 条 partIndex 边界（负数/小数/缺失/0 合法）专门覆盖它，防止闸门被删或
 * 被改成只挡一半。分母从 total 变量取，不写死数字。
 */
import assert from "node:assert/strict";
import { imageUrl, imageThumbnailAlt } from "../src/lib/image-src.ts";

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

check("partIndex 为负数（-1）被闸门挡下，返回空串", () => {
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1", partIndex: -1 }), "");
});

check("partIndex 为小数（1.5）被闸门挡下，返回空串", () => {
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 1.5 }), "");
});

check("partIndex 缺失（undefined）被闸门挡下，返回空串", () => {
  assert.equal(imageUrl({ sessionId: "s1", entryId: "e1" }), "");
});

check("partIndex 为 0 是合法下标，正常产出 URL（别被闸门误杀）", () => {
  const url = imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 0 });
  assert.equal(url, "/sessions/image?sessionId=s1&entryId=e1&partIndex=0");
});

check("带 token 时 URL 拼入 token=（<img> 无法带 Authorization 头）", () => {
  const url = imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 0 }, "tk-123");
  assert.ok(url.includes("token=tk-123"), url);
});

check("无 token / 空 token 时不拼 token 段（保持既有调用点逐字节兼容）", () => {
  const noArg = imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 0 });
  assert.equal(noArg.includes("token="), false, noArg);
  const empty = imageUrl({ sessionId: "s1", entryId: "e1", partIndex: 0 }, "");
  assert.equal(empty.includes("token="), false, empty);
});

check("孤立代理 sessionId 返回空串、不抛 URIError（Task 7 裸调无 try/catch）", () => {
  assert.equal(imageUrl({ sessionId: "\uD800", entryId: "e", partIndex: 0 }), "");
});

check("alt 文案全等：图片 1 / 图片 4（aria-label 契约，includes 会被「image 1」混过）", () => {
  assert.equal(imageThumbnailAlt(0), "图片 1");
  assert.equal(imageThumbnailAlt(3), "图片 4");
});

console.log(`\n=== image-src: ${passed}/${total} 通过 ===`);
