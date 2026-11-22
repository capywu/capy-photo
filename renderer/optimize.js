// AI 最佳化修圖：判斷場景與主體 → 白平衡（膚色參考）→ 以畫質分數自動搜尋最佳曝光與色調 → 依場景加上合適的效果
import { Engine, DEFAULT_EDITS } from './engine.js';

let optEng = null;
function engineSmall() { if (!optEng) { const c = document.createElement('canvas'); c.width = c.height = 8; optEng = new Engine(c); optEng.lite = true; } return optEng; }

// 縮小來源（加速搜尋）
export function shrinkSource(src, maxSide = 520) {
  const W = src.width, H = src.height, s = Math.min(1, maxSide / Math.max(W, H));
  if (s >= 1) return src;
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s)), ch = src.channels || 3;
  const out = new src.data.constructor(w * h * ch); const step = 1 / s;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * step), y0 = Math.floor(y * step), x1 = Math.min(W, Math.floor((x + 1) * step)), y1 = Math.min(H, Math.floor((y + 1) * step));
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) { const i = (yy * W + xx) * ch; for (let k = 0; k < ch; k++) acc[k] += src.data[i + k]; n++; }
    for (let k = 0; k < ch; k++) out[(y * w + x) * ch + k] = acc[k] / Math.max(1, n);
  }
  return { ...src, width: w, height: h, data: out };
}

function maskWeights(m, w, h) {
  const person = new Float32Array(w * h), skin = new Float32Array(w * h), sky = new Float32Array(w * h);
  if (!m) return { person, skin, sky };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = Math.min(m.w - 1, Math.floor((x + 0.5) / w * m.w)), Y = Math.min(m.h - 1, Math.floor((y + 0.5) / h * m.h)); const i = (Y * m.w + X) * 4, o = y * w + x;
    person[o] = m.m2[i] / 255; skin[o] = m.m1[i] / 255; sky[o] = m.m2[i + 1] / 255;
  }
  return { person, skin, sky };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// 場景判斷
export function classifyScene(px, w, h, mw, m, info) {
  const n = w * h; let L = 0, sat = 0, warm = 0, skyA = 0, green = 0, personA = 0, bright = 0; const Ls = [];
  for (let i = 0; i < n; i++) {
    const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255; const l = lum(r, g, b); L += l; Ls.push(l);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const s = mx ? (mx - mn) / mx : 0; sat += s;
    if (r > b * 1.25 && r > g && l > 0.35) warm++;
    if (g > r * 1.1 && g > b * 1.1 && s > 0.2) green++;
    skyA += mw.sky[i]; personA += mw.person[i]; if (l > 0.85) bright++;
  }
  Ls.sort((a, b) => a - b);
  const mean = L / n, med = Ls[n >> 1];
  const iso = info?.iso || 0, brightFrac = bright / n;
  const faces = m?.faces || 0, faceFrac = m?.faceFrac || 0;
  let scene = 'general';
  if (faces && (faceFrac > 0.06 || personA / n > 0.15)) scene = faces >= 3 ? 'group' : 'portrait';
  else if (med < 0.15 && brightFrac > 0.0004) scene = 'night';
  else if (skyA / n > 0.12 && warm / n > 0.12) scene = 'sunset';
  else if (skyA / n > 0.1 || green / n > 0.25) scene = 'landscape';
  else if (!skyA && mean < 0.35) scene = 'indoor';
  return { scene, mean, med, sat: sat / n, skyFrac: skyA / n, personFrac: personA / n, warmFrac: warm / n, greenFrac: green / n, iso, faces };
}

