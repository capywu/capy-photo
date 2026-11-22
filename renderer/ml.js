// 神經網路模型（ONNX Runtime）：Depth Anything V2 深度估計、NAFNet 去模糊
// 有 WebGPU 用顯示卡；沒有就用 CPU（WebAssembly，多執行緒）
import * as ort from '../node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = 'app://bundle/node_modules/onnxruntime-web/dist/';
ort.env.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
ort.env.logLevel = 'fatal';

const sessions = {};
export let backend = 'wasm';
async function session(name) {
  if (sessions[name]) return sessions[name];
  sessions[name] = (async () => {
    const buf = await (await fetch(`app://bundle/models/${name}`)).arrayBuffer();
    const eps = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    try { const s = await ort.InferenceSession.create(buf, { executionProviders: eps, graphOptimizationLevel: 'all', logSeverityLevel: 3 }); backend = navigator.gpu ? 'webgpu' : 'wasm'; return s; }
    catch (err) { console.warn('webgpu 失敗，改用 CPU', err); backend = 'wasm'; return ort.InferenceSession.create(buf, { executionProviders: ['wasm'], logSeverityLevel: 3 }); }
  })();
  return sessions[name];
}

// ── 深度估計：回傳 W×H 的 Float32（1＝最近，0＝最遠）──
export async function estimateDepth(imgData, W, H) {
  const s = await session('depth-anything-v2-small.onnx');
  const iw = imgData.width, ih = imgData.height;
  const sc = 518 / Math.max(iw, ih);
  const w = Math.max(14, Math.round(iw * sc / 14) * 14), h = Math.max(14, Math.round(ih * sc / 14) * 14);
  const c = new OffscreenCanvas(iw, ih); c.getContext('2d').putImageData(imgData, 0, 0);
  const r = new OffscreenCanvas(w, h); const rx = r.getContext('2d', { willReadFrequently: true }); rx.imageSmoothingQuality = 'high'; rx.drawImage(c, 0, 0, w, h);
  const d = rx.getImageData(0, 0, w, h).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const t = new Float32Array(3 * w * h);
  for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) t[k * w * h + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
  const out = await s.run({ image: new ort.Tensor('float32', t, [1, 3, h, w]) });
  const dep = out.depth.data; const dw = out.depth.dims[2], dh = out.depth.dims[1];
  let mn = Infinity, mx = -Infinity; for (const v of dep) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const res = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = (x + 0.5) / W * dw - 0.5, fy = (y + 0.5) / H * dh - 0.5;
    const x0 = Math.max(0, Math.min(dw - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(dh - 1, Math.floor(fy))), x1 = Math.min(dw - 1, x0 + 1), y1 = Math.min(dh - 1, y0 + 1);
    const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
    const v = (dep[y0 * dw + x0] * (1 - ax) + dep[y0 * dw + x1] * ax) * (1 - ay) + (dep[y1 * dw + x0] * (1 - ax) + dep[y1 * dw + x1] * ax) * ay;
    res[y * W + x] = (v - mn) / (mx - mn + 1e-6);
  }
  return res;
}

