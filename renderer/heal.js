// 物件移除：多尺度 PatchMatch 補圖
// 在低解析度工作區算出「每個洞的像素該從哪裡複製」（NNF），再用這個對應到全解析度複製原始紋理，細節不會糊掉。

const PATCH = 3; // 半徑 → 7x7

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

// 把 op 轉成指定解析度的遮罩（Float32 0..1）
export function rasterOp(op, W, H) {
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';
  if (op.strokes) for (const s of op.strokes) {
    x.lineWidth = Math.max(2, s.r * 2 * H);
    x.beginPath(); s.pts.forEach(([px, py], i) => i ? x.lineTo(px * W, py * H) : x.moveTo(px * W, py * H));
    if (s.pts.length === 1) { x.arc(s.pts[0][0] * W, s.pts[0][1] * H, s.r * H, 0, 7); x.fill(); } else x.stroke();
  }
  if (op.rle) {
    const { w, h, runs } = op.rle; const m = new OffscreenCanvas(w, h); const mx = m.getContext('2d'); const id = mx.createImageData(w, h);
    let p = 0, on = false; for (const r of runs) { if (on) for (let i = p; i < p + r; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = id.data[i * 4 + 3] = 255; } p += r; on = !on; }
    mx.putImageData(id, 0, 0);
    x.filter = `blur(${Math.max(0.5, W / w * 0.6)}px)`; x.drawImage(m, 0, 0, W, H); x.filter = 'none';
  }
  const d = x.getImageData(0, 0, W, H).data; const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = d[i * 4 + 3] / 255;
  return out;
}

export function encodeRLE(mask, w, h) {
  const runs = []; let cur = false, n = 0;
  for (let i = 0; i < w * h; i++) { const v = mask[i] > 0.5; if (v === cur) n++; else { runs.push(n); n = 1; cur = v; } }
  runs.push(n); return { w, h, runs };
}

// 讀取來源像素（RGB，0..1，感知空間）
function sampler(src) {
  const { width: W, height: H, data } = src; const ch = src.channels || 3; const sc = data instanceof Uint16Array ? 1 / 65535 : 1 / 255;
  const lin = data instanceof Uint16Array;
  return { W, H, ch, sc, get(x, y, k) { x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y)); const v = data[(y * W + x) * ch + k] * sc; return lin ? Math.sqrt(v) : v; } };
}

function downsample(img, w, h) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1); const o = new Float32Array(w2 * h2 * 3);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) for (let k = 0; k < 3; k++) {
    const a = (Math.min(h - 1, 2 * y) * w + Math.min(w - 1, 2 * x)) * 3 + k, b = (Math.min(h - 1, 2 * y) * w + Math.min(w - 1, 2 * x + 1)) * 3 + k;
    const c = (Math.min(h - 1, 2 * y + 1) * w + Math.min(w - 1, 2 * x)) * 3 + k, d = (Math.min(h - 1, 2 * y + 1) * w + Math.min(w - 1, 2 * x + 1)) * 3 + k;
    o[(y * w2 + x) * 3 + k] = (img[a] + img[b] + img[c] + img[d]) / 4;
  }
  return { img: o, w: w2, h: h2 };
}
function downMask(m, w, h) { const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1); const o = new Uint8Array(w2 * h2); for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { let v = 0; for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) v |= m[Math.min(h - 1, 2 * y + dy) * w + Math.min(w - 1, 2 * x + dx)]; o[y * w2 + x] = v; } return { m: o, w: w2, h: h2 }; }
function dilate(m, w, h, r) { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!m[y * w + x]) continue; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) o[Y * w + X] = 1; } } return o; }

