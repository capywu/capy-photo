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
