// AI：人臉偵測、臉部網格、閉眼判斷、人像分割，以及修圖遮罩與液化控制點
import { Human } from '../node_modules/@vladmandic/human/dist/human.esm.js';

let human = null, loading = null;
export async function initAI() {
  if (human) return human;
  if (loading) return loading;
  loading = (async () => {
    const h = new Human({
      backend: 'webgl', modelBasePath: 'app://bundle/models/', debug: false, async: true, warmup: 'none', cacheSensitivity: 0,
      filter: { enabled: false },
      face: {
        enabled: true,
        detector: { modelPath: 'blazeface.json', rotation: true, maxDetected: 12, minConfidence: 0.35, minSize: 0, iouThreshold: 0.3, return: false },
        mesh: { enabled: true, modelPath: 'facemesh.json' },
        iris: { enabled: true, modelPath: 'iris.json' },
        attention: { enabled: false }, emotion: { enabled: false }, description: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false }, gear: { enabled: false }
      },
      body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false },
      segmentation: { enabled: false, modelPath: 'selfie.json' }
    });
    await h.load();
    human = h; return h;
  })();
  return loading;
}

// 臉部網格索引（MediaPipe 468 點）
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const L_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const R_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const L_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133];
const R_LOWER = [263, 249, 390, 373, 374, 380, 381, 382, 362];
const L_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const R_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const NOSTRIL = [98, 97, 2, 326, 327, 294, 278, 344, 440, 275, 4, 45, 220, 115, 48, 64];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function ear(m, up, low, l, r) { let v = 0; for (let i = 0; i < up.length; i++) v += dist(m[up[i]], m[low[i]]); return v / (up.length * dist(m[l], m[r]) + 1e-6); }
export function eyeOpenness(mesh) {
  const le = ear(mesh, [159, 158, 160], [145, 153, 144], 33, 133);
  const re = ear(mesh, [386, 385, 387], [374, 380, 373], 362, 263);
  return [le, re];
}

// 笑容：嘴角上揚、嘴寬、露齒
export function smileScore(m) {
  const fw = dist(m[234], m[454]), fh = dist(m[10], m[152]);
  const down = norm([m[152][0] - m[10][0], m[152][1] - m[10][1]]);
  const mid = [(m[13][0] + m[14][0]) / 2, (m[13][1] + m[14][1]) / 2], corners = [(m[61][0] + m[291][0]) / 2, (m[61][1] + m[291][1]) / 2];
  const lift = ((mid[0] - corners[0]) * down[0] + (mid[1] - corners[1]) * down[1]) / fh;
  const width = dist(m[61], m[291]) / fw, open = dist(m[13], m[14]) / dist(m[61], m[291]);
  return Math.max(0, Math.min(1, lift * 14 + (width - 0.4) * 5 + Math.min(open, 0.3) * 1.2));
}

async function detectFaces(input) {
  const h = await initAI();
  const r = await h.detect(input);
  return (r.face || []).filter(f => f.mesh && f.mesh.length >= 468 && f.score > 0.4);
}

// 挑片分析（在預覽圖上）：人臉數、閉眼、臉部清晰度
export async function analyzeForCulling(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const s = Math.min(1, 1280 / Math.max(W, H));
  const c = new OffscreenCanvas(Math.round(W * s), Math.round(H * s)); const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bitmap, 0, 0, c.width, c.height);
  const faces = await detectFaces(c);
  const minW = c.width * 0.035;
  let closed = 0, open = 0, smiles = 0, faceSharp = null, mainFace = null;
  for (const f of faces) {
    if (f.box[2] < minW) continue;
    const [le, re] = eyeOpenness(f.mesh);
    // 閉眼：兩眼開合比都很小
    const isClosed = Math.max(le, re) < 0.17 || (le + re) / 2 < 0.15;
    if (isClosed) closed++; else open++;
    if (smileScore(f.mesh) > 0.5) smiles++;
    if (!mainFace || f.box[2] > mainFace.box[2]) mainFace = f;
  }
  if (mainFace) faceSharp = sharpness(x, mainFace.box, c.width, c.height);
  return { faces: faces.length, closed, open, smiles, faceSharp };
}