// ── 臉部解析（BiSeNet，CelebAMask 19 類）：回傳整張圖的頭髮機率 ──
// box: 臉的範圍 [x0,y0,x1,y1]（像素），會放大 2.6 倍並往下移，涵蓋長髮
export async function parseHair(imgData, W, H, box, out) {
  const s = await session('face-parsing.onnx');
  const fw = box[2] - box[0], fh = box[3] - box[1]; const sz = Math.max(fw, fh) * 2.6;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2 + sz * 0.12; const X0 = cx - sz / 2, Y0 = cy - sz / 2;
  const N = 512; const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(imgData, 0, 0);
  const r = new OffscreenCanvas(N, N); const rx = r.getContext('2d', { willReadFrequently: true }); rx.fillStyle = '#000'; rx.fillRect(0, 0, N, N); rx.imageSmoothingQuality = 'high';
  rx.drawImage(c, X0, Y0, sz, sz, 0, 0, N, N);
  const d = rx.getImageData(0, 0, N, N).data; const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const t = new Float32Array(3 * N * N);
  for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) t[k * N * N + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
  const res = await s.run({ input: new ort.Tensor('float32', t, [1, 3, N, N]) });
  const o = res.output.data; const C = res.output.dims[1], oh = res.output.dims[2], ow = res.output.dims[3];
  // softmax 取頭髮（17）機率
  const ph = new Float32Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) { let mx = -1e9; for (let k = 0; k < C; k++) mx = Math.max(mx, o[k * ow * oh + i]); let sum = 0; for (let k = 0; k < C; k++) sum += Math.exp(o[k * ow * oh + i] - mx); ph[i] = Math.exp(o[17 * ow * oh + i] - mx) / sum; }
  const x0 = Math.max(0, Math.floor(X0)), y0 = Math.max(0, Math.floor(Y0)), x1 = Math.min(W, Math.ceil(X0 + sz)), y1 = Math.min(H, Math.ceil(Y0 + sz));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const fx = (x + 0.5 - X0) / sz * ow - 0.5, fy = (y + 0.5 - Y0) / sz * oh - 0.5;
    const a = Math.max(0, Math.min(ow - 1, Math.floor(fx))), b = Math.max(0, Math.min(oh - 1, Math.floor(fy))), a1 = Math.min(ow - 1, a + 1), b1 = Math.min(oh - 1, b + 1);
    const ax = Math.min(1, Math.max(0, fx - a)), ay = Math.min(1, Math.max(0, fy - b));
    const v = (ph[b * ow + a] * (1 - ax) + ph[b * ow + a1] * ax) * (1 - ay) + (ph[b1 * ow + a] * (1 - ax) + ph[b1 * ow + a1] * ax) * ay;
    const i = y * W + x; if (v > out[i]) out[i] = v;
  }
  return out;
}

// ── 人物分割（U²-Net 輕量版 silueta）：回傳 W×H 機率 0..1，手臂、衣服、頭髮邊緣比 selfie 模型完整 ──
export async function segPerson(imgData, W, H) {
  const s = await session('person-seg.onnx'); const N = 320;
  const c = new OffscreenCanvas(imgData.width, imgData.height); c.getContext('2d').putImageData(imgData, 0, 0);
  const r = new OffscreenCanvas(N, N); const rx = r.getContext('2d', { willReadFrequently: true }); rx.imageSmoothingQuality = 'high'; rx.drawImage(c, 0, 0, N, N);
  const d = rx.getImageData(0, 0, N, N).data; let mx = 1; for (let i = 0; i < N * N * 4; i++) if ((i & 3) !== 3 && d[i] > mx) mx = d[i];
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]; const t = new Float32Array(3 * N * N);
  for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) t[k * N * N + i] = (d[i * 4 + k] / mx - mean[k]) / std[k];
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, N, N]) });
  const o = out[s.outputNames[0]].data; let mn = Infinity, mxo = -Infinity; for (let i = 0; i < N * N; i++) { if (o[i] < mn) mn = o[i]; if (o[i] > mxo) mxo = o[i]; }
  const res = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fx = (x + 0.5) / W * N - 0.5, fy = (y + 0.5) / H * N - 0.5; const a = Math.max(0, Math.min(N - 1, Math.floor(fx))), b = Math.max(0, Math.min(N - 1, Math.floor(fy))), a1 = Math.min(N - 1, a + 1), b1 = Math.min(N - 1, b + 1);
    const ax = Math.min(1, Math.max(0, fx - a)), ay = Math.min(1, Math.max(0, fy - b));
    const v = (o[b * N + a] * (1 - ax) + o[b * N + a1] * ax) * (1 - ay) + (o[b1 * N + a] * (1 - ax) + o[b1 * N + a1] * ax) * ay;
    res[y * W + x] = (v - mn) / (mxo - mn + 1e-6);
  }
  return res;
}

// ── 生成式 AI 補圖（MI-GAN，以 Places2 大量場景訓練）：crop 為 512×512 的 RGBA，hole 為 512×512（1＝要補的地方）──
export async function inpaintAI(crop, hole) {
  const s = await session('migan-inpaint.onnx'); const N = 512; const t = new Float32Array(4 * N * N);
  for (let i = 0; i < N * N; i++) { const h = hole[i] > 0.5 ? 1 : 0; t[i] = 0.5 - h; for (let k = 0; k < 3; k++) t[(k + 1) * N * N + i] = (crop.data[i * 4 + k] / 127.5 - 1) * (1 - h); }
  const o = (await s.run({ input: new ort.Tensor('float32', t, [1, 4, N, N]) })).output.data; const out = new ImageData(N, N);
  for (let i = 0; i < N * N; i++) { for (let k = 0; k < 3; k++) out.data[i * 4 + k] = Math.max(0, Math.min(255, (o[k * N * N + i] * 0.5 + 0.5) * 255)); out.data[i * 4 + 3] = 255; }
  return out;
}