// 單一尺度的 PatchMatch + 投票重建
function solveLevel(img, w, h, hole, nnf, iters, rand) {
  const valid = dilate(hole, w, h, PATCH); // 來源 patch 中心不可碰到洞
  const okSrc = (x, y) => x >= PATCH && y >= PATCH && x < w - PATCH && y < h - PATCH && !valid[y * w + x];
  const targets = []; const near = dilate(hole, w, h, PATCH);
  for (let i = 0; i < w * h; i++) if (near[i]) targets.push(i);
  const dist = (tx, ty, sx, sy, best) => {
    let d = 0;
    for (let dy = -PATCH; dy <= PATCH; dy++) { const Y1 = Math.max(0, Math.min(h - 1, ty + dy)), Y2 = sy + dy; for (let dx = -PATCH; dx <= PATCH; dx++) {
      const X1 = Math.max(0, Math.min(w - 1, tx + dx)), X2 = sx + dx; const a = (Y1 * w + X1) * 3, b = (Y2 * w + X2) * 3;
      const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2];
      d += e0 * e0 + e1 * e1 + e2 * e2; }
      if (d > best) return d; }
    return d;
  };
  const randomSrc = () => { for (let t = 0; t < 50; t++) { const x = PATCH + Math.floor(rand() * (w - 2 * PATCH)), y = PATCH + Math.floor(rand() * (h - 2 * PATCH)); if (okSrc(x, y)) return [x, y]; } return [PATCH, PATCH]; };
  // 初始化
  const cost = new Float32Array(w * h).fill(Infinity);
  for (const i of targets) { const tx = i % w, ty = (i / w) | 0; let sx = nnf[i * 2], sy = nnf[i * 2 + 1]; if (!(sx >= 0) || !okSrc(sx, sy)) [sx, sy] = randomSrc(); nnf[i * 2] = sx; nnf[i * 2 + 1] = sy; cost[i] = dist(tx, ty, sx, sy, Infinity); }
  for (let em = 0; em < iters; em++) {
    for (let pass = 0; pass < 4; pass++) {
      const rev = pass % 2 === 1; const step = rev ? -1 : 1;
      for (let k = 0; k < targets.length; k++) {
        const i = targets[rev ? targets.length - 1 - k : k]; const tx = i % w, ty = (i / w) | 0;
        let bx = nnf[i * 2], by = nnf[i * 2 + 1], bc = cost[i];
        // 傳播
        for (const [nx, ny] of [[tx - step, ty], [tx, ty - step]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (!near[j]) continue;
          const sx = nnf[j * 2] + step * (nx === tx ? 0 : 1), sy = nnf[j * 2 + 1] + step * (ny === ty ? 0 : 1);
          if (!okSrc(sx, sy)) continue; const c = dist(tx, ty, sx, sy, bc); if (c < bc) { bc = c; bx = sx; by = sy; }
        }
        // 隨機搜尋
        for (let R = Math.max(w, h); R >= 1; R >>= 1) {
          const sx = Math.round(bx + (rand() * 2 - 1) * R), sy = Math.round(by + (rand() * 2 - 1) * R);
          if (!okSrc(sx, sy)) continue; const c = dist(tx, ty, sx, sy, bc); if (c < bc) { bc = c; bx = sx; by = sy; }
        }
        nnf[i * 2] = bx; nnf[i * 2 + 1] = by; cost[i] = bc;
      }
    }
    // 投票：每個洞內像素 = 所有覆蓋它的 patch 對應像素的加權平均
    const acc = new Float32Array(w * h * 4);
    for (const i of targets) {
      const tx = i % w, ty = (i / w) | 0; const sx = nnf[i * 2], sy = nnf[i * 2 + 1]; const wt = Math.exp(-cost[i] / (49 * 0.004));
      for (let dy = -PATCH; dy <= PATCH; dy++) for (let dx = -PATCH; dx <= PATCH; dx++) {
        const X = tx + dx, Y = ty + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const q = Y * w + X; if (!hole[q]) continue;
        const b = ((sy + dy) * w + (sx + dx)) * 3; acc[q * 4] += img[b] * wt; acc[q * 4 + 1] += img[b + 1] * wt; acc[q * 4 + 2] += img[b + 2] * wt; acc[q * 4 + 3] += wt;
      }
    }
    for (let q = 0; q < w * h; q++) if (hole[q] && acc[q * 4 + 3] > 0) { img[q * 3] = acc[q * 4] / acc[q * 4 + 3]; img[q * 3 + 1] = acc[q * 4 + 1] / acc[q * 4 + 3]; img[q * 3 + 2] = acc[q * 4 + 2] / acc[q * 4 + 3]; }
    // 更新 cost（影像已改變）
    for (const i of targets) cost[i] = dist(i % w, (i / w) | 0, nnf[i * 2], nnf[i * 2 + 1], Infinity);
  }
}