// 拉普拉斯變異數（區域縮放到固定大小計算，數值可跨照片比較）
export function sharpness(ctx, box, W, H) {
  const [bx, by, bw, bh] = box;
  const x0 = Math.max(0, Math.floor(bx)), y0 = Math.max(0, Math.floor(by));
  const w = Math.min(W - x0, Math.ceil(bw)), h = Math.min(H - y0, Math.ceil(bh));
  if (w < 8 || h < 8) return 0;
  const S = Math.min(160, w); const c = new OffscreenCanvas(S, Math.max(8, Math.round(S * h / w))); const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data; const cw = c.width, ch = c.height;
  const g = new Float32Array(cw * ch); for (let i = 0; i < cw * ch; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < ch - 1; y++) for (let xx = 1; xx < cw - 1; xx++) { const i = y * cw + xx; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - cw] - g[i + cw]; s += l; s2 += l * l; n++; }
  const m = s / n; return s2 / n - m * m;
}

// 導向濾波：讓遮罩邊緣貼齊照片的邊緣（髮絲、肩膀輪廓）
export function guidedFilter(I, p, W, H, r, eps) {
  const box = (a) => { // 積分圖 box filter
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += a[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1); for (let x = 0; x < W; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      o[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0)); } }
    return o;
  };
  const n = W * H; const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = box(I), mp = box(p), mIp = box(Ip), mII = box(II);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i]; a[i] = cov / (v + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = box(a), mb = box(b); const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.max(0, Math.min(1, ma[i] * I[i] + mb[i]));
  return q;
}