// ── AI 降噪（FFDNet，KAIR 以大量真實照片訓練；sigma 控制強度）──
export async function denoiseAI(src, sigma, onProgress, shouldStop) {
  const s = await session('ffdnet-denoise.onnx');
  return tiledRun(src, async (inp, tw, th) => (await s.run({ input: new ort.Tensor('float32', inp, [1, 3, th, tw]), sigma: new ort.Tensor('float32', new Float32Array([sigma]), [1, 1, 1, 1]) })).output.data, 1, onProgress, shouldStop, true);
}
// 通用分塊執行：src 為線性 16-bit 或 8-bit；模型以 sRGB 0..1 輸入輸出
async function tiledRun(src, runTile, amount, onProgress, shouldStop, even) {
  const W = src.width, H = src.height, ch = src.channels || 3, lin = src.data instanceof Uint16Array;
  const sc = lin ? 1 / 65535 : 1 / 255; const toS = (v) => lin ? Math.pow(Math.max(0, v), 1 / 2.2) : v; const toL = (v) => lin ? Math.pow(Math.max(0, v), 2.2) : v;
  const T = backend === 'webgpu' ? 512 : 384, O = 32, step = T - O * 2;
  const out = new Float32Array(W * H * 3), wsum = new Float32Array(W * H);
  const tiles = []; for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) tiles.push([x, y]);
  let n = 0;
  for (const [tx, ty] of tiles) {
    if (shouldStop && shouldStop()) throw new Error('已取消');
    let tw = Math.min(T, W), th = Math.min(T, H); if (even) { tw -= tw % 2; th -= th % 2; }
    const x0 = Math.max(0, Math.min(W - tw, tx - O)), y0 = Math.max(0, Math.min(H - th, ty - O));
    const inp = new Float32Array(3 * tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const j = ((y0 + y) * W + x0 + x) * ch; for (let k = 0; k < 3; k++) inp[k * tw * th + y * tw + x] = toS(src.data[j + k] * sc); }
    const o = await runTile(inp, tw, th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const wx = Math.min(1, (Math.min(x, tw - 1 - x) + 1) / O), wy = Math.min(1, (Math.min(y, th - 1 - y) + 1) / O);
      const edgeX = (x0 === 0 && x < O) || (x0 + tw >= W && x >= tw - O), edgeY = (y0 === 0 && y < O) || (y0 + th >= H && y >= th - O);
      const wgt = (edgeX ? 1 : wx) * (edgeY ? 1 : wy) + 1e-4; const i = (y0 + y) * W + x0 + x;
      for (let k = 0; k < 3; k++) out[i * 3 + k] += o[k * tw * th + y * tw + x] * wgt; wsum[i] += wgt;
    }
    n++; onProgress && onProgress(n / tiles.length); await new Promise(r2 => setTimeout(r2, 0));
  }
  const res = { ...src, data: src.data.slice() }; const max = lin ? 65535 : 255;
  for (let i = 0; i < W * H; i++) { if (!wsum[i]) continue; for (let k = 0; k < 3; k++) { const orig = src.data[i * ch + k] * sc; const v = toL(Math.min(1, Math.max(0, out[i * 3 + k] / wsum[i]))); res.data[i * ch + k] = Math.round(Math.min(1, Math.max(0, orig + (v - orig) * amount)) * max); } }
  return res;
}
// ── AI 暗部提亮（Zero-DCE，以 SICE 多曝光資料訓練）：回傳低解析度的亮度增益圖 ──
export async function lowLightGain(imgData) {
  const s = await session('zerodce.onnx'); const W0 = imgData.width, H0 = imgData.height; const sc = Math.min(1, 512 / Math.max(W0, H0)); const w = Math.max(8, Math.round(W0 * sc)), h = Math.max(8, Math.round(H0 * sc));
  const c = new OffscreenCanvas(W0, H0); c.getContext('2d').putImageData(imgData, 0, 0); const r = new OffscreenCanvas(w, h); const rx = r.getContext('2d', { willReadFrequently: true }); rx.drawImage(c, 0, 0, w, h);
  const d = rx.getImageData(0, 0, w, h).data; const t = new Float32Array(3 * w * h); for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) t[k * w * h + i] = d[i * 4 + k] / 255;
  const o = (await s.run({ input: new ort.Tensor('float32', t, [1, 3, h, w]) })).output.data;
  const g = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { const y0 = 0.299 * t[i] + 0.587 * t[w * h + i] + 0.114 * t[2 * w * h + i]; const y1 = 0.299 * o[i] + 0.587 * o[w * h + i] + 0.114 * o[2 * w * h + i]; const gain = Math.min(4, Math.max(1, (y1 + 0.01) / (y0 + 0.01))); g[i * 4] = Math.round((gain - 1) / 3 * 255); g[i * 4 + 3] = 255; }
  // 平滑，避免光暈
  const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d', { willReadFrequently: true }); cx.putImageData(new ImageData(new Uint8ClampedArray(g), w, h), 0, 0); const cv2 = new OffscreenCanvas(w, h); const c2 = cv2.getContext('2d', { willReadFrequently: true }); c2.filter = 'blur(3px)'; c2.drawImage(cv, 0, 0);
  return { w, h, data: new Uint8Array(c2.getImageData(0, 0, w, h).data.buffer) };
}
// ── AI 專業調色（Image-Adaptive 3D LUT，以 MIT-Adobe FiveK 專業修圖師成品訓練）：回傳三個基底 LUT 的權重 ──
let fivekLuts = null;
export async function fivekWeights(imgData) {
  const s = await session('fivek-classifier.onnx'); const N = 256;
  const c = new OffscreenCanvas(imgData.width, imgData.height); c.getContext('2d').putImageData(imgData, 0, 0); const r = new OffscreenCanvas(N, N); const rx = r.getContext('2d', { willReadFrequently: true }); rx.drawImage(c, 0, 0, N, N);
  const d = rx.getImageData(0, 0, N, N).data; const t = new Float32Array(3 * N * N); for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) t[k * N * N + i] = d[i * 4 + k] / 255;
  const o = (await s.run({ input: new ort.Tensor('float32', t, [1, 3, N, N]) })).output.data; return [o[0], o[1], o[2]];
}
export async function fivekLUT(w) {
  if (!fivekLuts) fivekLuts = new Float32Array(await (await fetch('app://bundle/models/fivek-luts.bin')).arrayBuffer());
  const n = 33 * 33 * 33, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) { const v = w[0] * fivekLuts[c * n + i] + w[1] * fivekLuts[3 * n + c * n + i] + w[2] * fivekLuts[6 * n + c * n + i]; out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255))); } out[i * 4 + 3] = 255; }
  return out;   // 排列：r 最快、再 g、再 b（與 .cube 相同）
}
// ── AI 放大（Real-ESRGAN 精簡版 ×4）：輸入／輸出 ImageData ──
export async function upscaleAI(img, scale, onProgress) {
  const s = await session('esrgan-x4.onnx'); const W = img.width, H = img.height, d = img.data; const T = backend === 'webgpu' ? 256 : 160, O = 12;
  const OW = W * 4, OH = H * 4; const out = new Float32Array(OW * OH * 3), ws = new Float32Array(OW * OH);
  const tiles = []; for (let y = 0; y < H; y += T - O * 2) for (let x = 0; x < W; x += T - O * 2) tiles.push([x, y]); let n = 0;
  for (const [tx, ty] of tiles) {
    const tw = Math.min(T, W), th = Math.min(T, H); const x0 = Math.max(0, Math.min(W - tw, tx - O)), y0 = Math.max(0, Math.min(H - th, ty - O));
    const inp = new Float32Array(3 * tw * th); for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const j = ((y0 + y) * W + x0 + x) * 4; for (let k = 0; k < 3; k++) inp[k * tw * th + y * tw + x] = d[j + k] / 255; }
    const o = (await s.run({ input: new ort.Tensor('float32', inp, [1, 3, th, tw]) })).output.data; const ow = tw * 4, oh = th * 4, OO = O * 4;
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { const wx = Math.min(1, (Math.min(x, ow - 1 - x) + 1) / OO), wy = Math.min(1, (Math.min(y, oh - 1 - y) + 1) / OO);
      const ex = (x0 === 0 && x < OO) || (x0 + tw >= W && x >= ow - OO), ey = (y0 === 0 && y < OO) || (y0 + th >= H && y >= oh - OO); const wg = (ex ? 1 : wx) * (ey ? 1 : wy) + 1e-4; const i = (y0 * 4 + y) * OW + x0 * 4 + x;
      for (let k = 0; k < 3; k++) out[i * 3 + k] += o[k * ow * oh + y * ow + x] * wg; ws[i] += wg; }
    n++; onProgress && onProgress(n / tiles.length); await new Promise(r2 => setTimeout(r2, 0));
  }
  const big = new ImageData(OW, OH); for (let i = 0; i < OW * OH; i++) { for (let k = 0; k < 3; k++) big.data[i * 4 + k] = Math.max(0, Math.min(255, out[i * 3 + k] / ws[i] * 255)); big.data[i * 4 + 3] = 255; }
  if (scale === 4) return big;
  const c = new OffscreenCanvas(OW, OH); c.getContext('2d').putImageData(big, 0, 0); const r = new OffscreenCanvas(W * scale, H * scale); const rx = r.getContext('2d'); rx.imageSmoothingQuality = 'high'; rx.drawImage(c, 0, 0, W * scale, H * scale); return rx.getImageData(0, 0, W * scale, H * scale);
}