// 對一個 op 計算工作區 NNF，回傳 { box, ww, wh, map } ；map[i] = 洞像素在工作區的來源座標
function solveOp(src, maskFull) {
  const S = sampler(src); const W = S.W, H = S.H;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (maskFull[y * W + x] > 0.1) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const hw = x1 - x0, hh = y1 - y0; const margin = Math.max(40, Math.max(hw, hh) * 1.2);
  const bx0 = Math.max(0, Math.floor(x0 - margin)), by0 = Math.max(0, Math.floor(y0 - margin)), bx1 = Math.min(W, Math.ceil(x1 + margin)), by1 = Math.min(H, Math.ceil(y1 + margin));
  const bw = bx1 - bx0, bh = by1 - by0; const s = Math.min(1, 420 / Math.max(bw, bh));
  const ww = Math.max(16, Math.round(bw * s)), wh = Math.max(16, Math.round(bh * s));
  // 工作影像與洞
  const img = new Float32Array(ww * wh * 3), hole = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
    const sx = Math.min(W - 1, Math.round(bx0 + (x + 0.5) / s)), sy = Math.min(H - 1, Math.round(by0 + (y + 0.5) / s));
    for (let k = 0; k < 3; k++) img[(y * ww + x) * 3 + k] = S.get(sx, sy, k);
    // 洞（往外擴一點，避免殘留邊緣）
    let mv = 0; const r = Math.ceil(1 / s);
    for (let dy = -r; dy <= r; dy += Math.max(1, r)) for (let dx = -r; dx <= r; dx += Math.max(1, r)) { const X = Math.max(0, Math.min(W - 1, sx + dx)), Y = Math.max(0, Math.min(H - 1, sy + dy)); mv = Math.max(mv, maskFull[Y * W + X]); }
    hole[y * ww + x] = mv > 0.1 ? 1 : 0;
  }
  // 智慧擴張：洞旁邊的像素若顏色比較像「被塗掉的物件」而不像背景，也一起移除（塗得不夠滿也能清乾淨）
  const ring1 = dilate(hole, ww, wh, 6), ring2 = dilate(hole, ww, wh, 14);
  const mean = (sel) => { const m = [0, 0, 0]; let n = 0; for (let i = 0; i < ww * wh; i++) if (sel(i)) { m[0] += img[i * 3]; m[1] += img[i * 3 + 1]; m[2] += img[i * 3 + 2]; n++; } return n ? m.map(v => v / n) : null; };
  const inM = mean(i => hole[i]), outM = mean(i => ring2[i] && !ring1[i]);
  if (inM && outM) {
    const dd = (i, m) => (img[i * 3] - m[0]) ** 2 + (img[i * 3 + 1] - m[1]) ** 2 + (img[i * 3 + 2] - m[2]) ** 2;
    const sep = (inM[0] - outM[0]) ** 2 + (inM[1] - outM[1]) ** 2 + (inM[2] - outM[2]) ** 2;
    if (sep > 0.004) for (let pass = 0; pass < 6; pass++) {
      const grow = dilate(hole, ww, wh, 1); let added = 0;
      for (let i = 0; i < ww * wh; i++) if (grow[i] && !hole[i] && ring1[i] && dd(i, inM) < dd(i, outM) * 0.6) { hole[i] = 1; added++; }
      if (!added) break;
    }
  }
  const holeD = dilate(hole, ww, wh, 1);
  // 金字塔
  const pyr = [{ img, hole: holeD, w: ww, h: wh }];
  while (Math.min(pyr[pyr.length - 1].w, pyr[pyr.length - 1].h) > 40) { const t = pyr[pyr.length - 1]; const d = downsample(t.img, t.w, t.h); const m = downMask(t.hole, t.w, t.h); pyr.push({ img: d.img, hole: m.m, w: d.w, h: d.h }); }
  const rand = rng(12345);
  let nnf = null, prev = null;
  for (let L = pyr.length - 1; L >= 0; L--) {
    const lv = pyr[L]; const n = new Int32Array(lv.w * lv.h * 2).fill(-1);
    // 洞內初始值：上一層結果放大，或用周圍平均
    if (prev) {
      for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) {
        const i = y * lv.w + x; const px = Math.min(prev.w - 1, x >> 1), py = Math.min(prev.h - 1, y >> 1); const j = py * prev.w + px;
        if (prev.nnf[j * 2] >= 0) { n[i * 2] = Math.min(lv.w - 1, prev.nnf[j * 2] * 2 + (x & 1)); n[i * 2 + 1] = Math.min(lv.h - 1, prev.nnf[j * 2 + 1] * 2 + (y & 1)); }
        if (lv.hole[i]) for (let k = 0; k < 3; k++) lv.img[i * 3 + k] = prev.img[j * 3 + k];
      }
    } else {
      // 最粗一層：用洞邊緣平均色填入
      let a = [0, 0, 0], c = 0; for (let i = 0; i < lv.w * lv.h; i++) if (!lv.hole[i]) { a[0] += lv.img[i * 3]; a[1] += lv.img[i * 3 + 1]; a[2] += lv.img[i * 3 + 2]; c++; }
      for (let i = 0; i < lv.w * lv.h; i++) if (lv.hole[i]) for (let k = 0; k < 3; k++) lv.img[i * 3 + k] = a[k] / Math.max(1, c);
    }
    solveLevel(lv.img, lv.w, lv.h, lv.hole, n, L === 0 ? 3 : 5, rand);
    prev = { nnf: n, img: lv.img, w: lv.w, h: lv.h };
    nnf = n;
  }
  return { bx0, by0, bw, bh, ww, wh, s, nnf, hole: holeD };
}