// ── 修圖用遮罩 ──
// imgData: 基本渲染（ImageData，與 RAW 同比例）
export async function buildMasks(imgData) {
  const W = imgData.width, H = imgData.height;
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d', { willReadFrequently: true });
  x.putImageData(imgData, 0, 0);
  const faces = (await detectFaces(c)).filter(f => f.box[2] > W * 0.03);
  const h = await initAI();

  // 人像分割
  let person = null;
  try {
    const t = await h.segmentation(c, { segmentation: { enabled: true, modelPath: 'selfie.json', mode: 'alpha', ratio: 0.5 } });
    if (t) {
      const shape = t.shape; const arr = await t.data(); t.dispose && t.dispose();
      const sh = shape[shape.length - 3] || shape[0], sw = shape[shape.length - 2] || shape[1], ch = shape[shape.length - 1] || 4;
      const sc = new OffscreenCanvas(sw, sh); const sx = sc.getContext('2d');
      const id = sx.createImageData(sw, sh);
      for (let i = 0; i < sw * sh; i++) { const a = ch >= 4 ? arr[i * ch + 3] : arr[i * ch]; const v = a > 1.5 ? a : a * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = v; }
      sx.putImageData(id, 0, 0);
      const pc = new OffscreenCanvas(W, H); const px = pc.getContext('2d', { willReadFrequently: true });
      px.filter = `blur(${Math.max(1, W / 400)}px)`; px.drawImage(sc, 0, 0, W, H);
      person = px.getImageData(0, 0, W, H).data;
    }
  } catch (err) { console.warn('segmentation', err); }
  const gray = new Float32Array(W * H); { const d = imgData.data; for (let i = 0; i < W * H; i++) gray[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255; }
  if (person) {
    const pa = new Float32Array(W * H); for (let i = 0; i < W * H; i++) pa[i] = person[i * 4 + 3] / 255;
    const q = guidedFilter(gray, pa, W, H, Math.max(3, Math.round(Math.max(W, H) / 160)), 1e-3);
    for (let i = 0; i < W * H; i++) { const v = Math.max(0, Math.min(1, (q[i] - 0.08) / 0.84)); person[i * 4 + 3] = v * 255; }
  }
  // 若分割失敗但有人臉，用臉部附近粗略估計
  const layer = () => { const lc = new OffscreenCanvas(W, H); const lx = lc.getContext('2d', { willReadFrequently: true }); lx.fillStyle = '#fff'; lx.strokeStyle = '#fff'; return [lc, lx]; };
  const poly = (ctx, m, idx, op = 'source-over') => { ctx.globalCompositeOperation = op; ctx.beginPath(); idx.forEach((k, i) => { const p = m[k]; i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.closePath(); ctx.fill(); };

  const [skC, skX] = layer(), [ueC, ueX] = layer(), [thC, thX] = layer(), [eyC, eyX] = layer();
  const [lpC, lpX] = layer(), [brC, brX] = layer(), [fcC, fcX] = layer(), [blC, blX] = layer(), [hiC, hiX] = layer(), [loC, loX] = layer();
  const ell = (ctx, x, y, rx, ry, rot = 0) => { ctx.beginPath(); ctx.ellipse(x, y, Math.max(1, rx), Math.max(1, ry), rot, 0, Math.PI * 2); ctx.fill(); };
  const pins = [];
  const skinSamples = [];
  for (const f of faces) {
    const m = f.mesh;
    const fw = dist(m[234], m[454]);
    const feather = Math.max(1.5, fw * 0.025);
    // 皮膚：臉部輪廓，扣除眼睛、眉毛、嘴唇、鼻孔
    skX.filter = `blur(${feather}px)`;
    poly(skX, m, OVAL);
    skX.filter = `blur(${feather * 0.6}px)`;
    skX.fillStyle = '#000';
    for (const idx of [L_EYE, R_EYE]) polyPts(skX, expand(m, idx, 1.6));
    for (const idx of [L_BROW, R_BROW, LIPS]) polyPts(skX, expand(m, idx, 1.25));
    skX.fillStyle = '#fff';
    // 黑眼圈：下眼瞼往下延伸
    const down = norm([m[152][0] - m[10][0], m[152][1] - m[10][1]]);
    for (const idx of [L_LOWER, R_LOWER]) {
      const ew = dist(m[idx[0]], m[idx[idx.length - 1]]);
      const lower = idx.map(k => [m[k][0] + down[0] * ew * 0.16, m[k][1] + down[1] * ew * 0.16]);
      const off = lower.map(p => [p[0] + down[0] * ew * 0.38, p[1] + down[1] * ew * 0.38]).reverse();
      ueX.filter = `blur(${ew * 0.12}px)`; ueX.beginPath(); [...lower, ...off].forEach((p, i) => i ? ueX.lineTo(p[0], p[1]) : ueX.moveTo(p[0], p[1])); ueX.closePath(); ueX.fill();
    }
    // 牙齒：內唇區域
    thX.filter = `blur(${feather * 0.3}px)`; poly(thX, m, INNER);
    // 眼睛
    eyX.filter = `blur(${feather * 0.4}px)`; poly(eyX, m, L_EYE); poly(eyX, m, R_EYE);
    const right = norm([m[454][0] - m[234][0], m[454][1] - m[234][1]]);
    // 嘴唇（外唇扣內唇）、眉毛、整張臉、腮紅、立體光影
    lpX.filter = `blur(${feather * 0.35}px)`; poly(lpX, m, LIPS); lpX.fillStyle = '#000'; poly(lpX, m, INNER); lpX.fillStyle = '#fff';
    brX.filter = `blur(${feather * 0.4}px)`; polyPts(brX, expand(m, L_BROW, 1.15)); polyPts(brX, expand(m, R_BROW, 1.15));
    fcX.filter = `blur(${feather * 2.5}px)`; poly(fcX, m, OVAL);
    const fh = dist(m[10], m[152]); const roll = Math.atan2(right[1], right[0]);
    blX.filter = `blur(${fw * 0.07}px)`;
    for (const k of [50, 280]) ell(blX, m[k][0], m[k][1], fw * 0.13, fw * 0.09, roll);
    hiX.filter = `blur(${fw * 0.06}px)`;
    ell(hiX, m[151][0], m[151][1], fw * 0.14, fh * 0.08, roll);                    // 額頭
    ell(hiX, (m[6][0] + m[195][0]) / 2, (m[6][1] + m[195][1]) / 2, fw * 0.04, fh * 0.13, roll); // 鼻樑
    ell(hiX, m[175][0], m[175][1] - fh * 0.03, fw * 0.08, fh * 0.04, roll);        // 下巴
    for (const k of [118, 347]) ell(hiX, m[k][0], m[k][1], fw * 0.08, fh * 0.04, roll); // 顴骨上方
    loX.filter = `blur(${fw * 0.08}px)`;
    for (const k of [137, 366]) ell(loX, m[k][0], m[k][1] + fh * 0.04, fw * 0.07, fh * 0.12, roll); // 臉頰側邊
    for (const k of [129, 358]) ell(loX, m[k][0], m[k][1] - fh * 0.06, fw * 0.025, fh * 0.1, roll); // 鼻翼兩側
    // 膚色樣本（臉頰）
    for (const k of [50, 280, 101, 330, 205, 425]) { const p = m[k]; const i = (Math.round(p[1]) * W + Math.round(p[0])) * 4; if (i >= 0 && i < imgData.data.length) skinSamples.push([imgData.data[i], imgData.data[i + 1], imgData.data[i + 2]]); }
    // 液化控制點（0..1）
    for (const idx of [L_EYE, R_EYE]) {
      const cx = idx.reduce((s, k) => s + m[k][0], 0) / idx.length, cy = idx.reduce((s, k) => s + m[k][1], 0) / idx.length;
      const ew = dist(m[idx[0]], m[idx[8]]);
      pins.push({ kind: 'eye', x: cx / W, y: cy / H, r: ew * 1.15 / H });
    }
    for (const [ids, dir] of [[[172, 136, 58, 132], 1], [[397, 365, 288, 361], -1]]) {
      for (const k of ids) pins.push({ kind: 'jaw', x: m[k][0] / W, y: m[k][1] / H, r: fw * 0.32 / H, dx: dir * right[0] * fw / W, dy: dir * right[1] * fw / H });
    }
  }
  // ── 頭髮：頭部範圍內、人物遮罩內、顏色接近頭頂取樣的頭髮色 ──
  const hairA = new Float32Array(W * H);
  if (person) for (const f of faces) {
    const m = f.mesh; const fw = dist(m[234], m[454]), fh = dist(m[10], m[152]);
    const up = norm([m[10][0] - m[152][0], m[10][1] - m[152][1]]), rt = norm([m[454][0] - m[234][0], m[454][1] - m[234][1]]);
    const samples = [];
    for (const [a, b] of [[0.1, 0], [0.18, 0], [0.12, -0.25], [0.12, 0.25], [0.05, -0.45], [0.05, 0.45]]) {
      const px = Math.round(m[10][0] + up[0] * fh * a + rt[0] * fw * b), py = Math.round(m[10][1] + up[1] * fh * a + rt[1] * fw * b);
      if (px < 0 || py < 0 || px >= W || py >= H) continue; const i = py * W + px; if (person[i * 4 + 3] < 140) continue;
      const d = imgData.data; samples.push(ycc([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]));
    }
    if (samples.length < 2) continue;
    const mean = [0, 1, 2].map(k => samples.reduce((s2, v) => s2 + v[k], 0) / samples.length);
    const sd = [0, 1, 2].map(k => Math.max([28, 7, 7][k], Math.sqrt(samples.reduce((s2, v) => s2 + (v[k] - mean[k]) ** 2, 0) / samples.length) * 1.8));
    const cx = m[168][0], cy = m[168][1];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; const pv = person[i * 4 + 3] / 255; if (pv < 0.2) continue;
      const vx = x - cx, vy = y - cy; const u = (vx * up[0] + vy * up[1]) / fh, v = (vx * rt[0] + vy * rt[1]) / fw;
      if (u > 1.25 || u < -2.2 || Math.abs(v) > 1.25) continue;               // 頭頂到肩膀以下（長髮）
      if (u < -0.35 && Math.abs(v) < 0.42) continue;                         // 臉下方中央（脖子、胸口）不是頭髮
      const d = imgData.data; const c = ycc([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
      const z = ((c[0] - mean[0]) / sd[0]) ** 2 + ((c[1] - mean[1]) / sd[1]) ** 2 + ((c[2] - mean[2]) / sd[2]) ** 2;
      const like = Math.exp(-0.5 * z) * pv * (u < -0.6 ? Math.max(0, 1 - Math.abs(v) / 1.25) : 1);
      hairA[i] = Math.max(hairA[i], like);
    }
  }
  // 扣除皮膚（臉與身體）
  { const skd = skX.getImageData(0, 0, W, H).data, fcd = fcX.getImageData(0, 0, W, H).data;
    // 與膚色太接近的不算頭髮
    let ref = null; if (skinSamples.length) ref = ycc(skinSamples.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]).map(v => v / skinSamples.length));
    const d = imgData.data;
    for (let i = 0; i < W * H; i++) { if (!hairA[i]) continue; let k = (1 - skd[i * 4 + 3] / 255) * (1 - fcd[i * 4 + 3] / 255);
      if (ref) { const c = ycc([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]); const dc = Math.hypot(c[1] - ref[1], c[2] - ref[2]); k *= Math.min(1, Math.max(0, (dc - 6) / 10) + (c[0] < ref[0] * 0.35 ? 1 : 0)); }
      hairA[i] *= Math.min(1, k); } }
  let hair = hairA;
  if (faces.length && person) hair = guidedFilter(gray, hairA, W, H, Math.max(2, Math.round(Math.max(W, H) / 300)), 4e-4);

  // ── 身形：用姿勢模型找肩膀與髖部，在腰身左右邊緣放推移點 ──
  try {
    if (person) {
      const rb = await h.detect(c, { body: { enabled: true, modelPath: 'movenet-lightning.json', maxDetected: 1, minConfidence: 0.2 }, face: { enabled: false } });
      const b = (rb.body || [])[0];
      if (b && b.score > 0.25) {
        const kp = (n) => { const k = b.keypoints.find(q => q.part === n); return k && k.score > 0.2 ? k.position : null; };
        const ls = kp('leftShoulder'), rs = kp('rightShoulder'), lh = kp('leftHip'), rh = kp('rightHip'), lk = kp('leftKnee'), rk = kp('rightKnee');
        if (ls && rs && lh && rh) {
          const sm = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2], hm = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2];
          const axis = norm([hm[0] - sm[0], hm[1] - sm[1]]), perp = [-axis[1], axis[0]]; const th = dist(sm, hm);
          const levels = [[0.35, 'body'], [0.55, 'waist'], [0.7, 'waist'], [0.85, 'waist'], [1.05, 'body']];
          const km = lk && rk ? [(lk[0] + rk[0]) / 2, (lk[1] + rk[1]) / 2] : null;
          if (km) levels.push([1.35, 'body'], [1.65, 'body']);
          for (const [t, kind] of levels) {
            if (t > 1 && !km) continue;
            const base = t <= 1 ? [sm[0] + (hm[0] - sm[0]) * t, sm[1] + (hm[1] - sm[1]) * t] : [hm[0] + (km[0] - hm[0]) * (t - 1) / 0.7, hm[1] + (km[1] - hm[1]) * (t - 1) / 0.7];
            for (const dir of [-1, 1]) {
              let edge = null; for (let k = 0; k < th * 1.2; k += 1) { const x = Math.round(base[0] + perp[0] * dir * k), y = Math.round(base[1] + perp[1] * dir * k); if (x < 0 || y < 0 || x >= W || y >= H) break; if (person[(y * W + x) * 4 + 3] < 110) { edge = [x, y, k]; break; } }
              if (!edge || edge[2] < th * 0.08) continue;
              pins.push({ kind, x: edge[0] / W, y: edge[1] / H, r: th * (kind === 'waist' ? 0.3 : 0.35) / H, dx: -perp[0] * dir * edge[2] / W, dy: -perp[1] * dir * edge[2] / H });
            }
          }
        }
      }
    }
  } catch (err) { console.warn('pose', err); }

  // ── 水面：天空以下、非人物、紋理平滑、偏藍/青/灰綠，取最大連通區域 ──
  const water = waterMask(imgData, person, sky0 => sky0, gray);

  // 身體皮膚：人像分割 × 與臉部膚色相近
  const sk = skX.getImageData(0, 0, W, H).data;
  if (person && skinSamples.length) {
    const ref = skinSamples.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]).map(v => v / skinSamples.length);
    const [rY, rCb, rCr] = ycc(ref);
    const d = imgData.data;
    for (let i = 0; i < W * H; i++) {
      const p = person[i * 4 + 3] / 255; if (p < 0.3) continue;
      const [Y, Cb, Cr] = ycc([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
      const dc = Math.hypot(Cb - rCb, Cr - rCr);
      const s = Math.max(0, 1 - dc / 14) * Math.min(1, Y / 40) * p;
      const v = Math.max(sk[i * 4 + 3] * (sk[i * 4] / 255), s * 230);
      sk[i * 4] = 255; sk[i * 4 + 3] = v; sk[i * 4 + 1] = sk[i * 4 + 2] = 255;
    }
  }
  // 天空：上方、明亮、偏藍或接近白，且不是人
  const sky = skyMask(imgData, person);

  const ue = ueX.getImageData(0, 0, W, H).data, th = thX.getImageData(0, 0, W, H).data, ey = eyX.getImageData(0, 0, W, H).data;
  const gd = (x) => x.getImageData(0, 0, W, H).data;
  const lp = gd(lpX), br = gd(brX), fc = gd(fcX), bl = gd(blX), hi = gd(hiX), lo = gd(loX);
  const m1 = new Uint8Array(W * H * 4), m2 = new Uint8Array(W * H * 4), m3 = new Uint8Array(W * H * 4), m4 = new Uint8Array(W * H * 4);
  const A = (d, i) => d[i * 4 + 3] * (d[i * 4] / 255);
  for (let i = 0; i < W * H; i++) {
    m1[i * 4] = A(sk, i); m1[i * 4 + 1] = A(ue, i); m1[i * 4 + 2] = A(th, i); m1[i * 4 + 3] = A(ey, i);
    m2[i * 4] = person ? person[i * 4 + 3] : 0; m2[i * 4 + 1] = sky[i]; m2[i * 4 + 2] = A(hi, i); m2[i * 4 + 3] = A(lo, i);
    m4[i * 4] = hair[i] * 255; m4[i * 4 + 1] = water[i]; m4[i * 4 + 3] = 255;
    m3[i * 4] = A(lp, i); m3[i * 4 + 1] = A(br, i); m3[i * 4 + 2] = A(fc, i); m3[i * 4 + 3] = A(bl, i);
  }
  let skinRef = null;
  if (skinSamples.length) { const r = skinSamples.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0]).map(v => Math.pow(v / skinSamples.length / 255, 2.2)); skinRef = r; }
  const faceFrac = faces.length ? Math.max(...faces.map(f => dist(f.mesh[234], f.mesh[454]))) / Math.max(W, H) : 0.25;
  let skyBottom = 0, skyN = 0; for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 4) if (sky[y * W + x] > 128) { skyN++; skyBottom = Math.max(skyBottom, y / H); }
  // 構圖用：主體範圍
  let bb = null; if (person) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (person[(y * W + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } if (x1 > x0) bb = [x0 / W, y0 / H, x1 / W, y1 / H]; }
  const faceBoxes = faces.map(f => [f.box[0] / W, f.box[1] / H, (f.box[0] + f.box[2]) / W, (f.box[1] + f.box[3]) / H]);
  return { w: W, h: H, m1, m2, m3, m4, hasHair: hair.some(v => v > 0.5), hasWater: water.some(v => v > 128), hasBody: pins.some(p => p.kind === 'waist'), pins, faces: faces.length, hasPerson: !!person, skinRef, faceFrac, skyBottom: skyN > 50 ? skyBottom : 0, hasSky: skyN > 50, subject: bb, faceBoxes };
}

