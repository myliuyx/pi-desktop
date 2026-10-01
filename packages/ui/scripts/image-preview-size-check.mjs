/**
 * image-preview-size 纯函数检查 —— task-image-preview-fit.md（2026-10-01）。
 *
 * 面板随图走的全部规则在这里逐条对账（规格 §三.3）：不放大（D1）、宽/竖图贴边、
 * availH 双口径（90vh 与 −48 谁紧听谁的）、面板下限（2026-10-01 二次裁决后
 * 面板 = 图片显示盒，零内边距，下限即面板下限）、0 尺寸不炸、比例保持、
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

check("① 小图不放大（D1）：300×200 @1920×1080 → 面板=图片原尺寸", () => {
  assert.deepStrictEqual(computePreviewPanelSize(300, 200, 1920, 1080), {
    width: 300,
    height: 200,
  });
});

check("② 宽图贴边：4000×2000 @1000×800 → 宽=availW，等比降采样", () => {
  // availW=952、availH=min(752, 720)=720 → scale=952/4000 → 面板 952×476
  assert.deepStrictEqual(computePreviewPanelSize(4000, 2000, 1000, 800), {
    width: 952,
    height: 476,
  });
});

check("③ 竖图贴边：500×1600 @1000×800 → 高=availH，等比降采样", () => {
  // scale=720/1600=0.45 → 225×720；宽 225 < 下限 240 被钳到 240（规格书初稿
  // 手算 257 漏了这一钳，check 首跑抓出——行为以「面板下限」规则为准）
  assert.deepStrictEqual(computePreviewPanelSize(500, 1600, 1000, 800), {
    width: 240,
    height: 720,
  });
});

check("④ availH 双口径：90vh 与 −48 谁紧听谁（vh=800 取 90vh，vh=400 取 −48）", () => {
  // vh=800：availH=720（90vh 更紧）→ 2000×1000 scale=0.476 → 面板 952×476
  const tall800 = computePreviewPanelSize(2000, 1000, 1000, 800);
  assert.equal(tall800.height, 476);
  // vh=400：availH=min(352, 360)=352（−48 更紧）→ scale=0.352 → 面板 704×352
  const tall400 = computePreviewPanelSize(2000, 1000, 1000, 400);
  assert.equal(tall400.height, 352);
});

check("⑤ 面板下限：1×1 @1920×1080 → 240×180，不出荒诞小板", () => {
  assert.deepStrictEqual(computePreviewPanelSize(1, 1, 1920, 1080), {
    width: 240,
    height: 180,
  });
});

check("⑥ 0/负尺寸不炸：scale=1 落最小面板，无 NaN/Infinity", () => {
  for (const [w, h] of [[0, 0], [0, 500], [500, 0], [-5, 300]]) {
    const size = computePreviewPanelSize(w, h, 1920, 1080);
    assert.ok(Number.isFinite(size.width) && Number.isFinite(size.height), `${w}×${h}`);
    assert.ok(size.width > 0 && size.height > 0, `${w}×${h}`);
  }
  assert.deepStrictEqual(computePreviewPanelSize(0, 0, 1920, 1080), {
    width: 240,
    height: 180,
  });
});

check("⑦ 比例保持性质：降采样后面板宽高比 ≈ 自然宽高比（<1.5%，round 容忍）", () => {
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
    // 只对未被下限钳住的样本判比例（钳住本就该变形）
    if (panel.width <= 240 || panel.height <= 180) continue;
    const naturalRatio = nw / nh;
    const panelRatio = panel.width / panel.height;
    const drift = Math.abs(panelRatio - naturalRatio) / naturalRatio;
    assert.ok(
      drift < 0.015,
      `${nw}×${nh}@${vw}×${vh}: 面板 ${panel.width}×${panel.height} 比例漂移 ${(drift * 100).toFixed(2)}%`,
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
        // 理论界：max(avail, 下限)；视口 ≥ 320×240 时恒 ≤ 视口
        assert.ok(width <= vw, `${nw}×${nh}@${vw}×${vh}: 宽 ${width} > ${vw}`);
        assert.ok(height <= vh, `${nw}×${nh}@${vw}×${vh}: 高 ${height} > ${vh}`);
      }
    }
  }
});

check("⑨ 预置尺寸常量在位（加载/失败态面板，文案自带 p-6）", () => {
  assert.deepStrictEqual(IMAGE_PREVIEW_PROVISIONAL, { width: 320, height: 220 });
});

console.log(`\n== image-preview-size：${passed}/${total} ==`);
if (passed !== total) process.exit(1);