// 細線、小範圍：金字塔推拉補色（在平滑區域如天空最自然），直接在全解析度運作
function pushPullFill(out, mask, W, H) {
  const ch = out.channels || 3; const d = out.data;
  // 只處理遮罩外框範圍
  let x0 = W, y0 = H, x1 = -1, y1 = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x] > 0.05) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return;
  const pad = 32; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  let lv = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, j = (y + y0) * W + x + x0; const known = mask[j] > 0.05 ? 0 : 1; lv.a[i] = known; for (let k = 0; k < 3; k++) lv.c[i * 3 + k] = d[j * ch + k] * known; }
  const levels = [lv];
  while (lv.w > 2 || lv.h > 2) { // push：加權縮小
    const w2 = Math.max(1, Math.ceil(lv.w / 2)), h2 = Math.max(1, Math.ceil(lv.h / 2)); const n = { w: w2, h: h2, c: new Float32Array(w2 * h2 * 3), a: new Float32Array(w2 * h2) };
    for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) { const i = y * lv.w + x, o = (y >> 1) * w2 + (x >> 1); n.a[o] += lv.a[i]; for (let k = 0; k < 3; k++) n.c[o * 3 + k] += lv.c[i * 3 + k]; }
    for (let i = 0; i < w2 * h2; i++) if (n.a[i] > 0) { const f = Math.min(1, n.a[i]) / n.a[i]; for (let k = 0; k < 3; k++) n.c[i * 3 + k] *= f; n.a[i] = Math.min(1, n.a[i]); }
    levels.push(n); lv = n; if (levels.length > 16) break;
  }
  for (let L = levels.length - 2; L >= 0; L--) { // pull：用上一層填補缺的權重
    const a = levels[L], b = levels[L + 1];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) { const i = y * a.w + x; const wgt = 1 - a.a[i]; if (wgt <= 0) continue;
      const bx = Math.min(b.w - 1, Math.max(0, (x - 0.5) / 2)), by = Math.min(b.h - 1, Math.max(0, (y - 0.5) / 2)); const X0 = Math.floor(bx), Y0 = Math.floor(by), X1 = Math.min(b.w - 1, X0 + 1), Y1 = Math.min(b.h - 1, Y0 + 1), fx = bx - X0, fy = by - Y0;
      const ba = (b.a[Y0 * b.w + X0] * (1 - fx) + b.a[Y0 * b.w + X1] * fx) * (1 - fy) + (b.a[Y1 * b.w + X0] * (1 - fx) + b.a[Y1 * b.w + X1] * fx) * fy;
      if (ba <= 0) continue;
      for (let k = 0; k < 3; k++) { const v = ((b.c[(Y0 * b.w + X0) * 3 + k] * (1 - fx) + b.c[(Y0 * b.w + X1) * 3 + k] * fx) * (1 - fy) + (b.c[(Y1 * b.w + X0) * 3 + k] * (1 - fx) + b.c[(Y1 * b.w + X1) * 3 + k] * fx) * fy) / ba; a.c[i * 3 + k] += v * wgt; }
      a.a[i] = 1; }
  }
  const top = levels[0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = (y + y0) * W + x + x0; const m = Math.min(1, mask[j] * 1.5); if (m <= 0.01) continue; const i = y * w + x;
    // 加一點原本的雜訊顆粒，避免補出來太平滑
    for (let k = 0; k < 3; k++) d[j * ch + k] = d[j * ch + k] * (1 - m) + top.c[i * 3 + k] / Math.max(top.a[i], 1e-6) * m; }
}