function expand(m, idx, k) {
  const cx = idx.reduce((s, i) => s + m[i][0], 0) / idx.length, cy = idx.reduce((s, i) => s + m[i][1], 0) / idx.length;
  return idx.map(i => [cx + (m[i][0] - cx) * k, cy + (m[i][1] - cy) * k]);
}
function polyPts(ctx, pts) { ctx.globalCompositeOperation = 'source-over'; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill(); }
function norm(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function ycc([r, g, b]) { return [0.299 * r + 0.587 * g + 0.114 * b, 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, 128 + 0.5 * r - 0.4187 * g - 0.0813 * b]; }

export function waterMask(img, person, _u, gray) {
  const W = img.width, H = img.height;
  const s = Math.min(1, 256 / Math.max(W, H)); const w = Math.max(4, Math.round(W * s)), h = Math.max(4, Math.round(H * s));
  // 先縮小（平均），紋理判斷才不會被雜訊干擾
  const full = new OffscreenCanvas(W, H); full.getContext('2d').putImageData(img, 0, 0);
  const sm = new OffscreenCanvas(w, h); const sx0 = sm.getContext('2d', { willReadFrequently: true }); sx0.imageSmoothingQuality = 'high'; sx0.drawImage(full, 0, 0, w, h);
  const d = sx0.getImageData(0, 0, w, h).data;
  const gs = new Float32Array(w * h); for (let i = 0; i < w * h; i++) gs[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  const cand = new Uint8Array(w * h);
  const G = (x, y) => gs[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = Math.floor(h * 0.35); y < h; y++) for (let x = 1; x < w - 1; x++) {
    const X = Math.min(W - 1, Math.round(x / s)), Y = Math.min(H - 1, Math.round(y / s));
    if (person && person[(Y * W + X) * 4 + 3] > 100) continue;
    const i = (y * w + x) * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const sat = mx ? (mx - mn) / mx : 0;
    const l = G(x, y); const tex = Math.abs(G(x + 1, y) - l) + Math.abs(G(x - 1, y) - l) + Math.abs(G(x, y + 1) - l) + Math.abs(G(x, y - 1) - l);
    const bluish = b >= r - 5 && sat > 0.08; const murky = sat < 0.55 && l > 0.08 && l < 0.7 && !(g > r * 1.2 && g > b * 1.4 && sat > 0.35);
    let tx2 = 0; for (let k = -1; k <= 1; k++) { const yy = y + k; const lv = G(x, yy); tx2 += Math.abs(G(x + 1, yy) - lv) + Math.abs(G(x - 1, yy) - lv) + Math.abs(G(x, yy + 1) - lv) + Math.abs(G(x, yy - 1) - lv); }
    if ((tex + tx2) / 4 < 0.16 && (bluish || murky)) cand[y * w + x] = 1;
  }
  // 形態學閉運算：把水中石頭、倒影造成的小洞補起來
  for (let pass = 0; pass < 2; pass++) { const tmp = new Uint8Array(cand); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c += tmp[(y + dy) * w + x + dx]; if (c >= 4) cand[y * w + x] = 1; } }
  // 最大連通區域
  const lab = new Int32Array(w * h); let best = 0, bestN = 0, id = 0;
  for (let i = 0; i < w * h; i++) { if (!cand[i] || lab[i]) continue; id++; let n = 0; const q = [i]; lab[i] = id;
    while (q.length) { const j = q.pop(); n++; const x = j % w, y = (j / w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const k = Y * w + X; if (cand[k] && !lab[k]) { lab[k] = id; q.push(k); } } }
    if (n > bestN) { bestN = n; best = id; } }
  const out = new Uint8Array(W * H);
  if (bestN < w * h * 0.04) return out;
  const sc = new OffscreenCanvas(w, h); const sx = sc.getContext('2d'); const idt = sx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { idt.data[i * 4 + 3] = lab[i] === best ? 255 : 0; }
  sx.putImageData(idt, 0, 0);
  const big = new OffscreenCanvas(W, H); const bx = big.getContext('2d', { willReadFrequently: true }); bx.filter = `blur(${Math.max(2, W / 120)}px)`; bx.drawImage(sc, 0, 0, W, H);
  const bd = bx.getImageData(0, 0, W, H).data; for (let i = 0; i < W * H; i++) out[i] = Math.min(255, bd[i * 4 + 3] * 1.3);
  return out;
}

function skyMask(img, person) {
  const W = img.width, H = img.height, d = img.data;
  // 低解析度做連通區域
  const s = Math.min(1, 256 / Math.max(W, H)); const w = Math.max(4, Math.round(W * s)), h = Math.max(4, Math.round(H * s));
  const cand = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = Math.min(W - 1, Math.round(x / s)), Y = Math.min(H - 1, Math.round(y / s)); const i = (Y * W + X) * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2]; const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const sat = mx ? (mx - mn) / mx : 0;
    const blue = b > r + 8 && b >= g - 10 && l > 70;
    const white = l > 185 && sat < 0.18;
    const warm = l > 150 && r > b && y < h * 0.5 && sat < 0.45; // 夕陽天空
    let v = blue ? 1 : white ? 0.8 : warm ? 0.6 : 0;
    if (person && person[i + 3] > 100) v = 0;
    cand[y * w + x] = v;
  }
  // 從上方邊緣做 flood fill
  const reach = new Uint8Array(w * h); const q = [];
  for (let x = 0; x < w; x++) if (cand[x] > 0) { reach[x] = 1; q.push(x); }
  while (q.length) {
    const i = q.pop(); const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx; if (reach[j] || cand[j] <= 0) continue;
      // 顏色連續
      reach[j] = 1; q.push(j);
    }
  }
  const small = new OffscreenCanvas(w, h); const sx = small.getContext('2d'); const id = sx.createImageData(w, h);
  let count = 0;
  for (let i = 0; i < w * h; i++) { const v = reach[i] ? cand[i] * 255 : 0; if (v) count++; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = v; }
  const out = new Uint8Array(W * H);
  // 必須有足夠「天空色」（藍色或夕陽暖色），避免把室內白牆、燈光當成天空
  let skyish = 0; for (let i = 0; i < w * h; i++) if (reach[i] && (cand[i] === 1 || cand[i] === 0.6)) skyish++;
  if (count < w * h * 0.02 || skyish < count * 0.35) return out;
  sx.putImageData(id, 0, 0);
  const big = new OffscreenCanvas(W, H); const bx = big.getContext('2d', { willReadFrequently: true }); bx.filter = `blur(${Math.max(1, W / 300)}px)`; bx.drawImage(small, 0, 0, W, H);
  const bd = bx.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) {
    // 以全解析度顏色再過濾一次，避免樹枝被染色
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const ok = (b > r && l > 60) || l > 170 ? 1 : 0.15;
    out[i] = bd[i * 4 + 3] * ok;
  }
  return out;
}

// 依修圖參數產生液化控制點
export function pinsFor(maskPins, e) {
  const out = [];
  if (!maskPins) return out;
  for (const p of maskPins) {
    if (p.kind === 'eye' && e.eyeEnlarge) out.push({ type: 'mag', x: p.x, y: p.y, r: p.r, s: 0.22 * e.eyeEnlarge / 100 });
    if (p.kind === 'waist' && e.waist) out.push({ type: 'push', x: p.x, y: p.y, r: p.r, dx: p.dx * 0.09 * e.waist / 100, dy: p.dy * 0.09 * e.waist / 100 });
    if ((p.kind === 'body' || p.kind === 'waist') && e.bodySlim) out.push({ type: 'push', x: p.x, y: p.y, r: p.r * 1.2, dx: p.dx * 0.06 * e.bodySlim / 100, dy: p.dy * 0.06 * e.bodySlim / 100 });
    if (p.kind === 'jaw' && e.slim) out.push({ type: 'push', x: p.x, y: p.y, r: p.r, dx: p.dx * 0.07 * e.slim / 100, dy: p.dy * 0.07 * e.slim / 100 });
  }
  return out;
}