// 畫質分數：亮度分佈（平均、對比幅度、黑白點）、Mertens 曝光適中與細節、飽和度目標、剪裁、臉部亮度、逆光
const TARGET = {
  portrait: { L: 0.47, std: 0.21, sat: 0.24 }, group: { L: 0.47, std: 0.21, sat: 0.25 }, landscape: { L: 0.44, std: 0.23, sat: 0.32 },
  sunset: { L: 0.40, std: 0.24, sat: 0.36 }, night: { L: 0.22, std: 0.20, sat: 0.28 }, indoor: { L: 0.44, std: 0.21, sat: 0.24 }, general: { L: 0.45, std: 0.22, sat: 0.28 }
};
function score(px, w, h, mw, sc) {
  const n = w * h; const T = TARGET[sc.scene] || TARGET.general;
  let sw = 0, sL = 0, sL2 = 0, sE = 0, sC = 0, sS = 0, hi = 0, lo = 0, fL = 0, fW = 0, subL = 0, subW = 0, bgL = 0, bgW = 0;
  const g = new Float32Array(n); for (let i = 0; i < n; i++) g[i] = lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) / 255;
  const Ls = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; const r = px[i * 4] / 255, gg = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255; const l = g[i];
    const wt = 1 + 1.5 * mw.person[i] + 2 * mw.skin[i];
    sw += wt; sL += l * wt; sL2 += l * l * wt; Ls.push(l);
    sE += Math.exp(-((l - 0.5) ** 2) / (2 * 0.2 * 0.2)) * wt;
    sC += Math.min(Math.abs(4 * l - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]), 0.25) * wt;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); sS += (mx ? (mx - mn) / mx : 0) * wt;
    if (mx > 0.985) hi += wt; if (mx < 0.012) lo += wt;
    if (mw.skin[i] > 0.5) { fL += l; fW++; }
    if (mw.person[i] > 0.5) { subL += l; subW++; } else { bgL += l; bgW++; }
  }
  Ls.sort((a, b) => a - b); const N = Ls.length; const p1 = Ls[Math.floor(N * 0.01)], p99 = Ls[Math.floor(N * 0.99)];
  const mean = sL / sw, std = Math.sqrt(Math.max(0, sL2 / sw - mean * mean)), sat = sS / sw;
  let S = 0;
  S -= Math.abs(mean - T.L) * 2.2;
  S -= Math.abs(std - T.std) * 2.5;
  S -= Math.abs(p1 - (sc.scene === 'night' ? 0.01 : 0.035)) * 3;
  if (sc.scene !== 'night') S -= Math.abs(p99 - 0.95) * 1.5;
  S += (sE / sw) * 0.35 + (sC / sw) * 1.5;
  S -= Math.max(0, Math.abs(sat - T.sat) - 0.03) * 2;
  S -= (hi / sw) * (sc.scene === 'night' ? 1 : 4) + (lo / sw) * 2;
  // 臉部亮度目標（膚色在 sRGB 亮度約 0.55–0.68 最自然）
  if (fW > 20) { const fl = fL / fW; S -= Math.max(0, Math.abs(fl - 0.6) - 0.04) * 3.5; }
  // 逆光：主體明顯比背景暗要扣分
  if (subW > 50 && bgW > 50) { const d = Math.log2((bgL / bgW + 0.02) / (subL / subW + 0.02)); if (d > 0.8) S -= (d - 0.8) * 0.4; }
  return S;
}

// 膚色參考白平衡：把臉部膚色推向標準膚色（Macbeth 色卡 light skin 約 194,150,130）
// 膚色風格目標（HSV 色相°、飽和度、明度）與白平衡參考比例
export const SKIN_STYLES = {
  asian: { name: '亞洲｜白裡透紅', H: 13, S: 0.33, V: 0.84, gr: 0.79, br: 0.70, blush: 16, even: 25 },
  natural: { name: '自然膚色', H: 21, S: 0.30, V: 0.80, gr: 0.775, br: 0.67, blush: 0, even: 15 },
  tan: { name: '小麥健康', H: 23, S: 0.40, V: 0.70, gr: 0.72, br: 0.58, blush: 0, even: 10 }
};
function skinWB(px, w, h, mw, style = SKIN_STYLES.asian) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < w * h; i++) if (mw.skin[i] > 0.6) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; n++; }
  if (n < 30) return null;
  const gr = g / r, br = b / r; const tg = style.gr, tb = style.br;
  // 只修正一部分（保留膚色深淺差異與現場氣氛）
    const dz = (v, z) => Math.abs(v) < z ? 0 : v - Math.sign(v) * z;   // 小偏差不動（保留膚色差異與現場氣氛）
  return { temp: Math.max(-20, Math.min(20, dz((br - tb) * 260 * 0.35, 4))), tint: Math.max(-15, Math.min(15, dz((gr - tg) * 300 * 0.3, 3))) };
}
// 量測臉部膚色（HSV）：排除陰影與高光
function skinHSV(px, w, h, mw) {
  let sx = 0, sy = 0, ss = 0, sv = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (mw.skin[i] < 0.6) continue;
    const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 0.25 || mx > 0.98) continue;
    const d = mx - mn; let hh = 0; if (d > 0) { if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4; } hh *= 60; if (hh < 0) hh += 360;
    sx += Math.cos(hh * Math.PI / 180); sy += Math.sin(hh * Math.PI / 180); ss += d / mx; sv += mx; n++;
  }
  if (n < 30) return null;
  let H = Math.atan2(sy, sx) * 180 / Math.PI; if (H < 0) H += 360; if (H > 180) H -= 360;
  return { H, S: ss / n, V: sv / n };
}