// 估計遮罩最大厚度（像素）
function thickness(mask, W, H) { let best = 0; for (let y = 0; y < H; y += 3) { let run = 0; for (let x = 0; x < W; x++) { if (mask[y * W + x] > 0.5) { run++; if (run > best) best = run; } else run = 0; } } let bv = 0; for (let x = 0; x < W; x += 3) { let run = 0; for (let y = 0; y < H; y++) { if (mask[y * W + x] > 0.5) { run++; if (run > bv) bv = run; } else run = 0; } } return Math.min(best, bv); }

// 套用所有修補 op，回傳新的來源資料（不改動原資料）
export function applyHeals(src, ops, extra) {
  if (!ops || !ops.length) return src;
  const out = { ...src, data: src.data.slice() };
  const W = src.width, H = src.height, ch = src.channels || 3;
  for (const op of ops) {
    if (op.mode === 'eyes') { if (extra?.eyeSrc?.[op.src]) applyEyes(out, op, extra.eyeSrc[op.src]); continue; }
    if (op.mode === 'gen' && extra?.gen?.[genKey(op)]) { applyGen(out, rasterOp(op, W, H), extra.gen[genKey(op)]); continue; }
    const mask = rasterOp(op, W, H);
    if (op.mode === 'clone' || op.mode === 'heal') { cloneHeal(out, mask, W, H, op); continue; }
    if (op.mode === 'eyes') { if (extra?.eyeSrc?.[op.src]) applyEyes(out, op, extra.eyeSrc[op.src]); continue; }
    // 電線、細線：推拉補色；一般物件：PatchMatch 複製紋理
    if ((op.rle && !op.obj) || thickness(mask, W, H) < Math.max(10, Math.max(W, H) / 350)) { pushPullFill(out, mask, W, H); continue; }
    const sol = solveOp(out, mask); if (!sol) continue;
    const { bx0, by0, ww, wh, s, nnf, hole } = sol; const d = out.data, orig = d.slice();
    for (let y = Math.max(0, by0); y < Math.min(H, by0 + sol.bh); y++) for (let x = Math.max(0, bx0); x < Math.min(W, bx0 + sol.bw); x++) {
      const wx = Math.min(ww - 1, Math.max(0, Math.floor((x - bx0) * s))), wy = Math.min(wh - 1, Math.max(0, Math.floor((y - by0) * s)));
      const m = Math.max(mask[y * W + x], hole[wy * ww + wx] ? 0.75 : 0); if (m <= 0.001) continue;
      let i = wy * ww + wx; if (nnf[i * 2] < 0) { // 找最近有對應的點
        let found = false; for (let r = 1; r < 4 && !found; r++) for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) { const X = wx + dx, Y = wy + dy; if (X < 0 || Y < 0 || X >= ww || Y >= wh) continue; const j = Y * ww + X; if (nnf[j * 2] >= 0) { i = j; found = true; } }
        if (!found) continue;
      }
      const offx = (nnf[i * 2] - (i % ww)) / s, offy = (nnf[i * 2 + 1] - ((i / ww) | 0)) / s;
      const sx = x + offx, sy = y + offy;
      const X0 = Math.max(0, Math.min(W - 2, Math.floor(sx))), Y0 = Math.max(0, Math.min(H - 2, Math.floor(sy))); const fx = Math.min(1, Math.max(0, sx - X0)), fy = Math.min(1, Math.max(0, sy - Y0));
      const a = Math.min(1, m * 1.6);
      for (let k = 0; k < 3; k++) {
        const v = (orig[(Y0 * W + X0) * ch + k] * (1 - fx) + orig[(Y0 * W + X0 + 1) * ch + k] * fx) * (1 - fy) + (orig[((Y0 + 1) * W + X0) * ch + k] * (1 - fx) + orig[((Y0 + 1) * W + X0 + 1) * ch + k] * fx) * fy;
        d[(y * W + x) * ch + k] = orig[(y * W + x) * ch + k] * (1 - a) + v * a;
      }
    }
  }
  return out;
}

