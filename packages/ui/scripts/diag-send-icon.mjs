/**
 * diag-send-icon —— 发送按钮纸飞机图标「看着没居中」取证。
 *
 * 两层测量：
 * ① 几何层：svg 元素中心 vs 按钮中心（flex 居中是否真的生效）；
 * ② 像素层：8x 放大截图 → 解码 PNG → 圆内（排除边框环）accent 墨迹的
 *    包围盒中心 + 加权质心 vs 圆心 —— 区分「几何没居中」与「字形视觉偏重」。
 *
 * 已知背景：lucide v0.469 Send 路径墨迹 bbox 近似居中，但三角形体质心
 * 偏右上（估算 viewBox 单位 (+1.9, -1.7) → 14px 下 (+1.1, -1.0) px）。
 */
import { inflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { withBrowser } from "./cdp.mjs";

/* ---------- 最小 PNG 解码（8-bit RGBA/RGB/灰度 + 调色板兜底） ---------- */
function decodePng(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error("非 PNG 文件");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} 不支持`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x * channels, di = (y * w + x) * 4;
      if (colorType === 2) { out[di] = cur[si]; out[di+1] = cur[si+1]; out[di+2] = cur[si+2]; out[di+3] = 255; }
      else if (colorType === 6) { out[di] = cur[si]; out[di+1] = cur[si+1]; out[di+2] = cur[si+2]; out[di+3] = cur[si+3]; }
      else if (colorType === 0) { out[di] = out[di+1] = out[di+2] = cur[si]; out[di+3] = 255; }
      else if (colorType === 4) { out[di] = out[di+1] = out[di+2] = cur[si]; out[di+3] = cur[si+1]; }
      else if (colorType === 3) throw new Error("调色板暂不支持");
    }
    prev = cur;
  }
  return { w, h, data: out };
}

await withBrowser(
  { port: 9347, origin: process.env.PROBE_ORIGIN ?? "http://127.0.0.1:5180", evidencePath: "_diag-send-icon.json" },
  async (ctx) => {
    await ctx.open("/");
    await ctx.sleep(400);

    // ① 几何层
    const geo = await ctx.cdp.eval(`(() => {
      const btn = document.querySelector('[data-testid="composer-send"]');
      const svg = btn.querySelector('svg');
      const b = btn.getBoundingClientRect(), s = svg.getBoundingClientRect();
      return {
        btn: { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width/2, cy: b.y + b.height/2 },
        svg: { x: s.x, y: s.y, w: s.width, h: s.height, cx: s.x + s.width/2, cy: s.y + s.height/2 },
        dxCx: +(s.x + s.width/2 - (b.x + b.width/2)).toFixed(2),
        dyCy: +(s.y + s.height/2 - (b.y + b.height/2)).toFixed(2),
      };
    })()`);
    ctx.record("几何居中（svg vs button）", geo);

    // ② 像素层：clip 8x 截图
    const pad = 2, scale = 8;
    const clip = { x: geo.btn.x - pad, y: geo.btn.y - pad, width: geo.btn.w + pad*2, height: geo.btn.h + pad*2, scale };
    const shot = await ctx.cdp.send("Page.captureScreenshot", { format: "png", clip });
    const pngPath = "F:/DevelopWork/WorkBuddyWork/Tiktok_auto/.workbuddy/shots/send-icon-8x.png";
    writeFileSync(pngPath, Buffer.from(shot.data, "base64"), "base64");
    const img = decodePng(Buffer.from(shot.data, "base64"));

    // 圆内扫描（排除边框环）：以 clip 中心为圆心，半径 ≤ (btn.w/2 - 1.5) CSS px
    const cx = (clip.width / 2) * scale, cy = (clip.height / 2) * scale;
    const rMax = (geo.btn.w / 2 - 1.5) * scale;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, sumX = 0, sumY = 0, n = 0;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const dxp = x - cx, dyp = y - cy;
        if (dxp*dxp + dyp*dyp > rMax*rMax) continue;
        const i = (y * img.w + x) * 4, R = img.data[i], G = img.data[i+1], B = img.data[i+2];
        // accent 墨迹：蓝主导（B 明显大于 R），背景 accent-soft(238,242,254) 与白底排除
        const isInk = B > 120 && B - R > 40 && G < 200;
        if (isInk) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          sumX += x; sumY += y; n++;
        }
      }
    }
    const px = {
      inkPixels: n,
      bboxCenter: { dx: +(((minX + maxX) / 2 - cx) / scale).toFixed(2), dy: +(((minY + maxY) / 2 - cy) / scale).toFixed(2) },
      centroid: { dx: +((sumX / n - cx) / scale).toFixed(2), dy: +((sumY / n - cy) / scale).toFixed(2) },
      bboxCss: { left: +((minX - cx) / scale).toFixed(2), right: +((maxX - cx) / scale).toFixed(2),
                 top: +((minY - cy) / scale).toFixed(2), bottom: +((maxY - cy) / scale).toFixed(2) },
      note: "dx 右正 / dy 下正；正值为墨迹相对圆心的偏移",
    };
    ctx.record("像素墨迹（8x，排除边框环）", px);
    ctx.record("放大截图", { path: pngPath });
    ctx.save("_diag-send-icon.json");
  },
);
