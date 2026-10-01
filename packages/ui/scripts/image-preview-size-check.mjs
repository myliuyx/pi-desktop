/**
 * image-preview-size 纯函数检查 —— task-image-preview-fit.md（2026-10-01）。
 *
 * 面板随图走的全部规则在这里逐条对账（规格 §三.3）：不放大（D1）、宽/竖图贴边、
 * availH 双口径（90vh 与 −48 谁紧听谁的）、最小内容盒、0 尺寸不炸、比例保持、
 * 永不超视口。这层 check 是实现方自证的第一道闸；面板几何的端到端判据
 * （C9/C10）在验收方探针里，实现方不写（probe-image-preview 文件头铁律）。
 *
 * 运行：npm run check:image-preview-size
 */
import assert from "node:assert/strict";
import {
  computePreviewPanelSize,
  IMAGE_PREVIEW_PROVISIONAL,
} from "../src/lib/image-preview-size.ts";

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

check("① 小图不放大（D1）：300×200 @1920×1080 → 原尺寸贴图 + p-4×2", () => {
  assert.deepStrictEqual(computePreviewPanelSize(300, 200, 1920, 1080), {
    width: 332,
    height: 232,
  });
});

check("② 宽图贴边：4000×2000 @1000×800 → 宽=内容可用+32，等比降采样", () => {
  // 内容可用 = 920×688（availH 已扣面板 padding：min(752,720)−32）→ scale=920/4000
  // → 内容 920×460
  assert.deepStrictEqual(computePreviewPanelSize(4000, 2000, 1000, 800), {
    width: 952,
    height: 492,
  });
});

check("③ 竖图贴边：500×1600 @1000×800 → 高=内容可用+32，等比降采样", () => {
  // scale=688/1600=0.43 → 内容 215×688；宽 215 < MIN 240 被最小盒钳到 240（规格书初稿
  // 手算 257 漏了这一钳，check 首跑抓出——行为以「最小内容盒」规则为准）
  assert.deepStrictEqual(computePreviewPanelSize(500, 1600, 1000, 800), {
    width: 272,
    height: 720,
  });
});

check("④ availH 双口径：90vh 与 −48 谁紧听谁（vh=800 取 90vh，vh=400 取 −48）", () => {
  // vh=800：内容可用高 = min(752,720)−32 = 688（90vh 更紧）
  const tall800 = computePreviewPanelSize(2000, 1000, 1000, 800);
  assert.equal(tall800.height, 492); // 内容高 460 = 1000×(920/2000)
  // vh=400：内容可用高 = min(352,360)−32 = 320（−48 更紧）
  const tall400 = computePreviewPanelSize(2000, 1000, 1000, 400);
  assert.equal(tall400.height, 352); // 内容高 320 = 1000×0.32
});

check("⑤ 最小内容盒：1×1 @1920×1080 → 240×180 内容，不出荒诞小板", () => {
  assert.deepStrictEqual(computePreviewPanelSize(1, 1, 1920, 1080), {
    width: 272,
    height: 212,
  });
});

check("⑥ 0/负尺寸不炸：scale=1 落最小面板，无 NaN/Infinity", () => {
  for (const [w, h] of [[0, 0], [0, 500], [500, 0], [-5, 300]]) {
    const size = computePreviewPanelSize(w, h, 1920, 1080);
    assert.ok(Number.isFinite(size.width) && Number.isFinite(size.height), `${w}×${h}`);
    assert.ok(size.width > 0 && size.height > 0, `${w}×${h}`);
  }
  assert.deepStrictEqual(computePreviewPanelSize(0, 0, 1920, 1080), {
    width: 272,
    height: 212,
  });
});

check("⑦ 比例保持性质：降采样后内容盒宽高比 ≈ 自然宽高比（<1.5%，round 容忍）", () => {
  const samples = [
    [4000, 2000, 1000, 800],
    [500, 1600, 1000, 800],
    [1920, 1080, 800, 600],
    [3024, 4032, 1366, 768],
    [1080, 2400, 1200, 900],
    [7680, 4320, 1920, 1080],
  ];
  for (const [nw, nh, vw, vh] of samples) {
    const panel = computePreviewPanelSize(nw, nh, vw, vh);
    const cw = panel.width - 32;
    const ch = panel.height - 32;
    // 只对未被最小盒钳住的样本判比例（钳住本就该变形）
    if (cw <= 240 || ch <= 180) continue;
    const naturalRatio = nw / nh;
    const contentRatio = cw / ch;
    const drift = Math.abs(contentRatio - naturalRatio) / naturalRatio;
    assert.ok(
      drift < 0.015,
      `${nw}×${nh}@${vw}×${vh}: 内容 ${cw}×${ch} 比例漂移 ${(drift * 100).toFixed(2)}%`,
    );
  }
});

check("⑧ 永不超视口：自然尺寸 1..20000 全域 × 常见视口，面板两维 ≤ 视口", () => {
  const viewports = [
    [1920, 1080],
    [1366, 768],
    [1000, 800],
    [800, 600],
    [500, 400],
    [320, 240],
  ];
  const naturals = [1, 2, 50, 320, 640, 1062, 1920, 4000, 8000, 20000];
  for (const [vw, vh] of viewports) {
    for (const nw of naturals) {
      for (const nh of naturals) {
        const { width, height } = computePreviewPanelSize(nw, nh, vw, vh);
        // 理论界：max(avail+32, MIN+32)；视口 ≥ 320×240 时恒 ≤ 视口
        assert.ok(width <= vw, `${nw}×${nh}@${vw}×${vh}: 宽 ${width} > ${vw}`);
        assert.ok(height <= vh, `${nw}×${nh}@${vw}×${vh}: 高 ${height} > ${vh}`);
      }
    }
  }
});

check("⑨ 预置尺寸常量在位（加载/失败态面板，含 padding）", () => {
  assert.deepStrictEqual(IMAGE_PREVIEW_PROVISIONAL, { width: 320, height: 220 });
});

console.log(`\n== image-preview-size：${passed}/${total} ==`);
if (passed !== total) process.exit(1);