// 仿製印章 / 修復筆刷：從取樣點（偏移 dx,dy）複製；修復模式再用邊界差值做低頻色調融合，讓顏色亮度與周圍一致
function cloneHeal(out, mask0, W, H, op) {
  const ch = out.channels || 3, d = out.data, orig = d.slice(); const ox = op.dx * W, oy = op.dy * H;
  // 羽化遮罩
  const feather = Math.max(1, (op.strokes?.[0]?.r || 0.01) * H * (op.mode === 'clone' ? 0.35 : 0.2));
  const mc = new OffscreenCanvas(W, H); const mx = mc.getContext('2d', { willReadFrequently: true }); const id = mx.createImageData(W, H); for (let i = 0; i < W * H; i++) { id.data[i * 4 + 3] = mask0[i] * 255; }
  mx.putImageData(id, 0, 0); const mc2 = new OffscreenCanvas(W, H); const m2 = mc2.getContext('2d', { willReadFrequently: true }); m2.filter = `blur(${feather}px)`; m2.drawImage(mc, 0, 0); const md = m2.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (md[(y * W + x) * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return;
  const samp = (sx, sy, k) => { const X = Math.max(0, Math.min(W - 2, Math.floor(sx))), Y = Math.max(0, Math.min(H - 2, Math.floor(sy))); const fx = Math.min(1, Math.max(0, sx - X)), fy = Math.min(1, Math.max(0, sy - Y));
    return (orig[(Y * W + X) * ch + k] * (1 - fx) + orig[(Y * W + X + 1) * ch + k] * fx) * (1 - fy) + (orig[((Y + 1) * W + X) * ch + k] * (1 - fx) + orig[((Y + 1) * W + X + 1) * ch + k] * fx) * fy; };
  // 修復：邊界上（遮罩外一圈）的「目標 − 來源」差值，往內推拉補滿成平滑的修正圖
  let corr = null; const pad = Math.ceil(feather * 2 + 4); const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(W - 1, x1 + pad), by1 = Math.min(H - 1, y1 + pad); const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  if (op.mode === 'heal') {
    const diff = { width: bw, height: bh, channels: 3, data: new Float32Array(bw * bh * 3) }; const hole = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const X = bx0 + x, Y = by0 + y; const a = md[(Y * W + X) * 4 + 3] / 255; hole[y * bw + x] = a > 0.02 ? 1 : 0; if (a <= 0.02) for (let k = 0; k < 3; k++) diff.data[(y * bw + x) * 3 + k] = orig[(Y * W + X) * ch + k] - samp(X + ox, Y + oy, k); }
    pushPullFill(diff, hole, bw, bh); corr = diff.data;
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const a = md[(y * W + x) * 4 + 3] / 255; if (a <= 0.002) continue; const i = (y * W + x) * ch; const ci = ((y - by0) * bw + (x - bx0)) * 3;
    for (let k = 0; k < 3; k++) { let v = samp(x + ox, y + oy, k); if (corr) v += corr[ci + k]; d[i + k] = Math.max(0, Math.min(d instanceof Uint16Array ? 65535 : 255, orig[i + k] * (1 - a) + v * a)); }
  }
}

export function genKey(op) { return JSON.stringify([op.strokes || [], op.rle ? op.rle.runs.length + ':' + op.rle.runs.slice(0, 20).join(',') : '', op.seed || 0]); }
// 生成式補圖結果（sRGB 8-bit，裁切範圍 x,y,w,h 為 0..1）貼回來源，邊緣羽化
function applyGen(out, mask0, g) {
  const W = out.width, H = out.height, ch = out.channels || 3, d = out.data; const lin = d instanceof Uint16Array, max = lin ? 65535 : 255;
  const X0 = Math.floor(g.x * W), Y0 = Math.floor(g.y * H), CW = Math.max(1, Math.round(g.w * W)), CH = Math.max(1, Math.round(g.h * H));
  const mc = new OffscreenCanvas(W, H); const mx = mc.getContext('2d', { willReadFrequently: true }); const id = mx.createImageData(W, H); for (let i = 0; i < W * H; i++) id.data[i * 4 + 3] = mask0[i] * 255; mx.putImageData(id, 0, 0);
  const m2 = new OffscreenCanvas(W, H); const m2x = m2.getContext('2d', { willReadFrequently: true }); m2x.filter = `blur(${Math.max(1.5, Math.max(W, H) / 700)}px)`; m2x.drawImage(mc, 0, 0); const md = m2x.getImageData(0, 0, W, H).data;
  const pc = new OffscreenCanvas(g.img.width, g.img.height); pc.getContext('2d').putImageData(g.img, 0, 0); const rc = new OffscreenCanvas(CW, CH); const rx = rc.getContext('2d', { willReadFrequently: true }); rx.imageSmoothingQuality = 'high'; rx.drawImage(pc, 0, 0, CW, CH); const pd = rx.getImageData(0, 0, CW, CH).data;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) { const X = X0 + x, Y = Y0 + y; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const a = Math.min(1, md[(Y * W + X) * 4 + 3] / 255 * 1.4); if (a <= 0.003) continue; const i = (Y * W + X) * ch, j = (y * CW + x) * 4;
    for (let k = 0; k < 3; k++) { let v = pd[j + k] / 255; if (lin) v = Math.pow(v, 2.2); d[i + k] = Math.round(d[i + k] * (1 - a) + v * max * a); } }
}

