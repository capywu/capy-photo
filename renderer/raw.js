// RAW 解碼（LibRaw WebAssembly）與「相機原色」曲線計算
import LibRaw from '../node_modules/libraw-wasm/dist/index.js';
import { defaultBaseLUT, srgbBaseLUT } from './engine.js';

export const fileURL = (p) => 'app://file/' + encodeURIComponent(p);

const RAW_SETTINGS = (half) => ({
  halfSize: !!half, outputBps: 16, gamm: [1, 1], noAutoBright: true, useCameraWb: true,
  useCameraMatrix: 1, outputColor: 1, highlight: 2, userQual: half ? 0 : 3, userFlip: -1
});

let busy = Promise.resolve();
// 一次只解一張（WASM 記憶體大），依序排隊
export function decodeRaw(path, half) {
  const job = busy.then(async () => {
    const buf = new Uint8Array(await (await fetch(fileURL(path))).arrayBuffer());
    const raw = new LibRaw();
    try {
      await raw.open(buf, RAW_SETTINGS(half));
      const img = await raw.imageData();
      let data = img.data;
      if (!(data instanceof Uint16Array)) data = new Uint16Array(data.buffer || data);
      return { width: img.width, height: img.height, data };
    } finally { raw.dispose(); }
  });
  busy = job.catch(() => {});
  return job;
}

export async function decodeImage(path) {
  const blob = await (await fetch(fileURL(path))).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', imageOrientation: 'from-image' });
  const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, data: new Uint8Array(d.data.buffer), channels: 4, srgb: true };
}

// 將 RAW 線性亮度分佈與相機 JPEG 對齊 → 取得相機原廠的亮度與對比
export async function cameraLook(src, jpegBlob) {
  if (src.srgb) return { lut: srgbBaseLUT(), sat: 1 };
  if (!jpegBlob) return { lut: defaultBaseLUT(), sat: 1.15 };
  try {
    const bmp = await createImageBitmap(jpegBlob, { resizeWidth: 512, resizeQuality: 'medium' });
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const jd = x.getImageData(0, 0, bmp.width, bmp.height).data;
    const NJ = 256, hj = new Float64Array(NJ); let jChroma = 0, jn = 0;
    for (let i = 0; i < jd.length; i += 4) {
      const r = jd[i], g = jd[i + 1], b = jd[i + 2];
      hj[Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b))]++;
      jChroma += Math.max(r, g, b) - Math.min(r, g, b); jn++;
    }
    jChroma /= jn * 255;
    const NL = 1024, hl = new Float64Array(NL);
    const d = src.data, n = src.width * src.height;
    const step = Math.max(1, Math.floor(n / 250000));
    const samples = [];
    for (let p = 0; p < n; p += step) {
      const r = d[p * 3] / 65535, g = d[p * 3 + 1] / 65535, b = d[p * 3 + 2] / 65535;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const bin = Math.max(0, Math.min(NL - 1, Math.round((Math.log2(Math.max(l, 1e-6)) + 12) / 14 * (NL - 1))));
      hl[bin]++;
      if (samples.length < 20000 && (p / step) % 12 === 0) samples.push([r, g, b]);
    }
    const cdf = (h) => { const o = new Float64Array(h.length); let s = 0; const t = h.reduce((a, b) => a + b, 0); for (let i = 0; i < h.length; i++) { s += h[i]; o[i] = s / t; } return o; };
    const cl = cdf(hl), cj = cdf(hj);
    const inv = (q) => { // JPEG 的分位數 → 顯示值
      let i = 0; while (i < NJ - 1 && cj[i] < q) i++;
      const c0 = i ? cj[i - 1] : 0, c1 = cj[i]; const f = c1 > c0 ? (q - c0) / (c1 - c0) : 0;
      return Math.max(0, (i - 1 + f + 0.5) / 255);
    };
    let first = 0; while (first < NL && hl[first] === 0) first++;
    let last = NL - 1; while (last > 0 && hl[last] === 0) last--;
    const lut = new Float32Array(NL);
    for (let i = 0; i < NL; i++) {
      const q = Math.min(0.9995, Math.max(0.0005, cl[i] - hl[i] / (2 * hl.reduce((a, b) => a + b, 0))));
      lut[i] = inv(q);
    }
    // 資料範圍外：暗部線性延伸、亮部柔和延伸到 1
    const lin = (i) => Math.pow(2, i / (NL - 1) * 14 - 12);
    const lo = Math.min(first + 8, NL - 1), hi = Math.max(last - 8, 0);
    for (let i = 0; i < lo; i++) lut[i] = lut[lo] * Math.pow(lin(i) / lin(lo), 1 / 2.2);
    for (let i = hi + 1; i < NL; i++) { const t = (i - hi) / (NL - 1 - hi + 1e-6); lut[i] = lut[hi] + (1 - lut[hi]) * (1 - Math.pow(1 - Math.min(1, t * 3), 2)); }
    // 平滑 + 單調
    const sm = new Float32Array(NL);
    for (let i = 0; i < NL; i++) { let s = 0, w = 0; for (let k = -12; k <= 12; k++) { const j = Math.max(0, Math.min(NL - 1, i + k)); const wt = Math.exp(-k * k / 50); s += lut[j] * wt; w += wt; } sm[i] = s / w; }
    for (let i = 1; i < NL; i++) sm[i] = Math.max(sm[i], sm[i - 1]);
    for (let i = 0; i < NL; i++) sm[i] = Math.min(1, sm[i]);
    // 飽和度比較
    const look = (v) => sm[Math.max(0, Math.min(NL - 1, Math.round((Math.log2(Math.max(v, 1e-6)) + 12) / 14 * (NL - 1))))];
    let rc = 0; for (const [r, g, b] of samples) { const R = look(r), G = look(g), B = look(b); rc += Math.max(R, G, B) - Math.min(R, G, B); }
    rc /= Math.max(1, samples.length);
    const sat = Math.max(0.9, Math.min(1.6, rc > 0.01 ? jChroma / rc : 1.15));
    return { lut: sm, sat };
  } catch (err) {
    console.warn('cameraLook', err);
    return { lut: defaultBaseLUT(), sat: 1.15 };
  }
}