// ── AI 去模糊（NAFNet）：分塊處理整張來源，回傳新的來源資料 ──
// src: { width, height, data: Uint16Array(線性 RGB) | Uint8Array(sRGB, channels) }
export async function deblurAI(src, amount, onProgress, shouldStop) {
  const s = await session('nafnet-deblur.onnx');
  const W = src.width, H = src.height, ch = src.channels || 3, lin = src.data instanceof Uint16Array;
  const sc = lin ? 1 / 65535 : 1 / 255;
  const toS = (v) => lin ? Math.pow(Math.max(0, v), 1 / 2.2) : v;      // 線性 → 感知（模型以一般照片訓練）
  const toL = (v) => lin ? Math.pow(Math.max(0, v), 2.2) : v;
  const T = backend === 'webgpu' ? 512 : 384, O = 32, step = T - O * 2;
  const out = new Float32Array(W * H * 3), wsum = new Float32Array(W * H);
  const tiles = []; for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) tiles.push([x, y]);
  let n = 0;
  for (const [tx, ty] of tiles) {
    if (shouldStop && shouldStop()) throw new Error('已取消');
    const x0 = Math.max(0, Math.min(W - T, tx - O)), y0 = Math.max(0, Math.min(H - T, ty - O));
    const tw = Math.min(T, W), th = Math.min(T, H);
    const inp = new Float32Array(3 * tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const j = ((y0 + y) * W + x0 + x) * ch; for (let k = 0; k < 3; k++) inp[k * tw * th + y * tw + x] = toS(src.data[j + k] * sc); }
    const r = await s.run({ lq: new ort.Tensor('float32', inp, [1, 3, th, tw]) });
    const o = r.output.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      // 邊緣羽化，避免拼接痕跡
      const wx = Math.min(1, (Math.min(x, tw - 1 - x) + 1) / O), wy = Math.min(1, (Math.min(y, th - 1 - y) + 1) / O);
      const edgeX = (x0 === 0 && x < O) || (x0 + tw >= W && x >= tw - O), edgeY = (y0 === 0 && y < O) || (y0 + th >= H && y >= th - O);
      const wgt = (edgeX ? 1 : wx) * (edgeY ? 1 : wy) + 1e-4;
      const i = (y0 + y) * W + x0 + x;
      for (let k = 0; k < 3; k++) out[i * 3 + k] += o[k * tw * th + y * tw + x] * wgt;
      wsum[i] += wgt;
    }
    n++; onProgress && onProgress(n / tiles.length);
    await new Promise(r2 => setTimeout(r2, 0));
  }
  const res = { ...src, data: src.data.slice() };
  const max = lin ? 65535 : 255;
  for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) {
    const orig = src.data[i * ch + k] * sc; const v = toL(Math.min(1, Math.max(0, out[i * 3 + k] / wsum[i])));
    res.data[i * ch + k] = Math.round(Math.min(1, Math.max(0, orig + (v - orig) * amount)) * max);
  }
  return res;
}