// 閉眼修復：把另一張睜眼照片的眼睛區域，依臉部特徵點的仿射對齊貼過來，再做顏色亮度融合與羽化
function applyEyes(out, op, srcImg) {
  const W = out.width, H = out.height, ch = out.channels || 3, d = out.data; const SW = srcImg.width, SH = srcImg.height, sch = srcImg.channels || 3, sd = srcImg.data;
  const smax = sd instanceof Uint16Array ? 65535 : 255, dmax = d instanceof Uint16Array ? 65535 : 255; const slin = sd instanceof Uint16Array, dlin = d instanceof Uint16Array;
  const toLin = (v, lin) => lin ? v : Math.pow(v, 2.2), fromLin = (v, lin) => lin ? v : Math.pow(Math.max(0, v), 1 / 2.2);
  const sampS = (u, v, k) => { const x = u * SW - 0.5, y = v * SH - 0.5; const X = Math.max(0, Math.min(SW - 2, Math.floor(x))), Y = Math.max(0, Math.min(SH - 2, Math.floor(y))); const fx = Math.min(1, Math.max(0, x - X)), fy = Math.min(1, Math.max(0, y - Y));
    const g = (xx, yy) => sd[(yy * SW + xx) * sch + k] / smax; return toLin((g(X, Y) * (1 - fx) + g(X + 1, Y) * fx) * (1 - fy) + (g(X, Y + 1) * (1 - fx) + g(X + 1, Y + 1) * fx) * fy, slin); };
  for (const e of op.eyes) {
    const A = e.A; const map = (u, v) => [A[0] * u + A[1] * v + A[2], A[3] * u + A[4] * v + A[5]];
    const co = Math.cos(e.rot), si = Math.sin(e.rot); const rx = e.rx * W, ry = e.ry * W; const cx = e.cx * W, cy = e.cy * H; const R = Math.max(rx, ry) * 1.35;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
    // 外圈顏色比對（目標 vs 貼上來的來源），只做低頻修正
    const sumT = [0, 0, 0], sumS = [0, 0, 0]; let n = 0;
    const ell = (x, y) => { const dx = x - cx, dy = y - cy; const u = (co * dx + si * dy) / rx, v = (-si * dx + co * dy) / ry; return Math.hypot(u, v); };
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { const r = ell(x, y); if (r < 0.95 || r > 1.25) continue; const [su, sv] = map((x + 0.5) / W, (y + 0.5) / H); for (let k = 0; k < 3; k++) { sumT[k] += toLin(d[(y * W + x) * ch + k] / dmax, dlin); sumS[k] += sampS(su, sv, k); } n++; }
    const gain = [0, 1, 2].map(k => n && sumS[k] > 1e-4 ? Math.min(2.5, Math.max(0.4, sumT[k] / sumS[k])) : 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const r = ell(x, y); const a = 1 - Math.min(1, Math.max(0, (r - 0.7) / 0.3)); if (a <= 0) continue; const w2 = a * a * (3 - 2 * a) * (e.amt ?? 1);
      const [su, sv] = map((x + 0.5) / W, (y + 0.5) / H); const i = (y * W + x) * ch;
      for (let k = 0; k < 3; k++) { const t = toLin(d[i + k] / dmax, dlin); const sv2 = sampS(su, sv, k) * gain[k]; d[i + k] = Math.round(Math.min(1, Math.max(0, fromLin(t * (1 - w2) + sv2 * w2, dlin))) * dmax); }
    }
  }
}