// 一般場景：Shades-of-Gray（p=6）中間調灰世界
function grayWB(px, w, h, cap = 30) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < w * h; i++) { const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2]; const l = (R + G + B) / 3; if (l < 25 || l > 235) continue; r += (R / 255) ** 6; g += (G / 255) ** 6; b += (B / 255) ** 6; }
  r = r ** (1 / 6); g = g ** (1 / 6); b = b ** (1 / 6); if (!r || !b) return null;
  return { temp: Math.max(-cap, Math.min(cap, Math.log(r / b) * -120 * 0.5)), tint: Math.max(-cap * 0.7, Math.min(cap * 0.7, Math.log(g / ((r + b) / 2)) * 150 * 0.5)) };
}

// 主程式：回傳最佳化後的修圖參數
export function optimize(src, look, masks, info, opts = {}) {
  const small = shrinkSource(src, 320);
  const eng = engineSmall(); eng.setSource(small); eng.setBase(look.lut, look.sat);
  if (masks) { eng.setMasks(masks); }
  const w = small.width, h = small.height;
  const mw = maskWeights(masks, w, h);
  const render = (e) => eng.renderPixels(e, w, h).data;
  const base = { ...DEFAULT_EDITS(), sharpen: 0, colorNoise: 25 };
  const px0 = render(base);
  const sc = classifyScene(px0, w, h, mw, masks, info);
  let e = { ...base };
  // 1. 白平衡
  const style = SKIN_STYLES[opts.skinStyle || 'asian'] || SKIN_STYLES.asian;
  const wb = (sc.scene === 'portrait' || sc.scene === 'group') ? (skinWB(px0, w, h, mw, style) || grayWB(px0, w, h)) : (sc.scene === 'sunset' || sc.scene === 'night') ? null : grayWB(px0, w, h);
  // 強烈色偏（例如室內鎢絲燈整片黃）：膚色和整體灰色都指向同一方向時，允許更大幅度的修正
  if (wb && (sc.scene === 'portrait' || sc.scene === 'group')) {
    const gw = grayWB(px0, w, h, 60);
    if (gw && Math.sign(gw.temp) === Math.sign(wb.temp) && Math.abs(gw.temp) > 18) wb.temp = Math.sign(gw.temp) * Math.min(50, Math.max(Math.abs(wb.temp), Math.abs(gw.temp) * 0.75));
    if (gw && Math.sign(gw.tint) === Math.sign(wb.tint) && Math.abs(gw.tint) > 12) wb.tint = Math.sign(gw.tint) * Math.min(30, Math.max(Math.abs(wb.tint), Math.abs(gw.tint) * 0.7));
  }
  if (wb) { e.temp = Math.round(wb.temp); e.tint = Math.round(wb.tint); }
  // 2. 以分數搜尋曝光與色調（座標下降）
  const lim = { exposure: [-2, 2.5], highlights: [-80, 20], shadows: [-20, 70], whites: [-40, 40], blacks: [-40, 25], contrast: [-30, 40], vibrance: [-10, 45] };
  const steps = { exposure: 0.4, highlights: 20, shadows: 20, whites: 15, blacks: 12, contrast: 12, vibrance: 15 };
  let best = score(render(e), w, h, mw, sc);
  for (let round = 0; round < 2; round++) {
    for (const k of Object.keys(steps)) {
      const st = steps[k] / (round + 1);
      for (const dir of [1, -1]) {
        const v = Math.max(lim[k][0], Math.min(lim[k][1], (e[k] || 0) + dir * st));
        if (v === e[k]) continue;
        const cand = { ...e, [k]: v }; const s = score(render(cand), w, h, mw, sc);
        if (s > best + 1e-4) { best = s; e = cand; break; }
      }
    }
  }
  e.exposure = Math.round(e.exposure * 20) / 20;
  for (const k of ['highlights', 'shadows', 'whites', 'blacks', 'contrast', 'vibrance']) e[k] = Math.round(e[k]);
  // 3. 逆光：主體補光
  if (masks?.hasPerson && sc.personFrac > 0.08) {
    let sl = 0, sw = 0, bl = 0, bw = 0; const px = render(e);
    for (let i = 0; i < w * h; i++) { const l = lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) / 255; if (mw.person[i] > 0.5) { sl += l; sw++; } else { bl += l; bw++; } }
    if (sw && bw) { const d = Math.log2((bl / bw + 0.02) / (sl / sw + 0.02)); if (d > 0.6) e.subjectLight = Math.min(60, Math.round((d - 0.4) * 45)); }
  }
  // 4. 依場景加上效果
  const iso = sc.iso;
  if (iso >= 1600) e.denoise = Math.min(60, Math.round((Math.log2(iso / 800)) * 15)), e.colorNoise = 40;
  e.sharpen = sc.scene === 'portrait' ? 20 : 35;
  const P = opts.portrait !== false;
  switch (sc.scene) {
    case 'portrait': case 'group':
      if (P) Object.assign(e, { smooth: 25, blemish: 40, matte: 20, darkCircle: 20, eyeBright: 15, teeth: 15, faceLight: 8 });
      e.vibrance = Math.min(e.vibrance, 25);
      if (masks?.hasPerson && sc.personFrac < 0.6) e.bgSat = -8;
      // 膚色調整：把臉部膚色推向選擇的風格（亞洲：減黃、帶粉、提亮但不死白）
      if (masks?.faces) {
        e.skinHue = 0; e.skinSat = 0; e.skinLum = 0;
        for (let it = 0; it < 3; it++) {
          const m = skinHSV(render(e), w, h, mw); if (!m) break;
          const k = it === 0 ? 0.85 : 0.6;
          // 只往目標走 70%，並限制幅度，保留個人膚色差異、避免死白或發灰
          e.skinHue = Math.max(-70, Math.min(45, e.skinHue + (style.H - m.H) / 0.108 * k * 0.7));
          e.skinSat = Math.max(-35, Math.min(40, e.skinSat + ((style.S / Math.max(m.S, 0.05)) - 1) / 0.6 * 100 * k * 0.7));
          e.skinLum = Math.max(-25, Math.min(28, e.skinLum + ((style.V / Math.max(m.V, 0.1)) - 1) / 0.25 * 100 * k * 0.7));
        }
        e.skinHue = Math.round(e.skinHue); e.skinSat = Math.round(e.skinSat); e.skinLum = Math.round(e.skinLum);
        if (P) { e.blush = style.blush; e.skinEven = Math.max(e.skinEven || 0, style.even); }
      }
      break;
    case 'landscape':
      Object.assign(e, { structure: 18, clarity: 8, dehaze: masks?.hasDepth ? 8 : 5 });
      if (masks?.hasSky) e.sky = 30;
      break;
    case 'sunset':
      Object.assign(e, { twilight: 20, structure: 10 }); e.vibrance = Math.max(e.vibrance, 20);
      break;
    case 'night':
      e.highlights = Math.min(e.highlights, -30); e.blacks = Math.min(e.blacks, 0); e.glow = 15; e.denoise = Math.max(e.denoise || 0, 25);
      break;
    case 'indoor':
      e.shadows = Math.max(e.shadows, 15);
      break;
  }
  const strength = opts.strength ?? 1;
  if (strength !== 1) for (const k of Object.keys(e)) if (typeof e[k] === 'number' && k !== 'sharpen' && k !== 'colorNoise') e[k] = Math.round(e[k] * strength * 100) / 100;
  return { edits: e, scene: sc };
}

export const SCENE_NAMES = { portrait: '人像', group: '團體照', landscape: '風景', sunset: '夕陽 / 黃昏', night: '夜景', indoor: '室內', general: '一般' };