// 自動偵測電線 / 細線：在天空範圍找細長的暗線（黑帽運算）
export function detectLines(imgData, skyMask) {
  const W = imgData.width, H = imgData.height, d = imgData.data;
  const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  const r = Math.max(2, Math.round(Math.max(W, H) / 300));
  const maxF = (a, horiz) => { const o = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = -1; for (let k = -r; k <= r; k++) { const X = horiz ? Math.max(0, Math.min(W - 1, x + k)) : x, Y = horiz ? y : Math.max(0, Math.min(H - 1, y + k)); m = Math.max(m, a[Y * W + X]); } o[y * W + x] = m; } return o; };
  const minF = (a, horiz) => { const o = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let m = 2; for (let k = -r; k <= r; k++) { const X = horiz ? Math.max(0, Math.min(W - 1, x + k)) : x, Y = horiz ? y : Math.max(0, Math.min(H - 1, y + k)); m = Math.min(m, a[Y * W + X]); } o[y * W + x] = m; } return o; };
  const close = minF(minF(maxF(maxF(g, true), false), true), false);
  const sky = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) sky[i] = skyMask[i] > 90 ? 1 : 0;
  const skyD = dilate(sky, W, H, r * 2);
  const m = new Uint8Array(W * H); let n = 0;
  for (let i = 0; i < W * H; i++) { const bh = close[i] - g[i]; if (skyD[i] && bh > 0.022 + 0.03 * (1 - close[i])) { m[i] = 1; n++; } }
  // 去掉孤立雜點
  const keep = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (!m[i]) continue; let c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c += m[i + dy * W + dx]; if (c >= 3) keep[i] = 1; }
  const out = dilate(keep, W, H, 1); let cnt = 0; for (let i = 0; i < W * H; i++) cnt += out[i];
  return { mask: out, count: cnt };
}
