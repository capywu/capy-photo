// Capy Photo 影像處理引擎（WebGL2）
// 流程：RAW 線性資料 → 白平衡/曝光/液化 → 多層模糊與雙邊濾波 → 人像 AI / 背景 / 天空 → 色調 → 色彩 → 輸出
export const DEFAULT_EDITS = () => ({
  temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0, clarity: 0, dehaze: 0, texture: 0,
  sharpen: 25, denoise: 0, colorNoise: 25,
  hslH: [0, 0, 0, 0, 0, 0, 0, 0], hslS: [0, 0, 0, 0, 0, 0, 0, 0], hslL: [0, 0, 0, 0, 0, 0, 0, 0],
  curve: [[0, 0], [0.25, 0.25], [0.75, 0.75], [1, 1]],
  vignette: 0, grain: 0, bw: false,
  smooth: 0, blemish: 0, darkCircle: 0, teeth: 0, eyeBright: 0, eyeEnlarge: 0, slim: 0, subjectLight: 0, skinEven: 0,
  bgBlur: 0, sky: 0,
  enhance: 0, enhanceVec: null, structure: 0, matte: 0, skinHue: 0, skinSat: 0, skinLum: 0,
  faceLight: 0, contour: 0, lips: 0, brows: 0, blush: 0, bgLight: 0, bgSat: 0, bgClean: 0,
  cgSh: 0, cgSs: 0, cgSl: 0, cgMh: 0, cgMs: 0, cgMl: 0, cgHh: 0, cgHs: 0, cgHl: 0, cgGh: 0, cgGs: 0, cgGl: 0, cgBlend: 50, cgBal: 0, pointColors: [],
  lensProf: false, lensP: null, lensName: '', geoV: 0, geoH: 0, geoScale: 0,
  aiDenoise: 0, lowLight: 0, fivekAmt: 0, fivekW: null, rosy: 0, atmo: 0, atmoNear: 40, atmoTone: 0, ldepth: 0, scHi: 0, scMid: 0, scLo: 0, rays: 0, raysLen: 50, raysWarm: 50, sun: null, lensDist: 0, lensCA: 0, lutPath: null, lutAmt: 100,
  skyRep: 0, skyType: 'blue', skyX: 0, skyHorizon: 0, skyBlend: 20, skyBlur: 0, skyExp: 0, skyTemp: 0, skyRelight: 40, skyHaze: 0, skyDetail: 50, skyReflect: 0, skyImg: null, fog: 0, dust: 0, cm: null, cmAmt: 0,
  hairAmt: 0, hairColor: 'brown', hairLum: 0, waist: 0, bodySlim: 0, water: 0, waterColor: 0,
  mist: 0, mistSize: 50, mistSoft: 40, mistWarm: true,
  gradeSH: 200, gradeSS: 0, gradeHH: 40, gradeHS: 0, gradeBal: 0, chrome: 0, chromeBlue: 0, bleach: 0, bwFilter: 'none', bwToneH: 35, bwToneS: 0, film: null,
  deblur: 0, defocus: 0, defocusR: 30, focus: null, focusAmt: 0, focusRange: 15,
  glow: 0, halation: 0, star: 0, twilight: 0, bgRep: 0, bgType: 'white', bgColor: '#ffffff', local: [], heal: [],
  crop: { cx: 0.5, cy: 0.5, w: 1, h: 1, angle: 0, aspect: 'free' }
});

export const isDefault = (e) => JSON.stringify({ ...e, crop: null, enhanceVec: null, cm: null, focus: null, film: null, local: (e.local || []).length, heal: (e.heal || []).length }) === JSON.stringify({ ...DEFAULT_EDITS(), crop: null, enhanceVec: null, cm: null, focus: null, film: null, local: 0, heal: 0 }) && isFullCrop(e.crop);
export const isFullCrop = (c) => !c || (c.w === 1 && c.h === 1 && c.cx === 0.5 && c.cy === 0.5 && !c.angle);

// 智慧增強：一個滑桿帶動多項調整（依照片分析出的向量）
export function effective(e) {
  if (!e.enhance || !e.enhanceVec) return e;
  const k = e.enhance / 100, o = { ...e };
  for (const [key, v] of Object.entries(e.enhanceVec)) o[key] = (o[key] || 0) + v * k;
  return o;
}
const SKY_TYPES = { blue: 0, sunset: 1, dusk: 2, clear: 3, cloudy: 4, golden: 5, night: 6, storm: 7, custom: 9 };

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const WARP = `
uniform int uPins; uniform vec4 uPinA[48]; uniform vec4 uPinB[48]; uniform vec2 uAspect;
uniform int uBodyN; uniform vec2 uBodyY; uniform vec4 uBody[48];
// 該列的身形資料：x＝中心、y＝半寬、z＝強度、w＝是否有效
vec4 bodyRow(float y){
  if(uBodyN <= 0) return vec4(0.);
  float t = (y - uBodyY.x) / (uBodyY.y - uBodyY.x) * float(uBodyN) - 0.5;
  if(t <= -1.0 || t >= float(uBodyN)) return vec4(0.);
  int i0 = int(clamp(floor(t), 0., float(uBodyN-1))); int i1 = min(i0 + 1, uBodyN - 1);
  vec4 r = mix(uBody[i0], uBody[i1], clamp(t - floor(t), 0., 1.));
  r.z *= clamp(min(t + 1.0, float(uBodyN) - t), 0., 1.); r.w = 1.0; return r;
}
vec2 warpUV(vec2 uv){
  vec2 q = uv;
  // 身形：依人物輪廓逐列把軀幹往中心線收（腰身＋整體瘦身）
  vec4 br = bodyRow(uv.y);
  // 軀幹內線性收窄；軀幹外（手臂）整段平移，平移量往外平滑歸零（背景由合成保留原位）
  if(br.w > 0. && br.z != 0.){ float hw = max(br.y, 0.004); float sft = clamp(br.z, -0.3, 0.45) * hw * 0.6; float dd = uv.x - br.x; float ad = abs(dd);
    float inner = hw - sft; float D = max(hw * 1.3, abs(sft) * 2.5); float ds;
    if(ad < inner) ds = ad * hw / inner; else ds = ad + sft * (1.0 - smoothstep(hw * 2.0, hw * 3.1, ad));
    q.x = br.x + sign(dd) * ds; }
  for(int i=0;i<48;i++){ if(i>=uPins) break;
    vec4 a = uPinA[i]; vec4 b = uPinB[i];
    vec2 d = (uv - a.xy) * uAspect; float r = a.z; float dist = length(d);
    if(dist >= r) continue;
    float f = 1.0 - dist/r; f = f*f*(3.0-2.0*f);
    if(a.w < 0.5){ q -= (uv - a.xy) * b.x * f; }          // 放大（眼睛）
    else { q -= b.xy * f; }                                   // 推移（瘦臉）
  }
  return q;
}`;

const LUM = `float lum(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }`;

// Pass 1：讀取 16-bit 線性資料，套白平衡、曝光、液化
const FS_BASE = `#version 300 es
precision highp float; precision highp usampler2D;
in vec2 uv; out vec4 o;
uniform usampler2D uSrc; uniform vec2 uSrcSize; uniform vec3 uMul; uniform float uScale; uniform int uIsSRGB;
uniform sampler2D uPM; uniform int uHasPM;
${WARP}
vec3 fetch(ivec2 p){ p = clamp(p, ivec2(0), ivec2(uSrcSize)-1); vec3 c = vec3(texelFetch(uSrc, p, 0).rgb) * uScale;
  if(uIsSRGB==1) c = mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); return c; }
vec3 samp(vec2 u){ vec2 q = u * uSrcSize - 0.5; ivec2 i0 = ivec2(floor(q)); vec2 f = fract(q);
  return mix(mix(fetch(i0), fetch(i0+ivec2(1,0)), f.x), mix(fetch(i0+ivec2(0,1)), fetch(i0+ivec2(1,1)), f.x), f.y); }
void main(){
  vec2 wq = warpUV(uv);
  vec3 c = samp(wq);
  // 身形調整只移動人物：背景維持原位，人物收窄後露出的地方用身體邊緣外側的背景鏡射補上
  vec4 br = bodyRow(uv.y);
  if(uHasPM == 1 && br.w > 0. && br.z != 0. && abs(uv.x - br.x) < br.y * 3.2){
    float aNew = smoothstep(0.45, 0.75, texture(uPM, wq).r);
    // 原本人物範圍用「擴張後」的遮罩，連遮罩邊緣沒抓滿的手臂、髮絲也一起換成背景，避免殘影
    float dl = 0.012; float mo = texture(uPM, uv).r; for(int k = 1; k <= 4; k++){ float o2 = dl * float(k) / 4.0; mo = max(mo, max(texture(uPM, uv + vec2(o2, 0.)).r, texture(uPM, uv - vec2(o2, 0.)).r) * (1.0 - float(k) * 0.08)); }
    float aOld = smoothstep(0.2, 0.5, mo);
    vec3 bg = samp(uv);
    if(aOld > 0.01){
      float sgn = uv.x >= br.x ? 1.0 : -1.0; float st = 1.5 / uSrcSize.x * max(1.0, uSrcSize.x / 800.0); float e = uv.x;
      for(int k = 0; k < 160; k++){ e += sgn * st; if(texture(uPM, vec2(e, uv.y)).r < 0.12 || e < 0. || e > 1.) break; } e += sgn * 0.012;
      float m = clamp(e + (e - uv.x) + sgn * st * 2.0, 0., 1.);
      // 鏡射點如果落在手臂等人物上，繼續往外找下一段背景
      if(texture(uPM, vec2(m, uv.y)).r > 0.3){ float m2 = m; for(int k = 0; k < 120; k++){ m2 += sgn * st; if(m2 < 0. || m2 > 1. || texture(uPM, vec2(m2, uv.y)).r < 0.2) break; } m = clamp(m2 + sgn * st * 3.0 + (m - e) * 0.5, 0., 1.); }
      bg = mix(bg, samp(vec2(m, uv.y)), aOld);
    }
    // 遮罩不確定的地方（手臂貼著身體、顏色接近背景）不做合成，改用一般液化，避免撕裂與殘影
    float m1v = texture(uPM, uv).r, m2v = texture(uPM, wq).r; float conf = min(abs(m1v * 2.0 - 1.0), abs(m2v * 2.0 - 1.0));
    c = mix(c, mix(bg, c, aNew), smoothstep(0.45, 0.85, conf));
  }
  o = vec4(c * uMul, 1.0);
}`;

const FS_COPY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, uv); }`;

// 透視校正參數：自動放大到四角都在照片內（不出現黑邊）
function geoU(e) {
  const gx = -(e.geoV || 0) / 100 * 0.6, gy = -(e.geoH || 0) / 100 * 0.6; let z = 1;
  for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) { const den = Math.max(0.2, 1 + gx * y * 1.6 + gy * x * 1.6); z = Math.max(z, 1 / den); }
  return [gx, gy, (1 + (e.geoScale || 0) / 100) * z];
}
// 筆畫轉點陣（灰階，128＝不變，筆刷往 255、橡皮擦往 0）
const _rc = {};
export function rasterStrokes(strokes, w, h) {
  let c = _rc[w + 'x' + h]; if (!c) c = _rc[w + 'x' + h] = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true }); x.globalCompositeOperation = 'source-over'; x.fillStyle = 'rgb(128,128,128)'; x.fillRect(0, 0, w, h);
  const L = Math.max(w, h);
  for (const s of strokes) {
    const r = Math.max(1, s.r * L), f = Math.min(0.98, s.f ?? 0.5), fl = s.flow ?? 0.8; const col = s.erase ? '0,0,0' : '255,255,255';
    const dab = (px, py) => { const g = x.createRadialGradient(px, py, r * (1 - f), px, py, r); g.addColorStop(0, `rgba(${col},${fl})`); g.addColorStop(1, `rgba(${col},0)`); x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill(); };
    const pts = s.pts; let prev = null; const step = Math.max(1, r * 0.22);
    for (const [u, v] of pts) { const px = u * w, py = v * h;
      if (!prev) { dab(px, py); prev = [px, py]; continue; }
      const dx = px - prev[0], dy = py - prev[1], dl = Math.hypot(dx, dy); if (dl < step) continue;
      const n = Math.floor(dl / step); for (let k = 1; k <= n; k++) dab(prev[0] + dx * k / n, prev[1] + dy * k / n); prev = [px, py]; }
  }
  return x.getImageData(0, 0, w, h).data;
}

// 局部圖層（筆刷 / AI 範圍）：在完成的畫面上逐層套用局部調整
const FS_LOCAL = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform int uShowM, uShowC; uniform sampler2D uF, uM1, uM2, uM3, uM4, uL0, uL1, uWt, uBase, uSkyRef, uFgRef, uSkyImg; uniform int uN, uFlip, uHasMask, uShow, uSkyType, uHasSkyImg, uHasRef;
uniform highp sampler3D uLut, uFive; uniform sampler2D uLowG; uniform int uHasLut, uHasDepth, uHasFive, uHasLow; uniform float uFiveAmt, uLowAmt; uniform float uLutAmt, uAtmo, uAtmoNear, uAtmoTone, uLDepth, uScHi, uScMid, uScLo, uRays, uRaysLen, uRaysWarm; uniform vec2 uSun;
uniform float uSkyRep, uSkyX, uSkyHor, uSkyBlend, uSkyBlur, uSkyExp, uSkyTemp, uSkyRelight, uSkyHaze, uSkyDetail, uSkyReflect, uSkyBottom, uSkyImgAsp, uTime;
uniform vec4 uCrop; uniform float uAngle; uniform vec4 uView; uniform vec2 uSrcPx; uniform float uLensK; uniform vec4 uLP, uLP2; uniform vec3 uGeo;
uniform vec4 uP0[8]; uniform vec4 uP1[8]; uniform vec4 uP2[8]; uniform vec4 uP3[8]; uniform vec4 uP4[8]; uniform vec4 uP5[8]; uniform vec4 uP6[8];
${WARP}
float lum(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
vec3 rgb2hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); float e=1e-10; return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)),d/(q.x+e),q.x); }
vec3 baseC(vec3 c){ vec3 x = clamp((log2(max(c, vec3(1e-6))) + 12.0) / 14.0, 0.0, 1.0); x = (x * 1023.0 + 0.5) / 1024.0;
  return vec3(texture(uBase, vec2(x.r,.25)).r, texture(uBase, vec2(x.g,.25)).r, texture(uBase, vec2(x.b,.25)).r); }
float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash2(i),hash2(i+vec2(1,0)),f.x), mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0., a=0.5; for(int i=0;i<7;i++){ v+=a*vnoise(p); p=p*2.02+vec2(1.7,9.2); a*=0.5; } return v; }
// 程序天空：漸層＋透視雲層（越近地平線越小越扁）＋雲的受光面與陰影＋太陽光暈
vec3 procSky(vec2 p, float asp, float hor){
  float t = clamp(p.y / max(hor, 0.12), 0., 1.2);
  vec3 top, mid, low; float cov = 0.5, sunY = 1.1, sunA = 0.; vec3 sunC = vec3(1.0, 0.85, 0.6);
  if(uSkyType==0){ top=vec3(0.10,0.28,0.68); mid=vec3(0.30,0.52,0.85); low=vec3(0.68,0.80,0.95); }
  else if(uSkyType==1){ top=vec3(0.16,0.18,0.42); mid=vec3(0.75,0.42,0.38); low=vec3(1.0,0.62,0.25); cov=0.42; sunY=0.95; sunA=1.0; sunC=vec3(1.0,0.7,0.35); }
  else if(uSkyType==2){ top=vec3(0.14,0.12,0.36); mid=vec3(0.55,0.36,0.62); low=vec3(0.98,0.62,0.58); cov=0.35; sunY=1.05; sunA=0.5; sunC=vec3(1.,0.6,0.6); }
  else if(uSkyType==3){ top=vec3(0.06,0.24,0.66); mid=vec3(0.24,0.50,0.88); low=vec3(0.62,0.80,0.97); cov=0.; }
  else if(uSkyType==4){ top=vec3(0.38,0.43,0.52); mid=vec3(0.58,0.62,0.69); low=vec3(0.76,0.79,0.83); cov=0.85; }
  else if(uSkyType==5){ top=vec3(0.24,0.36,0.62); mid=vec3(0.85,0.66,0.45); low=vec3(1.0,0.82,0.52); cov=0.38; sunY=0.88; sunA=0.8; sunC=vec3(1.0,0.86,0.55); }
  else if(uSkyType==6){ top=vec3(0.01,0.02,0.06); mid=vec3(0.03,0.05,0.13); low=vec3(0.10,0.12,0.22); cov=0.15; }
  else { top=vec3(0.16,0.18,0.22); mid=vec3(0.28,0.30,0.35); low=vec3(0.45,0.46,0.50); cov=0.95; }
  vec3 col = t < 0.55 ? mix(top, mid, smoothstep(0., 0.55, t)) : mix(mid, low, smoothstep(0.55, 1.0, t));
  if(uSkyType==6){ float st = step(0.996, hash2(floor(p*vec2(asp,1.)*900.))) * (1.0 - t); col += vec3(st) * 0.9; }
  if(sunA > 0.){ vec2 sp = vec2((p.x - 0.62) * asp, (t - sunY) * hor); float sd = length(sp); col += sunC * (exp(-sd*sd*60.) * 0.9 + exp(-sd*7.0) * 0.35) * sunA; }
  if(cov > 0.){
    float per = 1.0 / (0.25 + t * 1.6);
    vec2 q = vec2((p.x - 0.5) * asp * per * 2.2 + 3.1, per * 3.2 + 1.7);
    vec2 wq = q + 0.6 * vec2(fbm(q * 0.7), fbm(q * 0.7 + 5.2));
    float n = fbm(wq); float c = smoothstep(0.62 - cov * 0.3, 0.92 - cov * 0.15, n);
    float sh = smoothstep(0.0, 0.18, fbm(wq + vec2(0.0, 0.08)) - n);  // 受光面（上方較亮）
    vec3 lit = uSkyType==1||uSkyType==5 ? vec3(1.0,0.78,0.55) : uSkyType==2 ? vec3(1.0,0.82,0.86) : uSkyType==6 ? vec3(0.12,0.13,0.2) : vec3(1.0);
    vec3 dark = uSkyType==7||uSkyType==4 ? vec3(0.32,0.34,0.38) : mix(col, vec3(0.55,0.58,0.66), 0.6) * (uSkyType==1 ? vec3(0.8,0.6,0.7) : vec3(1.));
    vec3 cc = mix(dark, lit, clamp(0.45 + sh * 0.9 - (n - 0.7) * 0.8, 0., 1.));
    col = mix(col, cc, c * (1.0 - smoothstep(0.85, 1.15, t) * 0.6));
  }
  return clamp(col, 0., 1.);
}
vec3 newSky(vec2 su, float asp, float hor){
  vec2 p = vec2(su.x + uSkyX, su.y);
  if(uSkyType==9 && uHasSkyImg==1){
    float Hr = hor + 0.06; float ar = asp / Hr; float k = uSkyImgAsp / ar; vec2 uv;
    if(k >= 1.0) uv = vec2(0.5 + (p.x - 0.5) / k, p.y / Hr); else uv = vec2(p.x, 1.0 - (Hr - p.y) / Hr * k);
    uv.x = fract(uv.x); return textureLod(uSkyImg, clamp(uv, 0.001, 0.999), uSkyBlur * 6.0).rgb;
  }
  vec3 c = procSky(p, asp, hor); if(uSkyBlur > 0.){ c = mix(c, procSky(p + vec2(0.003, 0.), asp, hor) * 0.5 + procSky(p - vec2(0., 0.004), asp, hor) * 0.5, uSkyBlur); }
  return c;
}
vec2 outToSrc(vec2 ou){
  vec2 q = uView.xy + (ou - 0.5) * uView.zw; vec2 cropPx = uCrop.zw * uSrcPx;
  vec2 p = (uCrop.xy - 0.5) * uSrcPx + (q - 0.5) * cropPx; float s = sin(uAngle), co = cos(uAngle);
  p = vec2(co*p.x - s*p.y, s*p.x + co*p.y); vec2 r0 = (0.5 * uSrcPx + p) / uSrcPx;
  if(uGeo.x != 0. || uGeo.y != 0. || uGeo.z != 1.0){ vec2 pp = (r0 - 0.5) / uGeo.z; float den = 1.0 + uGeo.x * pp.y * 1.6 + uGeo.y * pp.x * 1.6; pp /= max(den, 0.2); r0 = 0.5 + pp; }
  if(uLensK != 0.){ vec2 dd = (r0 - 0.5) * vec2(uSrcPx.x / uSrcPx.y, 1.0); float r2 = dot(dd, dd) / (0.25 * (uSrcPx.x*uSrcPx.x/(uSrcPx.y*uSrcPx.y)) + 0.25); r0 = 0.5 + (r0 - 0.5) * (1.0 + uLensK * r2) / (1.0 + max(uLensK, 0.)); }
  if(uLP.x > 0.5){ vec2 pp = (r0 - 0.5) * uSrcPx / (0.5 * min(uSrcPx.x, uSrcPx.y)) * uLP2.z; float ru = length(pp); float rd = ru;
    if(uLP.x < 1.5) rd = ru * (1.0 - uLP2.x + uLP2.x * ru * ru); else if(uLP.x < 2.5) rd = ru * (1.0 + uLP2.x * ru * ru + uLP2.y * ru * ru * ru * ru); else rd = ru * (uLP.y * ru * ru * ru + uLP.z * ru * ru + uLP.w * ru + 1.0 - uLP.y - uLP.z - uLP.w);
    float k = ru > 1e-5 ? rd / ru : 1.0; r0 = 0.5 + (r0 - 0.5) * k / uLP2.w; }
  return r0;
}
void main(){
  vec2 ou = vec2(uv.x, uFlip==1 ? 1.0-uv.y : uv.y);
  vec3 d = texture(uF, ou).rgb; vec2 su = outToSrc(ou);
  if(su.x<0.||su.y<0.||su.x>1.||su.y>1.){ o = vec4(d,1.); return; }
  vec4 m1 = vec4(0.), m2 = vec4(0.), m3 = vec4(0.), m4 = vec4(0.);
  if(uHasMask==1){ vec2 mu = warpUV(su); m1 = texture(uM1, mu); m2 = texture(uM2, mu); m3 = texture(uM3, mu); m4 = texture(uM4, mu); }
  // ── 天空替換：粗略 AI 範圍＋逐像素顏色分離（前景色 / 天空色投影），用「去除原本天空成分」的方式合成，樹枝電線邊緣不糊 ──
  if(uSkyRep > 0. && uHasRef == 1){
    vec2 mu = warpUV(su); float reg = m4.a, coarse = m2.g;
    if(reg > 0.003 || uSkyReflect > 0.){
      vec3 p0 = clamp(baseC(texture(uWt, su).rgb), 0., 1.);
      vec3 sr = texture(uSkyRef, mu).rgb, fr = texture(uFgRef, mu).rgb; vec3 df = sr - fr; float dd = dot(df, df);
      float af = dd > 0.003 ? clamp(dot(p0 - fr, df) / dd, 0., 1.) : coarse;
      float sharp = 0.05 + 0.4 * uSkyDetail; af = smoothstep(sharp * 0.5, 1.0 - sharp * 0.5, af);
      float a = min(af, smoothstep(0.0, 0.35, reg)); a = max(a, coarse * (1.0 - uSkyDetail) * step(0.97, coarse));
      float hor = clamp(uSkyBottom + uSkyHor, 0.08, 1.0); float asp = uSrcPx.x / uSrcPx.y;
      vec3 ns = newSky(su, asp, hor) * exp2(uSkyExp); ns *= vec3(1.0 + uSkyTemp * 0.15, 1.0, 1.0 - uSkyTemp * 0.15);
      // 地平線融合：靠近地平線的部分與原本天空混合，過渡更自然
      float hb = smoothstep(hor - 0.25 * uSkyBlend - 0.001, hor, su.y) * uSkyBlend; vec3 g = clamp(d / max(p0, vec3(0.03)), 0., 3.);
      vec3 skyNow = sr * g; ns = mix(ns, mix(ns, vec3(dot(ns, vec3(0.333))) * 0.3 + skyNow * 0.7, 0.5), hb * 0.7);
      vec3 rep = d + a * (ns - skyNow);
      // 場景配色：前景依新天空的平均色調整（暖夕陽、冷陰天）
      vec3 avg = newSky(vec2(0.5, hor * 0.7), asp, hor) * exp2(uSkyExp); vec3 tint = avg / max(dot(avg, vec3(0.333)), 0.02); vec3 oldT = sr / max(dot(sr, vec3(0.333)), 0.02);
      vec3 rel = clamp(rep * mix(vec3(1.0), tint / oldT, 0.45 * uSkyRelight), 0., 1.);
      rep = mix(rep, rel, (1.0 - a) * smoothstep(0.0, 0.1, hor));
      // 大氣霧化：地平線附近前景帶一點天空色
      rep = mix(rep, avg, (1.0 - a) * uSkyHaze * 0.45 * smoothstep(hor - 0.35, hor + 0.05, su.y) * (1.0 - smoothstep(hor + 0.05, hor + 0.4, su.y)));
      // 水面倒影
      if(uSkyReflect > 0. && m4.g > 0.02 && su.y > hor){ vec2 rs = vec2(su.x, max(0., 2.0 * hor - su.y)); vec3 rc = newSky(rs, asp, hor) * exp2(uSkyExp) * 0.75; float lw = lum(p0); rep = mix(rep, rc * (0.6 + lw * 0.8), m4.g / 255.0 * 255.0 * uSkyReflect * 0.6); }
      d = mix(d, clamp(rep, 0., 1.), uSkyRep);
    }
  }
  vec3 lo1 = textureLod(uF, ou, 2.5).rgb, lo2 = textureLod(uF, ou, 4.5).rgb;
  float z = uHasDepth == 1 ? m4.b : clamp(su.y * 1.2 - 0.1, 0., 1.);   // 1＝近、0＝遠（沒有深度圖就用畫面上下估計）
  // ── 立體光影（Light Depth）：近處亮、遠處暗（或相反）──
  if(uLDepth != 0.){ d = clamp(d * (1.0 + uLDepth * 0.45 * (z - 0.5) * 2.0), 0., 1.); }
  // ── 大氣：依深度加入霧氣、薄霧，越遠越濃，帶雲霧紋理 ──
  if(uAtmo > 0.){
    float far = 1.0 - smoothstep(uAtmoNear * 0.9, uAtmoNear * 0.9 + 0.55, z);
    vec2 np = vec2(su.x * uSrcPx.x / uSrcPx.y, su.y) * 3.0 + vec2(z * 1.7, 0.);
    float n = fbm(np) * 0.7 + fbm(np * 2.3 + 4.1) * 0.3;
    float f = clamp(uAtmo * far * (0.65 + 0.7 * n), 0., 0.95);
    vec3 fc = mix(vec3(0.82, 0.86, 0.92), vec3(0.98, 0.86, 0.68), uAtmoTone); fc = mix(fc, lo2 * 0.4 + fc * 0.6, 0.35);
    d = mix(d, fc, f); d = mix(d, lo1, f * 0.25);
  }
  // ── 超級對比：亮部、中間調、暗部分開加強局部對比 ──
  if(uScHi != 0. || uScMid != 0. || uScLo != 0.){
    float L = lum(d); float wh = smoothstep(0.5, 0.85, L), wl = 1.0 - smoothstep(0.15, 0.45, L), wm = clamp(1.0 - wh - wl, 0., 1.);
    float k = uScHi * wh + uScMid * wm + uScLo * wl; d = clamp(d + (d - lo2) * k * 0.9 + (L - 0.5) * k * 0.15 * vec3(1.0), 0., 1.);
  }
  // ── AI 暗部提亮（Zero-DCE 增益圖，暗處提得多、亮處幾乎不動）──
  if(uHasLow == 1 && uLowAmt > 0.){ float gn = 1.0 + texture(uLowG, su).r * 3.0; float L0 = lum(d); vec3 dl = d * mix(1.0, gn, uLowAmt); float L1 = lum(dl); d = clamp(mix(dl, dl * (0.92 + 0.08 * L0 / max(L1, 0.01)), 0.5), 0., 1.); }
  // ── AI 專業調色（FiveK 自適應 3D LUT）──
  if(uHasFive == 1 && uFiveAmt > 0.){ d = mix(d, texture(uFive, clamp(d, 0., 1.)).rgb, uFiveAmt); }
  // ── 3D LUT（.cube 色彩風格檔）──
  if(uHasLut == 1 && uLutAmt > 0.){ d = mix(d, texture(uLut, clamp(d, 0., 1.)).rgb, uLutAmt); }
  // ── 陽光光束（Sunrays）：從太陽位置沿射線累積亮部，被樹葉、建築遮住的地方自然形成光束 ──
  if(uRays > 0.){
    vec2 dir = uSun - ou; float acc = 0.; float wsum = 0.; const int NS = 36;
    for(int i = 1; i <= NS; i++){ float t = float(i) / float(NS) * uRaysLen; vec2 p = ou + dir * t; if(p.x < 0. || p.y < 0. || p.x > 1. || p.y > 1.) break;
      float b = smoothstep(0.42, 0.95, lum(textureLod(uF, p, 2.5).rgb)); float w = 1.0 - float(i) / float(NS + 4); acc += b * w; wsum += w; }
    float ray = wsum > 0. ? acc / wsum : 0.;
    float sd = length((ou - uSun) * vec2(uSrcPx.x / uSrcPx.y * uCrop.z / uCrop.w, 1.0));
    vec3 rc = mix(vec3(1.0, 0.97, 0.9), vec3(1.0, 0.78, 0.45), uRaysWarm);
    vec3 add = rc * (ray * 1.25 * (0.4 + 0.6 * exp(-length(ou - uSun) * 1.5)) + exp(-sd * sd * 90.) * 0.6 + exp(-sd * 6.0) * 0.25) * uRays;
    d = 1.0 - (1.0 - d) * (1.0 - clamp(add, 0., 1.));
  }
  vec4 b0 = texture(uL0, su), b1 = texture(uL1, su);
  float showW = 0.;
  for(int k=0;k<8;k++){ if(k>=uN) break;
    vec4 P0 = uP0[k], P1 = uP1[k], P2 = uP2[k], P3 = uP3[k];
    int mt = int(P3.x + 0.5); float ai = 0.;
    if(mt==1) ai = m2.r; else if(mt==2) ai = 1.0 - m2.r; else if(mt==3) ai = m2.g; else if(mt==4) ai = m1.r; else if(mt==5) ai = m4.r; else if(mt==6) ai = m4.g; else if(mt==8) ai = m3.b;
    else if(mt==7){ vec3 hv = rgb2hsv(d); ai = (1.0 - smoothstep(0.06,0.1,abs(hv.x-0.27))) * smoothstep(0.12,0.3,hv.y) * (1.0 - m2.r); }
    else if(mt==9) ai = 1.0;
    else if(mt==10){ vec2 p0 = uP4[k].xy * uSrcPx, p1 = uP4[k].zw * uSrcPx; vec2 dv = p1 - p0; float tt = dot(su * uSrcPx - p0, dv) / max(dot(dv, dv), 1.0); ai = 1.0 - smoothstep(0., 1., tt); }
    else if(mt==11){ vec2 v = su * uSrcPx - uP4[k].xy * uSrcPx; float ro = uP5[k].y; v = vec2(cos(ro)*v.x + sin(ro)*v.y, -sin(ro)*v.x + cos(ro)*v.y); vec2 rr = max(uP4[k].zw * uSrcPx, vec2(2.)); float dd2 = length(v / rr); float fe = clamp(uP5[k].x, 0.01, 1.0); ai = 1.0 - smoothstep(1.0 - fe, 1.0, dd2); }
    float bv = k==0?b0.r: k==1?b0.g: k==2?b0.b: k==3?b0.a: k==4?b1.r: k==5?b1.g: k==6?b1.b: b1.a;
    float w = clamp(ai + (bv - 0.502) * 2.0, 0., 1.);
    if(P3.y > 0.5) w = 1.0 - w;
    w *= P3.z;
    if(k == uShow) showW = w;
    if(w < 0.002) continue;
    vec3 nd = d * exp2(P0.x);
    float l = lum(nd);
    nd += (smoothstep(0.5, 1.0, l) * P0.z * 0.35 - (1.0 - smoothstep(0.0, 0.5, l)) * P0.w * -0.35) * vec3(1.0);
    if(P0.y != 0.){ nd = mix(nd, clamp((nd - 0.5) * (1.0 + P0.y * 0.6) + 0.5, 0., 1.), 1.0); }
    // 清晰度 / 去朦朧（以縮小畫面當局部平均）
    if(P1.w != 0.){ nd += (nd - lo2) * P1.w * 0.8 * (1.0 - abs(lum(nd) - 0.5)); }
    if(P2.y != 0.){ float lm = lum(lo2); nd = mix(nd, clamp((nd - lm * 0.35 * P2.y) / max(1.0 - 0.35 * P2.y, 0.3), 0., 1.), step(0., P2.y)); if(P2.y < 0.) nd = mix(nd, vec3(lum(lo2)) * 0.9 + 0.1, -P2.y * 0.5); }
    // 銳利化（正）/ 柔化（負）
    if(P2.x > 0.) nd += (nd - lo1) * P2.x * 1.2; else if(P2.x < 0.) nd = mix(nd, lo1, -P2.x);
    float l2 = lum(nd); nd = vec3(l2) + (nd - vec3(l2)) * (1.0 + P1.x);
    if(uP6[k].w > 0.){ vec3 tc = uP6[k].rgb; nd = mix(nd, clamp(nd * tc / max(dot(tc, vec3(0.333)), 0.05), 0., 1.), uP6[k].w * 0.7); }
    nd *= vec3(1.0 + P1.y*0.15, 1.0 - P1.z*0.1, 1.0 - P1.y*0.15 + P1.z*0.05);
    d = mix(d, clamp(nd, 0., 1.), w);
  }
  if(uShow >= 0) d = mix(d, vec3(1.0, 0.15, 0.2), showW * 0.55);
  if(uShowM > 0){ vec4 mm = uShowM==1 ? m1 : uShowM==2 ? m2 : uShowM==3 ? m3 : m4; float sv = uShowC==0 ? mm.r : uShowC==1 ? mm.g : uShowC==2 ? mm.b : mm.a; d = mix(d, vec3(1.0, 0.12, 0.18), sv * 0.6); }
  o = vec4(d, 1.);
}`;

// 可分離高斯模糊
const FS_BLUR = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir; uniform float uSigma;
void main(){
  vec4 s = vec4(0.); float w = 0.;
  int r = int(ceil(uSigma*2.5));
  for(int i=-24;i<=24;i++){ if(i<-r||i>r) continue; float k = exp(-float(i*i)/(2.*uSigma*uSigma)); s += texture(uTex, uv + uDir*float(i))*k; w += k; }
  o = s / w;
}`;

// 雙邊濾波（保留邊緣的平滑）— 用於降噪與修膚
const FS_BILATERAL = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex; uniform vec2 uPx; uniform float uStep; uniform float uRange;
${LUM}
void main(){
  vec3 c0 = texture(uTex, uv).rgb; float l0 = log2(lum(c0)+1e-4);
  vec3 s = vec3(0.); float w = 0.;
  for(int y=-5;y<=5;y++) for(int x=-5;x<=5;x++){
    vec2 d = vec2(x,y); vec3 c = texture(uTex, uv + d*uPx*uStep).rgb;
    float dl = log2(lum(c)+1e-4) - l0;
    float k = exp(-dot(d,d)/18.0) * exp(-dl*dl/(2.0*uRange*uRange));
    s += c*k; w += k;
  }
  o = vec4(s/w, 1.0);
}`;

// 斑點偵測（低解析度，之後模糊成柔和遮罩）
const FS_SPOT = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex, uM1, uM2; uniform vec2 uR, uR2;
${WARP}
${LUM}
float spotness(vec2 R, out vec3 ring){
  vec3 acc = vec3(0.); float m4 = 1e9; float l0 = lum(texture(uTex, uv).rgb);
  for(int i=0;i<4;i++){ float a = float(i)*0.7853982; vec2 d = vec2(cos(a), sin(a)) * R;
    vec3 p1 = texture(uTex, uv + d).rgb, p2 = texture(uTex, uv - d).rgb; acc += p1 + p2; m4 = min(m4, min(lum(p1), lum(p2))); }
  ring = acc / 8.0; return (m4 - l0) / max(l0, 1e-4);
}
void main(){
  vec2 mu = warpUV(uv); float skin = texture(uM1, mu).r, person = texture(uM2, mu).r;
  vec3 ring; float sp = spotness(uR, ring);
  float w = smoothstep(0.02, 0.07, sp) * (1.0 - smoothstep(0.16, 0.3, sp)) * smoothstep(0.6, 0.95, skin);
  vec3 ring2; float sp2 = spotness(uR2, ring2);
  float vs_ = 0.; for(int i=0;i<8;i++){ float a = float(i)*0.7853982; vec2 d = vec2(cos(a), sin(a)) * uR2 * 2.0; vs_ += abs(lum(texture(uTex, uv + d).rgb) - lum(ring2)); }
  float flat_ = 1.0 - smoothstep(0.02, 0.06, vs_ / 8.0 / max(lum(ring2),1e-4));
  float w2 = smoothstep(0.03, 0.08, sp2) * (1.0 - smoothstep(0.5, 0.8, sp2)) * flat_ * (1.0 - skin) * (1.0 - person);
  o = vec4(w, w2, 0., 1.);
}`;

// 亮部擷取（給黑柔濾鏡與光暈用）：先轉成顯示亮度、取出亮部，再做多尺度模糊
const FS_HI = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex, uBase;
${LUM}
void main(){
  vec3 c = texture(uTex, uv).rgb;
  vec3 x = clamp((log2(max(c, vec3(1e-6))) + 12.0) / 14.0, 0.0, 1.0); x = (x * 1023.0 + 0.5) / 1024.0;
  vec3 d = vec3(texture(uBase, vec2(x.r,.25)).r, texture(uBase, vec2(x.g,.25)).r, texture(uBase, vec2(x.b,.25)).r);
  float l = lum(d); float k = smoothstep(0.58, 1.0, l); vec3 h = d * k * k;
  o = vec4(h, 1.);
}`;
const FS_COMB = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uA, uB, uC, uD; uniform vec4 uW;
void main(){ o = vec4(texture(uA, uv).rgb*uW.x + texture(uB, uv).rgb*uW.y + texture(uC, uv).rgb*uW.z + texture(uD, uv).rgb*uW.w, 1.); }`;

// 失焦還原：Richardson–Lucy 反卷積（GPU 疊代）
const FS_RLDIV = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uObs, uEst;
void main(){ vec3 b = texture(uEst, uv).rgb; o = vec4(clamp(texture(uObs, uv).rgb / max(b, vec3(1e-4)), 0.2, 5.0), 1.); }`;
const FS_RLMUL = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uEst, uC, uObs; uniform float uDamp; uniform vec2 uPx;
void main(){
  vec3 e = texture(uEst, uv).rgb * mix(vec3(1.0), texture(uC, uv).rgb, uDamp);
  // 抑制振鈴：限制在原圖鄰近範圍內
  vec3 mn = vec3(1e9), mx = vec3(-1e9);
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec3 v = texture(uObs, uv + vec2(x,y)*uPx).rgb; mn = min(mn, v); mx = max(mx, v); }
  o = vec4(clamp(e, mn*0.7, mx*1.3 + 0.003), 1.);
}`;
const FS_ADDD = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uA, uB, uC; uniform float uAmt;
void main(){ vec3 a = texture(uA, uv).rgb; vec3 d = texture(uB, uv).rgb - texture(uC, uv).rgb; o = vec4(max(a + d * uAmt, vec3(0.)), 1.); }`;
const FS_MIXW = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uA, uB; uniform float uAmt;
void main(){ o = vec4(mix(texture(uA, uv).rgb, texture(uB, uv).rgb, uAmt), 1.); }`;

// 背景權重（避免人物顏色滲進模糊背景）
const FS_BGW = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex, uM2;
${WARP}
void main(){ float w = 1.0 - texture(uM2, warpUV(uv)).r; w = w*w; o = vec4(texture(uTex, uv).rgb * w, w); }`;

// 最終合成
const FS_FINAL = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D uW, uB1, uB2, uBS, uB3, uB4, uM1, uM2, uBase, uBG1, uBG2; uniform int uHasBG;
uniform sampler2D uOrig; uniform int uHasOrig; uniform int uFlip;
uniform int uHasMask;
uniform vec2 uOutSize, uSrcPx;
uniform vec4 uCrop; uniform float uAngle; uniform vec4 uView; uniform float uSplit;
uniform float uBaseSat;
uniform float uContrast, uHighlights, uShadows, uWhites, uBlacks, uVibrance, uSaturation, uClarity, uDehaze, uTexture;
uniform float uSharpen, uDenoise, uColorNoise, uVignette, uGrain, uBW;
uniform float uSmooth, uBlemish, uDark, uTeeth, uEyes, uSubject, uSkinEven, uBgBlur, uSky;
uniform float uHslH[8], uHslS[8], uHslL[8];
uniform vec3 uSkinRef; uniform float uSpotR; uniform sampler2D uSPB, uBL, uM3; uniform int uHasBL; uniform int uHasSpot;
uniform float uRosy; uniform float uStructure, uMatte, uSkinHue, uSkinSat, uSkinLum, uFaceLight, uContour, uLips, uBrows, uBlush, uBgLight, uBgSat, uBgClean, uSkyRep, uFog, uDust, uCmAmt, uSkyBottom;
uniform int uSkyType; uniform vec3 uCmS, uCmO;
uniform sampler2D uM4; uniform float uHal; uniform float uHairAmt, uHairLum, uWater, uWaterCol, uGlow, uStar, uTwilight, uBgRep; uniform float uHairRefL; uniform vec3 uHairCol, uBgCol, uBgCol2; uniform int uAlphaOut;
uniform int uLocN; uniform ivec4 uLocM; uniform vec4 uLocA[4];
uniform float uMist, uMistSize, uMistSoft, uMistWarm;
uniform float uFocusAmt, uFocusRange, uFocusD; uniform int uHasDepth;
uniform vec4 uCg[4]; uniform float uCgBlend, uCgBal; uniform int uPCN; uniform vec4 uPC[4]; uniform float uPCL[4];
uniform vec3 uGradeS, uGradeH; uniform float uGradeBal, uChrome, uChromeBlue, uBleach; uniform vec3 uBwW, uBwTone;
float hash2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash2(i),hash2(i+vec2(1,0)),f.x), mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0., a=0.5; for(int i=0;i<6;i++){ v+=a*vnoise(p); p*=2.03; a*=0.5; } return v; }
vec3 skyColor(vec2 su, float aspect){
  float t = clamp(su.y / max(uSkyBottom, 0.15), 0., 1.);   // 0=頂端 1=地平線
  vec3 top, hor; float cloud = 0.55;
  if(uSkyType==0){ top=vec3(0.06,0.20,0.62); hor=vec3(0.55,0.72,0.95); }
  else if(uSkyType==1){ top=vec3(0.18,0.20,0.45); hor=vec3(1.0,0.55,0.22); }
  else if(uSkyType==2){ top=vec3(0.20,0.14,0.40); hor=vec3(0.95,0.55,0.62); }
  else if(uSkyType==3){ top=vec3(0.04,0.17,0.58); hor=vec3(0.50,0.70,0.95); cloud = 0.; }
  else { top=vec3(0.30,0.36,0.46); hor=vec3(0.70,0.74,0.80); cloud = 0.9; }
  vec3 col = mix(top, hor, pow(t, 0.8));
  if(cloud > 0.){
    vec2 q = vec2(su.x*aspect, su.y) * vec2(2.2, 5.0);
    float n = fbm(q + vec2(3.1, 1.7)); float c = smoothstep(0.5 - cloud*0.12, 0.85, n);
    vec3 cc = uSkyType==1 ? vec3(1.0,0.75,0.55) : uSkyType==2 ? vec3(1.0,0.8,0.85) : vec3(1.0);
    cc *= 0.85 + 0.25*(1.0 - n);
    col = mix(col, cc, c * (0.35 + 0.6*cloud) * (1.0 - t*0.4));
  }
  return col;  // 顯示域（sRGB）
}
${LUM}
${WARP}
vec3 base(vec3 c){ // 相機原色曲線（per-channel，log 域查表）
  vec3 x = clamp((log2(max(c, vec3(1e-6))) + 12.0) / 14.0, 0.0, 1.0);
  x = (x * 1023.0 + 0.5) / 1024.0;
  return vec3(texture(uBase, vec2(x.r,.25)).r, texture(uBase, vec2(x.g,.25)).r, texture(uBase, vec2(x.b,.25)).r);
}
float baseL(float l){ return texture(uBase, vec2((clamp((log2(max(l,1e-6))+12.0)/14.0,0.,1.)*1023.0+0.5)/1024.0,.25)).r; }
vec3 curveF(vec3 v){ v = (clamp(v,0.,1.)*1023.0+0.5)/1024.0; return vec3(texture(uBase, vec2(v.r,.75)).r, texture(uBase, vec2(v.g,.75)).r, texture(uBase, vec2(v.b,.75)).r); }
vec3 rgb2hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); float e=1e-10; return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)),d/(q.x+e),q.x); }
vec3 hsv2rgb(vec3 c){ vec3 p=abs(fract(c.xxx+vec3(1.,2./3.,1./3.))*6.-3.); return c.z*mix(vec3(1.),clamp(p-1.,0.,1.),c.y); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }

uniform float uLensK, uLensCA; uniform vec3 uGeo; uniform vec4 uLP, uLP2, uLV; uniform vec2 uLT;
vec2 outToSrc(vec2 ou){
  // ou: 0..1 輸出畫面 → 裁切區座標 → 來源 uv
  vec2 q = uView.xy + (ou - 0.5) * uView.zw;              // 裁切區內 0..1（含縮放/平移）
  vec2 cropPx = uCrop.zw * uSrcPx;
  // 裁切中心以「旋轉後畫面」座標儲存：先在旋轉畫面內定位，再一起轉回來源
  vec2 p = (uCrop.xy - 0.5) * uSrcPx + (q - 0.5) * cropPx;
  float s = sin(uAngle), co = cos(uAngle);
  p = vec2(co*p.x - s*p.y, s*p.x + co*p.y);
  vec2 r0 = (0.5 * uSrcPx + p) / uSrcPx;
  if(uGeo.x != 0. || uGeo.y != 0. || uGeo.z != 1.0){ vec2 pp = (r0 - 0.5) / uGeo.z; float den = 1.0 + uGeo.x * pp.y * 1.6 + uGeo.y * pp.x * 1.6; pp /= max(den, 0.2); r0 = 0.5 + pp; }
  if(uLensK != 0.){ vec2 dd = (r0 - 0.5) * vec2(uSrcPx.x / uSrcPx.y, 1.0); float r2 = dot(dd, dd) / (0.25 * (uSrcPx.x*uSrcPx.x/(uSrcPx.y*uSrcPx.y)) + 0.25); r0 = 0.5 + (r0 - 0.5) * (1.0 + uLensK * r2) / (1.0 + max(uLensK, 0.)); }
  if(uLP.x > 0.5){ vec2 pp = (r0 - 0.5) * uSrcPx / (0.5 * min(uSrcPx.x, uSrcPx.y)) * uLP2.z; float ru = length(pp); float rd = ru;
    if(uLP.x < 1.5) rd = ru * (1.0 - uLP2.x + uLP2.x * ru * ru); else if(uLP.x < 2.5) rd = ru * (1.0 + uLP2.x * ru * ru + uLP2.y * ru * ru * ru * ru); else rd = ru * (uLP.y * ru * ru * ru + uLP.z * ru * ru + uLP.w * ru + 1.0 - uLP.y - uLP.z - uLP.w);
    float k = ru > 1e-5 ? rd / ru : 1.0; r0 = 0.5 + (r0 - 0.5) * k / uLP2.w; }
  return r0;
}

void main(){
  vec2 ou = vec2(uv.x, uFlip==1 ? 1.0-uv.y : uv.y);
  vec2 su = outToSrc(ou);
  vec2 qv = uView.xy + (ou - 0.5) * uView.zw;
  if(qv.x<0.||qv.y<0.||qv.x>1.||qv.y>1.||su.x<0.||su.y<0.||su.x>1.||su.y>1.){ o = vec4(0.059,0.063,0.071,1.); return; }
  if(uHasOrig==1 && ou.x < uSplit){
    vec3 c = base(texture(uOrig, su).rgb); o = vec4(c,1.); return;
  }
  vec3 c = texture(uW, su).rgb;
  if(uLensCA != 0.){ c.r = texture(uW, 0.5 + (su - 0.5) * (1.0 - uLensCA)).r; c.b = texture(uW, 0.5 + (su - 0.5) * (1.0 + uLensCA)).b; }
  if(uLT.x != 1.0 || uLT.y != 1.0){ c.r = texture(uW, 0.5 + (su - 0.5) * uLT.x).r; c.b = texture(uW, 0.5 + (su - 0.5) * uLT.y).b; }
  if(uLV.w > 0.5){ vec2 pp = (su - 0.5) * uSrcPx / (0.5 * min(uSrcPx.x, uSrcPx.y)) * uLP2.z; float r2 = dot(pp, pp); c /= max(0.2, 1.0 + uLV.x * r2 + uLV.y * r2 * r2 + uLV.z * r2 * r2 * r2); }
  vec3 b1 = texture(uB1, su).rgb, b2 = texture(uB2, su).rgb, b3 = texture(uB3, su).rgb, b4 = texture(uB4, su).rgb, bs = texture(uBS, su).rgb;
  vec4 m1 = vec4(0.), m2 = vec4(0.);
  vec4 m3 = vec4(0.), m4 = vec4(0.);
  if(uHasMask==1){ vec2 mu = warpUV(su); m1 = texture(uM1, mu); m2 = texture(uM2, mu); m3 = texture(uM3, mu); m4 = texture(uM4, mu); }
  float L = lum(c);

  // ── 改變焦點（依深度的鏡頭模糊）──
  if(uFocusAmt > 0. && uHasDepth==1){
    float dz = texture(uM4, warpUV(su)).b;
    float coc = clamp((abs(dz - uFocusD) - uFocusRange) / 0.35, 0., 1.);
    if(coc > 0.01){
      float R = coc * uFocusAmt * 0.03; vec2 asp = vec2(uSrcPx.y/uSrcPx.x, 1.0);
      vec3 acc = c; float wsum = 1.0;
      for(int i=1;i<40;i++){ float fi = float(i); float r = sqrt(fi/40.0) * R; float a = fi * 2.39996;
        vec2 off = vec2(cos(a), sin(a)) * r * asp;
        float sd = texture(uM4, warpUV(su + off)).b; float scoc = clamp((abs(sd - uFocusD) - uFocusRange) / 0.35, 0., 1.);
        // 清晰的前景不要被模糊到背景裡
        float w = smoothstep(0.0, 1.0, (scoc * uFocusAmt * 0.03 + 0.002) / max(r, 1e-4));
        vec3 sv = texture(uW, su + off).rgb; float br = 1.0 + 2.0 * smoothstep(0.6, 2.0, lum(sv));   // 亮點形成光斑
        acc += sv * w * br; wsum += w * br; }
      vec3 blurred = acc / wsum;
      c = blurred; float k = coc;
      b1 = mix(b1, blurred, k); b2 = mix(b2, blurred, k); bs = mix(bs, blurred, k); b3 = mix(b3, mix(b3, blurred, 0.5), k);
    }
  }

  // ── 降噪 ──
  if(uDenoise > 0.){ float e = clamp(abs(log2((lum(b3)+1e-4)/(L+1e-4)))*2.0, 0., 1.); c = mix(c, b2, uDenoise * (1.0 - 0.6*e)); }
  if(uColorNoise > 0.){ float lc = lum(c); vec3 ch = b2 / max(lum(b2),1e-5); c = mix(c, ch*lc, uColorNoise); }
  L = lum(c);

  // ── 去除灰塵斑點 ──
  if(uDust > 0. && uHasSpot==1){ float w = clamp(texture(uSPB, su).g*2.5,0.,1.); if(w>0.001){ c = mix(c, c*clamp(lum(b3)/max(L,1e-5),1.0,1.6), w*uDust); L = lum(c); } }

  // ── 人像 AI ──
  float skin = m1.r;
  if(skin > 0.002){
    if(uSmooth > 0.){
      vec3 detail = c - b1;                                   // 保留毛孔細節
      vec3 sm = bs + detail * (1.0 - 0.4*uSmooth);
      c = mix(c, sm, clamp(skin*uSmooth, 0., 1.));
    }
    if(uBlemish > 0. && uHasSpot==1){
      float w = clamp(texture(uSPB, su).r * 2.2, 0., 1.);
      if(w > 0.001){ float g = clamp(lum(bs) / max(L, 1e-5), 1.0, 1.15); c = mix(c, c * g, clamp(w * uBlemish * 1.3, 0., 1.)); }
    }
    if(uSkinEven > 0.){
      vec3 tone = uSkinRef * (lum(c)/max(lum(uSkinRef),1e-5));
      c = mix(c, tone, skin * uSkinEven * 0.45);
    }
    L = lum(c);
  }
  if(skin > 0.002 && uMatte > 0.){
    // 去油光：皮膚上明顯比周圍亮的反光往下壓
    float base_ = max(lum(bs), 1e-5); float hlr = L / base_;
    float k = smoothstep(1.02, 1.3, hlr) * skin * uMatte;
    c = mix(c, c * (base_ * 1.03 / L), k);
    L = lum(c);
  }
  if(m3.b > 0.002 && uFaceLight != 0.){ c *= exp2(uFaceLight * 0.7 * m3.b); L = lum(c); }
  if(uContour > 0. && (m2.b > 0.002 || m2.a > 0.002)){ c *= exp2(uContour * (0.45*m2.b - 0.45*m2.a)); L = lum(c); }
  if(m3.g > 0.002 && uBrows > 0.){ float k = m3.g * uBrows; vec3 dk = c * 0.62; c = mix(c, dk + (c - b3)*0.8, k * smoothstep(0.9, 0.4, L/max(lum(uSkinRef),1e-5))); L = lum(c); }
  if(m1.g > 0.002 && uDark > 0.){
    // 以臉頰膚色為目標提亮，避開睫毛與眼線（很暗的像素）
    float ref = lum(uSkinRef);
    float gate = smoothstep(0.45, 0.75, L / max(ref, 1e-5));
    float g = clamp(ref * 0.97 / max(L,1e-5), 1.0, 1.7);
    vec3 lifted = c * g;
    lifted = mix(lifted, uSkinRef * (lum(lifted) / max(ref,1e-5)), 0.3);
    c = mix(c, lifted, m1.g * uDark * gate);
    L = lum(c);
  }
  if(m1.b > 0.002 && uTeeth > 0.){
    float d = baseL(L);
    float gate = smoothstep(0.25, 0.45, d);
    vec3 w = vec3(L) * 1.0 + (c - vec3(L)) * 0.25;            // 去黃
    w *= 1.0 + 0.35*uTeeth;
    c = mix(c, w, m1.b * gate * uTeeth);
    L = lum(c);
  }
  if(m1.a > 0.002 && uEyes > 0.){
    vec3 e = c * (1.0 + 0.45*uEyes) + (c - b3) * 1.2 * uEyes;
    c = mix(c, max(e, vec3(0.)), m1.a);
    L = lum(c);
  }
  float person = m2.r;
  if(uSubject != 0.){ c *= mix(1.0, exp2(uSubject*0.9), person); L = lum(c); }
  if(uBgLight != 0.){ c *= mix(exp2(uBgLight*1.2), 1.0, person); L = lum(c); }
  if(uBgClean > 0.){ float bg = 1.0 - person; c = mix(c, bs, bg * uBgClean * 0.85); L = lum(c); }
  if(uBgBlur > 0.){
    float bg = 1.0 - person;
    vec3 blurred;
    if(uHasBG==1){
      vec4 g1 = texture(uBG1, su), g2 = texture(uBG2, su);
      vec3 c1 = g1.a > 0.02 ? g1.rgb/g1.a : b3, c2 = g2.a > 0.02 ? g2.rgb/g2.a : c1;
      blurred = uBgBlur < 0.5 ? mix(b3, c1, uBgBlur*2.0) : mix(c1, c2, (uBgBlur-0.5)*2.0);
    } else blurred = mix(b3, b4, clamp(uBgBlur, 0., 1.));
    c = mix(c, blurred, clamp(bg * min(1.0, uBgBlur*3.0), 0., 1.));
    L = lum(c);
  }
  if(m2.g > 0.002 && uSky != 0.){
    vec3 s = c * exp2(-0.6*uSky);
    vec3 hsvS = rgb2hsv(clamp(base(s),0.,1.));
    c = mix(c, s, m2.g);
    L = lum(c);
  }

  // ── 霧氣（以位置、天空、人物估計遠近）──
  if(uFog > 0.){
    float far_ = uHasDepth==1 ? clamp((1.0 - m4.b) * 1.3 - 0.15, 0., 1.) : clamp(1.15 - su.y * 1.4, 0., 1.); far_ *= (uHasDepth==1 ? 1.0 : (1.0 - person)) * (1.0 - 0.5*m2.g);
    vec3 fc = vec3(0.46, 0.48, 0.52);
    c = mix(c, fc, clamp(uFog * pow(far_, 1.3) * 0.85, 0., 0.9));
    L = lum(c);
  }

  // ── 亮部 / 暗部（局部色調）──
  float Ll = max(lum(b4), 1e-5);
  float lg = log2(Ll / 0.18);
  float sh = uShadows * 1.6 * (1.0 - smoothstep(-5.0, 0.5, lg));
  float hl = uHighlights * 1.4 * smoothstep(-1.0, 3.0, lg);
  c *= exp2(sh + hl);

  // 去朦朧（線性域）
  if(uDehaze != 0.){ float haze = lum(b4) * 0.25 * uDehaze; c = max(c - haze, vec3(0.)) * (1.0 + 0.4*uDehaze); }

  // ── 相機原色曲線 ──
  vec3 d = base(c);
  // 清晰度 / 紋理（顯示域局部對比）
  if(uClarity != 0.){ float lb = baseL(lum(b3)*exp2(sh+hl)); float ld = lum(d); float mid = 1.0 - abs(ld-0.5)*1.6; d += (ld - lb) * uClarity * 1.2 * max(mid,0.15); }
  if(uTexture != 0.){ float lb = baseL(lum(b2)*exp2(sh+hl)); d += (lum(d) - lb) * uTexture * 1.5; }
  if(uStructure != 0.){ float lb3 = baseL(lum(b3)*exp2(sh+hl)); float lb2 = baseL(lum(b2)*exp2(sh+hl)); float ld = lum(d); float mid = 1.0 - abs(ld-0.5)*1.4; float np = 1.0 - person*0.9 - skin*0.5; d += ((ld - lb3)*1.3 + (ld - lb2)*0.9) * uStructure * max(mid,0.2) * max(np, 0.); }
  if(uSharpen > 0.){ float lb = baseL(lum(b1)*exp2(sh+hl)); d += (lum(d) - lb) * uSharpen * 1.8; }
  d = clamp(d, 0., 1.2);
  // 飽和度基準
  float ld = lum(d); d = vec3(ld) + (d - vec3(ld)) * uBaseSat;

  // 白色 / 黑色 / 對比
  d = (d - uBlacks*0.08) / max(1.0 - uBlacks*0.08 - uWhites*0.12, 0.2);
  if(uContrast != 0.){ vec3 x = clamp(d,0.,1.); vec3 s = x*x*(3.0-2.0*x); d = mix(d, s, uContrast*0.9); if(uContrast<0.) d = mix(d, vec3(0.5), -uContrast*0.25); }
  d = clamp(d, 0., 1.);

  // ── 色彩 ──
  vec3 hsv = rgb2hsv(d);
  // HSL 8 色
  float hdeg = hsv.x * 360.0; float centers[8] = float[8](0.,30.,60.,120.,180.,225.,275.,320.);
  float dh=0., ds=0., dl=0., tw=0.;
  for(int i=0;i<8;i++){ float diff = abs(mod(hdeg - centers[i] + 180.0, 360.0) - 180.0); float w = max(0., 1.0 - diff/42.0); w = w*w*(3.-2.*w); dh += uHslH[i]*w; ds += uHslS[i]*w; dl += uHslL[i]*w; tw += w; }
  float satW = smoothstep(0.02, 0.2, hsv.y);
  hsv.x = fract(hsv.x + dh * 30.0/360.0 * satW + 1.0);
  hsv.y = clamp(hsv.y * (1.0 + ds*satW), 0., 1.);
  hsv.z = clamp(hsv.z * (1.0 + dl*0.5*satW), 0., 1.);
  // 自然飽和度（保護膚色）/ 飽和度
  float skinProt = 1.0 - 0.6*skin;
  float vib = uVibrance * (1.0 - hsv.y) * skinProt;
  hsv.y = clamp(hsv.y * (1.0 + vib + uSaturation), 0., 1.);
  d = hsv2rgb(hsv);
  // 膚色調整
  if(skin > 0.002 && (uSkinHue != 0. || uSkinSat != 0. || uSkinLum != 0.)){
    vec3 h2 = rgb2hsv(d); h2.x = fract(h2.x + uSkinHue*0.03 + 1.0); h2.y = clamp(h2.y*(1.0+uSkinSat*0.6),0.,1.); h2.z = clamp(h2.z*(1.0+uSkinLum*0.25),0.,1.);
    d = mix(d, hsv2rgb(h2), skin);
  }
  // 紅潤：皮膚往粉紅偏、臉頰（腮紅區）多一點，保持亮度不變（白裡透紅）
  if(skin > 0.002 && uRosy > 0.){
    float L0 = lum(d); vec3 pink = vec3(1.0, 0.80, 0.80); float w2 = skin * uRosy * (0.45 + 0.9 * m3.a + 0.25 * m3.b);
    vec3 nd = d * mix(vec3(1.0), pink / lum(pink) , 0.35 * w2); nd *= L0 / max(lum(nd), 1e-3);
    vec3 hh = rgb2hsv(nd); float hd = mod(hh.x - 0.985 + 0.5, 1.0) - 0.5; hh.x = fract(hh.x - hd * 0.18 * w2 + 1.0); nd = hsv2rgb(hh);
    d = mix(d, clamp(nd, 0., 1.), min(1.0, w2 * 1.4));
  }
  // 唇色
  if(m3.r > 0.002 && uLips != 0.){ vec3 h2 = rgb2hsv(d); float hd = mod(h2.x + 0.5, 1.0) - 0.5; h2.x = fract(h2.x - hd*0.4*max(uLips,0.) + 1.0); h2.y = clamp(h2.y*(1.0+uLips*0.7),0.,1.); h2.z = clamp(h2.z*(1.0 - max(uLips,0.)*0.06),0.,1.); d = mix(d, hsv2rgb(h2), m3.r); }
  // 腮紅
  if(m3.a > 0.002 && uBlush > 0.){ d = mix(d, d * vec3(1.0, 0.84, 0.87) + vec3(0.03,0.,0.01), m3.a * uBlush * 0.8); }
  // 背景飽和
  if(uBgSat != 0.){ float l2 = lum(d); d = mix(d, vec3(l2) + (d - vec3(l2))*(1.0+uBgSat), 1.0 - person); d = clamp(d,0.,1.); }
  // 天空替換
  if(m2.g > 0.002 && uSkyRep > 0.){
    vec3 sc = skyColor(su, uSrcPx.x/uSrcPx.y);
    d = mix(d, sc, m2.g * uSkyRep);
    // 前景配合新天空的光線色調
    vec3 hc = skyColor(vec2(0.5, max(uSkyBottom, 0.15)), 1.0); vec3 tint = hc / max(lum(hc), 1e-3);
    d = mix(d, clamp(d * mix(vec3(1.0), tint, 0.35), 0., 1.), (1.0 - m2.g) * uSkyRep * 0.5);
  }
  // 天空加強飽和
  if(m2.g > 0.002 && uSky > 0.){ float l2 = lum(d); d = mix(d, vec3(l2) + (d-vec3(l2))*(1.0+0.6*uSky), m2.g); }

  // 髮色
  if(m4.r > 0.002 && (uHairAmt > 0. || uHairLum != 0.)){
    // 保留原本頭髮的明暗紋理（相對於頭髮平均亮度），換成目標髮色
    float hl2 = lum(d); float rel = pow(clamp(hl2 / max(uHairRefL, 0.03), 0., 4.), 0.85);
    vec3 tgt = clamp(uHairCol * rel, 0., 1.); tgt += max(hl2 - 0.85, 0.) * 0.8;
    vec3 nd = mix(d, mix(d, tgt, 0.9), uHairAmt); nd *= 1.0 + uHairLum * 0.45;
    d = mix(d, clamp(nd,0.,1.), m4.r);
  }
  // 水面
  if(m4.g > 0.002 && (uWater != 0. || uWaterCol != 0.)){
    float ld2 = lum(d), lb = baseL(lum(b3)); vec3 nd = d + (ld2 - lb) * uWater * 1.2;
    float l3 = lum(nd); nd = vec3(l3) + (nd - vec3(l3)) * (1.0 + uWater * 0.5);
    vec3 teal = vec3(0.35, 0.95, 1.0) * l3 / 0.78; nd = mix(nd, clamp(teal,0.,1.), max(uWaterCol,0.) * 0.35);
    if(uWaterCol < 0.){ vec3 deep = vec3(0.25,0.45,1.0) * l3 / 0.45; nd = mix(nd, clamp(deep,0.,1.), -uWaterCol*0.3); }
    d = mix(d, clamp(nd,0.,1.), m4.g);
  }
  // 黃昏加強
  if(uTwilight > 0.){
    float skyW = uHasMask==1 && m2.g > 0.01 ? m2.g : smoothstep(0.55, 0.05, su.y) * (1.0 - person);
    float t2 = clamp(su.y / max(uSkyBottom, 0.2), 0., 1.);
    vec3 tint = mix(vec3(0.78, 0.62, 1.08), vec3(1.15, 0.82, 0.6), t2);
    vec3 sd = d * tint; float l4 = lum(sd); sd = vec3(l4) + (sd - vec3(l4)) * 1.35;
    d = mix(d, clamp(sd,0.,1.), skyW * uTwilight);
    d = mix(d, d * vec3(0.93, 0.95, 1.04) * 0.94, (1.0 - skyW) * uTwilight * 0.6);
  }
  // 光源光暈 / 星芒
  // 底片光暈（Halation）：強光外圍的紅橘色暈染（CineStill / Vision3 特色）
  if(uHal > 0. && uHasBL==1){ vec3 bl = texture(uBL, su).rgb; float hl0 = smoothstep(0.08, 0.6, max(max(bl.r,bl.g),bl.b)); hl0 *= hl0 * (1.0 - 0.75*smoothstep(0.35, 0.9, lum(d))); d = 1.0 - (1.0 - d) * (1.0 - clamp(vec3(1.0, 0.3, 0.1) * hl0 * uHal * 2.2, 0., 1.)); }
  if(uGlow > 0. || uStar > 0.){
    if(uHasBL==1){ vec3 bl = texture(uBL, su).rgb; d = 1.0 - (1.0 - d) * (1.0 - clamp(bl * uGlow * 2.2 * vec3(1.0, 0.9, 0.78), 0., 1.)); }
    if(uStar > 0.){
      float st = 0.; float len = 0.07;
      for(int k=0;k<4;k++){ float a = float(k) * 0.7853982 + 0.3927; vec2 dir = vec2(cos(a), sin(a) * uSrcPx.x/uSrcPx.y);
        for(int j=1;j<=14;j++){ float t = float(j)/14.0; vec2 o1 = dir * len * t;
          float h1 = smoothstep(0.9, 1.0, baseL(lum(texture(uB2, su + o1).rgb))), h2 = smoothstep(0.9, 1.0, baseL(lum(texture(uB2, su - o1).rgb)));
          st += (h1 + h2) * (1.0 - t) * (1.0 - t); } }
      d += vec3(1.0, 0.95, 0.85) * st * uStar * 0.16;
    }
    d = clamp(d, 0., 1.);
  }
  // 局部調整（AI 遮罩）
  for(int k=0;k<4;k++){ if(k>=uLocN) break;
    int mt = uLocM[k]; float w = 0.;
    if(mt==0) w = person; else if(mt==1) w = 1.0 - person; else if(mt==2) w = m2.g; else if(mt==3) w = skin; else if(mt==4) w = m4.r; else if(mt==5) w = m4.g;
    else if(mt==6){ vec3 hv = rgb2hsv(d); w = smoothstep(0.12, 0.3, hv.y) * (1.0 - smoothstep(0.03, 0.07, abs(hv.x - 0.27))) * (1.0 - person); w = (1.0 - smoothstep(0.06,0.1,abs(hv.x-0.27))) * smoothstep(0.12,0.3,hv.y) * (1.0 - person); }
    else if(mt==7) w = m3.b;
    if(w < 0.002) continue;
    vec4 A = uLocA[k]; vec3 nd = d * exp2(A.x * 0.9);
    if(A.y != 0.){ nd = mix(nd, nd*nd*(3.0-2.0*nd), A.y*0.8); }
    float l5 = lum(nd); nd = vec3(l5) + (nd - vec3(l5)) * (1.0 + A.z);
    nd *= vec3(1.0 + A.w*0.12, 1.0, 1.0 - A.w*0.12);
    d = mix(d, clamp(nd,0.,1.), w);
  }
  // 黑柔濾鏡（Black Pro-Mist）：亮部向外擴散、亮部對比降低、暗部保持深黑、整體柔化
  if(uMist > 0.){
    float ex = exp2(sh+hl);
    vec3 s2 = clamp(base(b2*ex),0.,1.), s3 = clamp(base(b3*ex),0.,1.);
    vec3 bloom = uHasBL==1 ? texture(uBL, su).rgb : max(s3 - 0.6, 0.) * 2.0;
    bloom *= mix(vec3(1.0), vec3(1.0, 0.85, 0.7), uMistWarm);
    // 亮部擴散（screen 混合）
    vec3 dd = 1.0 - (1.0 - d) * (1.0 - clamp(bloom * uMist * 1.6, 0., 1.));
    // 柔化：模糊影像以「變亮」混合，亮部滲進暗部、暗部不被拉灰；再整體柔一點
    vec3 soft = mix(s2, s3, 0.35 + 0.5*uMistSize);
    dd = mix(dd, max(dd, soft), clamp(uMistSoft * uMist * 1.2, 0., 1.));
    dd = mix(dd, mix(dd, s2, 0.5), clamp(uMistSoft * uMist, 0., 1.) * 0.45);
    // 亮部對比降低、帶一點霧面感
    dd -= smoothstep(0.6, 1.0, dd) * 0.09 * uMist;
    dd += (1.0 - dd) * bloom * 0.0;
    // 暗部維持深黑
    float bp = 0.03 * uMist; dd = max(dd - bp, 0.) / (1.0 - bp);
    d = clamp(dd, 0., 1.);
  }
  // 換背景
  if(uBgRep > 0.){ vec3 bgc = mix(uBgCol, uBgCol2, su.y); d = mix(d, mix(bgc, d, person), uBgRep); }
  // 色彩比對（YCbCr 統計轉換）
  if(uCmAmt > 0.){
    vec3 y = vec3(dot(d, vec3(0.299,0.587,0.114)), dot(d, vec3(-0.1687,-0.3313,0.5)), dot(d, vec3(0.5,-0.4187,-0.0813)));
    vec3 yt = y * uCmS + uCmO;
    vec3 r = vec3(yt.x + 1.402*yt.z, yt.x - 0.344136*yt.y - 0.714136*yt.z, yt.x + 1.772*yt.y);
    d = mix(d, clamp(r,0.,1.), uCmAmt);
  }
  // 色彩濃度效果（Color Chrome）：高飽和色塊壓暗一點，增加層次
  if(uChrome > 0. || uChromeBlue > 0.){
    vec3 hv = rgb2hsv(d); float k = smoothstep(0.35, 0.85, hv.y) * uChrome;
    float hb = hv.x * 360.0; float kb = smoothstep(0.25, 0.7, hv.y) * (1.0 - smoothstep(0., 40., abs(hb - 215.0))) * uChromeBlue;
    d *= 1.0 - 0.22 * k - 0.25 * kb; d = mix(vec3(lum(d)), d, 1.0 + 0.15*k + 0.2*kb);
  }
  // 漂白略過（留銀）：亮度疊加、降飽和、高反差
  if(uBleach > 0.){
    float l6 = lum(d); vec3 ov = mix(2.0*d*l6, 1.0 - 2.0*(1.0-d)*(1.0-l6), step(0.5, l6));
    d = mix(d, clamp(ov,0.,1.), uBleach * 0.75); d = mix(d, vec3(lum(d)), uBleach * 0.35);
  }
  // 分離色調：暗部 / 亮部各自染色（富士負片的色偏）
  if(uGradeS.z > 0. || uGradeH.z > 0.){
    float l7 = lum(d); float bal = uGradeBal * 0.25;
    float ws = 1.0 - smoothstep(0.0, 0.55 + bal, l7), wh = smoothstep(0.45 + bal, 1.0, l7);
    vec3 cs = hsv2rgb(vec3(uGradeS.x, 1.0, 1.0)) - 0.5, ch2 = hsv2rgb(vec3(uGradeH.x, 1.0, 1.0)) - 0.5;
    d += cs * uGradeS.z * 0.22 * ws + ch2 * uGradeH.z * 0.22 * wh;
    d = mix(vec3(l7), d, 1.0) + (l7 - lum(d));   // 保持亮度
    d = clamp(d, 0., 1.);
  }
  // 色彩分級（色輪）：暗部、中間調、亮部、整體，各自的色相、飽和、明度
  if(uCg[0].y + uCg[1].y + uCg[2].y + uCg[3].y > 0. || abs(uCg[0].z) + abs(uCg[1].z) + abs(uCg[2].z) + abs(uCg[3].z) > 0.){
    float L = lum(d); float bl = 0.12 + uCgBlend * 0.35; float b2 = uCgBal * 0.25;
    float ws = 1.0 - smoothstep(0.33 + b2 - bl, 0.33 + b2 + bl, L), wh = smoothstep(0.66 + b2 - bl, 0.66 + b2 + bl, L), wm = clamp(1.0 - ws - wh, 0., 1.);
    float W4[4] = float[4](ws, wm, wh, 1.0); vec3 add = vec3(0.); float lm = 0.;
    for(int i = 0; i < 4; i++){ add += (hsv2rgb(vec3(uCg[i].x, 1.0, 1.0)) - 0.5) * uCg[i].y * 0.3 * W4[i]; lm += uCg[i].z * 0.35 * W4[i]; }
    d += add; d += (L - lum(d)); d = clamp(d * (1.0 + lm), 0., 1.);
  }
  // 點顏色：選一個顏色，只調整接近它的色相（可設定範圍）
  for(int i = 0; i < 4; i++){ if(i >= uPCN) break;
    vec3 hv = rgb2hsv(d); float dh = abs(mod(hv.x - uPC[i].x + 0.5, 1.0) - 0.5); float w = (1.0 - smoothstep(uPC[i].y * 0.6, uPC[i].y, dh)) * smoothstep(0.04, 0.16, hv.y);
    if(w < 0.002) continue; hv.x = fract(hv.x + uPC[i].z * 0.08 * w + 1.0); hv.y = clamp(hv.y * (1.0 + uPC[i].w * w), 0., 1.); hv.z = clamp(hv.z * (1.0 + uPCL[i] * 0.5 * w), 0., 1.); d = hsv2rgb(hv);
  }
  // 色調曲線
  d = curveF(d);
  if(uBW > 0.5){ d = vec3(dot(d, uBwW)); if(uBwTone.z > 0.){ vec3 tc = hsv2rgb(vec3(uBwTone.x, 1.0, 1.0)); float l8 = d.r; d = mix(d, l8 * (tc / max(lum(tc),1e-3)), uBwTone.z * 0.5 * (1.0 - abs(l8 - 0.5)*1.2)); d = clamp(d,0.,1.); } }
  // 暗角
  if(uVignette != 0.){ vec2 q = (qv - 0.5) * vec2(uOutSize.x/uOutSize.y, 1.0) ; float r = length(q) / length(vec2(uOutSize.x/uOutSize.y,1.)*0.5); float v = smoothstep(0.35, 1.05, r); d *= 1.0 - uVignette * v * 0.85; d = max(d, vec3(0.)); }
  if(uGrain > 0.){ float n = hash(su * uSrcPx) - 0.5; d += n * uGrain * 0.12; }
  o = vec4(clamp(d,0.,1.), uAlphaOut==1 ? person : 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
  return s;
}
function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

// 曲線點 → 256 LUT（單調三次樣條）
export function curveLUT(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length, out = new Float32Array(256);
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const dx = [], m = [], dl = [];
  for (let i = 0; i < n - 1; i++) { dx.push(xs[i + 1] - xs[i] || 1e-6); dl.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-6)); }
  m[0] = dl[0]; m[n - 1] = dl[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = dl[i - 1] * dl[i] <= 0 ? 0 : (dl[i - 1] + dl[i]) / 2;
  for (let i = 0; i < n - 1; i++) { if (dl[i] === 0) { m[i] = m[i + 1] = 0; continue; } const a = m[i] / dl[i], b = m[i + 1] / dl[i], s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * dl[i]; m[i + 1] = t * b * dl[i]; } }
  for (let k = 0; k < 256; k++) {
    const x = k / 255; let i = 0; while (i < n - 2 && x > xs[i + 1]) i++;
    if (x <= xs[0]) { out[k] = ys[0]; continue; } if (x >= xs[n - 1]) { out[k] = ys[n - 1]; continue; }
    const h = dx[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    out[k] = Math.min(1, Math.max(0, (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]));
  }
  return out;
}

// 預設底片曲線（沒有相機 JPEG 可比對時）
export function defaultBaseLUT() {
  const lut = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const lin = Math.pow(2, i / 1023 * 14 - 12) * 2.2;          // +1.1EV 基準
    const t = lin * (1 + lin / 16) / (1 + lin);                    // 柔和肩部
    const g = t <= 0.0031308 ? t * 12.92 : 1.055 * Math.pow(t, 1 / 2.4) - 0.055;
    lut[i] = Math.min(1, g);
  }
  return lut;
}
export function srgbBaseLUT() {
  const lut = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const t = Math.min(1, Math.pow(2, i / 1023 * 14 - 12)); lut[i] = t <= 0.0031308 ? t * 12.92 : 1.055 * Math.pow(t, 1 / 2.4) - 0.055; }
  return lut;
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('此電腦不支援 WebGL2');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('顯示卡不支援浮點運算');
    gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.P = { base: program(gl, FS_BASE), copy: program(gl, FS_COPY), blur: program(gl, FS_BLUR), bil: program(gl, FS_BILATERAL), fin: program(gl, FS_FINAL), bgw: program(gl, FS_BGW), spot: program(gl, FS_SPOT), hi: program(gl, FS_HI), comb: program(gl, FS_COMB), rldiv: program(gl, FS_RLDIV), rlmul: program(gl, FS_RLMUL), mixw: program(gl, FS_MIXW), addd: program(gl, FS_ADDD), local: program(gl, FS_LOCAL) };
    this.t = {}; this.dirty = true; this.pins = []; this.hasMask = false;
    this.baseLUT = defaultBaseLUT(); this.baseSat = 1;
    this.curveLut = curveLUT(DEFAULT_EDITS().curve);
    this.baseTex = null; this.rebuildLUT();
    this.emptyMask = this.texRGBA8(1, 1, new Uint8Array(4));
    this.m1 = this.m2 = this.m3 = this.m4 = this.emptyMask;
    this.skinRef = [0.3, 0.2, 0.15];
  }
  tex1D(data, n, rgb) {
    const gl = this.gl; const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    const d = new Float32Array(n * 4); for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = data[i]; d[i * 4 + 3] = 1; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, d);
    this.params(gl.LINEAR); return t;
  }
  params(f) { const gl = this.gl; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
  texRGBA8(w, h, data) { const gl = this.gl; const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); this.params(gl.LINEAR); return t; }
  fin8(w, h) {
    const gl = this.gl; let r = this.t.FIN8; if (r && r.w === w && r.h === h) return r;
    if (r) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fb); }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return (this.t.FIN8 = { tex, fb, w, h });
  }
  // 自訂天空照片（app:// 路徑），載入後建立含 mipmap 的貼圖
  loadSkyImage(url) {
    this.skyImgKey = url; const img = new Image(); img.crossOrigin = 'anonymous';
    this.skyImgReady = new Promise((res) => { img.onload = () => { if (this.skyImgKey !== url) return res();
      const gl = this.gl; if (this.skyImgTex) gl.deleteTexture(this.skyImgTex);
      const c = document.createElement('canvas'); const sc = Math.min(1, 4096 / Math.max(img.width, img.height)); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.skyImgTex = t; this.skyImgAsp = c.width / c.height; this.dirty = true; this.onSkyLoaded && this.onSkyLoaded(); res(); }; img.onerror = () => res(); });
    img.src = url; return this.skyImgReady;
  }
  // 來源座標 → 輸出畫面座標（outToSrc 的反運算，不含鏡頭變形）
  srcToOut(pt, c, v) {
    const W = this.srcW, H = this.srcH; const a = -(c.angle || 0) * Math.PI / 180;
    const px = pt.x * W - W / 2, py = pt.y * H - H / 2; const rx = Math.cos(a) * px - Math.sin(a) * py, ry = Math.sin(a) * px + Math.cos(a) * py;
    const qx = (rx - (c.cx - 0.5) * W) / (c.w * W) + 0.5, qy = (ry - (c.cy - 0.5) * H) / (c.h * H) + 0.5;
    return [(qx - v[0]) / v[2] + 0.5, (qy - v[1]) / v[3] + 0.5];
  }
  setLowGain(g) { const gl = this.gl; if (this.lowGainTex) gl.deleteTexture(this.lowGainTex); this.lowGainTex = g ? this.texRGBA8(g.w, g.h, g.data) : null; }
  // FiveK：三個基底 LUT 依權重混合成一個 33³ 的 3D 貼圖
  ensureFivek(w) {
    const key = w.map(v => v.toFixed(4)).join(','); if (key === this.fiveKey) return; this.fiveKey = key;
    this.onNeedFive && this.onNeedFive(w, (data) => { if (this.fiveKey !== key) return; const gl = this.gl; if (this.fiveTex) gl.deleteTexture(this.fiveTex); const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 33, 33, 33, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
      this.fiveTex = t; this.onSkyLoaded && this.onSkyLoaded(); });
  }
  emptyLut() { if (!this._elut) { const gl = this.gl; const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); this._elut = t; } return this._elut; }
  // 讀取 .cube 3D LUT
  loadLUT(url) {
    this.lutKey = url;
    this.lutReady = (async () => { try {
      const txt = await (await fetch(url)).text(); if (this.lutKey !== url) return;
      let N = 0; const vals = []; let dmin = [0, 0, 0], dmax = [1, 1, 1];
      for (const line of txt.split(/\r?\n/)) { const l = line.trim(); if (!l || l[0] === '#') continue;
        if (/^LUT_3D_SIZE/i.test(l)) { N = parseInt(l.split(/\s+/)[1]); continue; }
        if (/^DOMAIN_MIN/i.test(l)) { dmin = l.split(/\s+/).slice(1).map(Number); continue; } if (/^DOMAIN_MAX/i.test(l)) { dmax = l.split(/\s+/).slice(1).map(Number); continue; }
        if (/^[A-Z_]/i.test(l)) continue; const p = l.split(/\s+/).map(Number); if (p.length >= 3 && !isNaN(p[0])) vals.push(p[0], p[1], p[2]); }
      if (!N || vals.length < N * N * N * 3) throw new Error('LUT 格式不支援');
      const data = new Uint8Array(N * N * N * 4); for (let i = 0; i < N * N * N; i++) { for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.max(0, Math.min(255, Math.round((vals[i * 3 + k] - dmin[k]) / (dmax[k] - dmin[k]) * 255))); data[i * 4 + 3] = 255; }
      const gl = this.gl; if (this.lutTex) gl.deleteTexture(this.lutTex); const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
      this.lutTex = t; this.dirty = true; this.onSkyLoaded && this.onSkyLoaded();
    } catch (err) { console.warn('lut', err); this.lutTex = null; } })();
    return this.lutReady;
  }
  neutralTex() { if (!this._neu) this._neu = this.texRGBA8(1, 1, new Uint8Array([128, 128, 128, 128])); return this._neu; }
  // 筆刷遮罩：兩張 RGBA（每個通道一層，128＝不變）；由各圖層的筆畫轉成點陣
  ensureBrush(LL, live) {
    const key = JSON.stringify([this.srcW, this.srcH, LL.map(l => l.strokes || [])]) + (live ? live.key : '');
    if (key === this.brushKey) return; this.brushKey = key;
    const gl = this.gl; (this.brushTex || []).forEach(t => t && gl.deleteTexture(t)); this.brushTex = null;
    if (!LL.some(l => (l.strokes || []).length) && !live) return;
    const sc = 1024 / Math.max(this.srcW, this.srcH); const w = Math.max(8, Math.round(this.srcW * sc)), h = Math.max(8, Math.round(this.srcH * sc));
    const packs = [new Uint8Array(w * h * 4).fill(128), new Uint8Array(w * h * 4).fill(128)];
    LL.forEach((l, i) => {
      const st = [...(l.strokes || []), ...(live && live.layer === l ? [live.stroke] : [])]; if (!st.length) return;
      const data = rasterStrokes(st, w, h); const pk = packs[i >> 2], ch = i & 3;
      for (let j = 0; j < w * h; j++) pk[j * 4 + ch] = data[j * 4];
    });
    this.brushTex = packs.map(d => this.texRGBA8(w, h, d));
  }
  target(name, w, h) {
    const gl = this.gl; let r = this.t[name];
    if (r && r.w === w && r.h === h) return r;
    if (r) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fb); }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null); this.params(gl.LINEAR);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    r = { tex, fb, w, h }; this.t[name] = r; return r;
  }

  // src: { width, height, data: Uint16Array (RGB) | Uint8Array, bits, srgb }
  setSource(src) {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (src.data instanceof Uint16Array) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, src.width, src.height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, src.data); this.srcScale = 1 / 65535; }
    else { const ch = src.channels || 3; gl.texImage2D(gl.TEXTURE_2D, 0, ch === 4 ? gl.RGBA8UI : gl.RGB8UI, src.width, src.height, 0, ch === 4 ? gl.RGBA_INTEGER : gl.RGB_INTEGER, gl.UNSIGNED_BYTE, src.data); this.srcScale = 1 / 255; }
    this.params(gl.NEAREST);
    this.srcW = src.width; this.srcH = src.height; this.srcSRGB = !!src.srgb;
    this.dirty = true; this.origDirty = true;
    this.setMasks(null); this.pins = [];
  }
  updateSource(src) { // 修補後重新上傳，保留 AI 遮罩
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (src.data instanceof Uint16Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, src.width, src.height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, src.data);
    else { const ch = src.channels || 3; gl.texImage2D(gl.TEXTURE_2D, 0, ch === 4 ? gl.RGBA8UI : gl.RGB8UI, src.width, src.height, 0, ch === 4 ? gl.RGBA_INTEGER : gl.RGB_INTEGER, gl.UNSIGNED_BYTE, src.data); }
    this.dirty = true;
  }
  rebuildLUT() {
    this.lutVer = (this.lutVer || 0) + 1; this.dirty = true;
    const gl = this.gl; if (this.baseTex) gl.deleteTexture(this.baseTex);
    const d = new Float32Array(1024 * 2 * 4);
    for (let i = 0; i < 1024; i++) { const b = this.baseLUT[i]; d.set([b, b, b, 1], i * 4); const x = i / 1023 * 255, k = Math.min(254, Math.floor(x)), f = x - k; const c = this.curveLut[k] * (1 - f) + this.curveLut[k + 1] * f; d.set([c, c, c, 1], (1024 + i) * 4); }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, 2, 0, gl.RGBA, gl.FLOAT, d); this.params(gl.LINEAR); this.baseTex = t;
  }
  setBase(lut, sat) { this.baseLUT = lut; this.baseSat = sat || 1; this.rebuildLUT(); }
  setMasks(m) {
    const gl = this.gl;
    for (const k of ['m1', 'm2', 'm3', 'm4']) if (this[k] && this[k] !== this.emptyMask) gl.deleteTexture(this[k]);
    if (!m) { this.hasDepth = false; this.depthAt = null; this.m1 = this.m2 = this.m3 = this.m4 = this.emptyMask; this.hasMask = false; this.dirty = true; return; }
    this.m1 = this.texRGBA8(m.w, m.h, m.m1); this.m2 = this.texRGBA8(m.w, m.h, m.m2); this.m3 = m.m3 ? this.texRGBA8(m.w, m.h, m.m3) : this.emptyMask; this.m4 = m.m4 ? this.texRGBA8(m.w, m.h, m.m4) : this.emptyMask; this.skyBottom = m.skyBottom || 0.5; this.hasDepth = !!m.depth; this.depthAt = m.depth ? (x, y) => { const X = Math.max(0, Math.min(m.w - 1, Math.round(x * m.w))), Y = Math.max(0, Math.min(m.h - 1, Math.round(y * m.h))); let s2 = 0, n = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const xx = Math.max(0, Math.min(m.w - 1, X + dx)), yy = Math.max(0, Math.min(m.h - 1, Y + dy)); s2 += m.depth[yy * m.w + xx]; n++; } return s2 / n; } : null;
    for (const k of ['skyRefTex', 'fgRefTex']) if (this[k]) { gl.deleteTexture(this[k]); this[k] = null; }
    if (m.skyRef && m.fgRef) { this.skyRefTex = this.texRGBA8(m.skyRef.w, m.skyRef.h, m.skyRef.data); this.fgRefTex = this.texRGBA8(m.fgRef.w, m.fgRef.h, m.fgRef.data); }
    this.hasMask = true; this.dirty = true; this.hairL = m.hairL || 0.3; if (m.skinRef) this.skinRef = m.skinRef; this.faceFrac = m.faceFrac || 0.25;
  }
  // pins: [{x,y,r,type:'mag'|'push', s, dx, dy}]（座標為來源 0..1）
  setPins(p) { this.pins = p || []; this.body = p?.body && p.body.rows.some(r => Math.abs(r[2]) > 0.001) ? p.body : null; this.dirty = true; }
  // body: { y0, y1, rows: [[cx, hw, k]] }（k 已含強度）
  setBody(b) { this.body = b && b.rows.some(r => r[2] > 0.001) ? b : null; this.dirty = true; }

  draw(prog, fb, w, h) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.useProgram(prog.p); }
  bind(prog, name, unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u[name], unit); }
  quad() { this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }
  warpUniforms(prog) {
    const gl = this.gl; const A = new Float32Array(192), B = new Float32Array(192);
    const asp = this.srcW / this.srcH; const pins = this.pins.slice(0, 48);
    pins.forEach((p, i) => { A.set([p.x, p.y, p.r, p.type === 'push' ? 1 : 0], i * 4); B.set([p.type === 'push' ? p.dx : p.s, p.type === 'push' ? p.dy : 0, 0, 0], i * 4); });
    gl.uniform1i(prog.u.uPins, pins.length); gl.uniform4fv(prog.u.uPinA, A); gl.uniform4fv(prog.u.uPinB, B);
    const bd = this.body; const BA = new Float32Array(48 * 4); if (bd) bd.rows.slice(0, 48).forEach((r, i) => BA.set([r[0], r[1], r[2], 0], i * 4));
    gl.uniform1i(prog.u.uBodyN, bd ? Math.min(48, bd.rows.length) : 0); gl.uniform2f(prog.u.uBodyY, bd ? bd.y0 : 0, bd ? bd.y1 : 1); gl.uniform4fv(prog.u.uBody, BA);
    gl.uniform2f(prog.u.uAspect, asp, 1);
  }
  blurInto(srcTex, name, w, h, sigma) {
    const gl = this.gl, P = this.P.blur;
    const tmp = this.target(name + '_tmp', w, h), out = this.target(name, w, h);
    this.draw(P, tmp.fb, w, h); this.bind(P, 'uTex', 0, srcTex); gl.uniform2f(P.u.uDir, 1 / w, 0); gl.uniform1f(P.u.uSigma, sigma); this.quad();
    this.draw(P, out.fb, w, h); this.bind(P, 'uTex', 0, tmp.tex); gl.uniform2f(P.u.uDir, 0, 1 / h); gl.uniform1f(P.u.uSigma, sigma); this.quad();
    return out;
  }
  resample(srcTex, name, w, h) { const P = this.P.copy; const r = this.target(name, w, h); this.draw(P, r.fb, w, h); this.bind(P, 'uTex', 0, srcTex); this.quad(); return r; }

  // 依參數建立中間層（白平衡/曝光/液化改變時才重算）
  prepare(e) {
    const wantBloom = !this.lite && (e.mist > 0 || e.glow > 0 || e.halation > 0); const bsz = Math.round((e.mistSize ?? 50) / 10);
    const key = JSON.stringify([e.defocus, e.defocusR, e.temp, e.tint, e.exposure, this.pins, this.body, this.srcW, this.srcH, this.hasMask, wantBloom, bsz, this.lutVer]);
    if (!this.dirty && key === this.prepKey) return;
    this.prepKey = key; this.dirty = false;
    const gl = this.gl; const W = this.srcW, H = this.srcH;
    const t = e.temp / 100, ti = e.tint / 100, ev = Math.pow(2, e.exposure);
    const mul = [ev * (1 + 0.35 * t) * (1 + 0.1 * ti), ev * (1 - 0.22 * ti), ev * (1 - 0.35 * t) * (1 + 0.1 * ti)];
    const P = this.P.base;
    const w0 = this.target('W', W, H);
    this.draw(P, w0.fb, W, H); this.bindSrc(P); gl.uniform3fv(P.u.uMul, mul); this.warpUniforms(P);
    this.bind(P, 'uPM', 1, this.hasMask ? this.m2 : this.emptyMask); gl.uniform1i(P.u.uHasPM, this.hasMask && this.body ? 1 : 0); this.quad();
    this.origDirty = true;
    if (this.origDirty) {
      const o = this.target('O', W, H); this.draw(P, o.fb, W, H); this.bindSrc(P); gl.uniform3fv(P.u.uMul, [1, 1, 1]); gl.uniform1i(P.u.uPins, 0); gl.uniform1i(P.u.uBodyN, 0); gl.uniform1i(P.u.uHasPM, 0); this.quad();
      this.origDirty = false;
    }
    if (e.defocus > 0) {
      // 以長邊比例決定模糊半徑；大半徑在縮小的影像上疊代（可救回的細節本來就在那個尺度），再把差值加回原圖
      const sigmaFull = (0.5 + (e.defocusR ?? 30) / 100 * 11.5) * Math.max(W, H) / 3000;
      const f = Math.max(1, sigmaFull / 2.5); const Wl = Math.max(16, Math.round(W / f)), Hl = Math.max(16, Math.round(H / f)); const sigma = sigmaFull / f;
      const obs = this.resample(w0.tex, 'RLO', Wl, Hl);
      let est = this.resample(w0.tex, 'RLA', Wl, Hl), alt = this.target('RLB', Wl, Hl);
      for (let i = 0; i < 16; i++) {
        const be = this.blurInto(est.tex, 'RLE', Wl, Hl, sigma);
        const ratio = this.target('RLR', Wl, Hl); this.draw(this.P.rldiv, ratio.fb, Wl, Hl); this.bind(this.P.rldiv, 'uObs', 0, obs.tex); this.bind(this.P.rldiv, 'uEst', 1, be.tex); this.quad();
        const cc = this.blurInto(ratio.tex, 'RLC', Wl, Hl, sigma);
        const PM = this.P.rlmul; this.draw(PM, alt.fb, Wl, Hl); this.bind(PM, 'uEst', 0, est.tex); this.bind(PM, 'uC', 1, cc.tex); this.bind(PM, 'uObs', 2, obs.tex); gl.uniform1f(PM.u.uDamp, 0.9); gl.uniform2f(PM.u.uPx, 1 / Wl, 1 / Hl); this.quad();
        [est, alt] = [alt, est];
      }
      const cp = this.target('RLW', W, H); this.draw(this.P.copy, cp.fb, W, H); this.bind(this.P.copy, 'uTex', 0, w0.tex); this.quad();
      const PD = this.P.addd; this.draw(PD, w0.fb, W, H); this.bind(PD, 'uA', 0, cp.tex); this.bind(PD, 'uB', 1, est.tex); this.bind(PD, 'uC', 2, obs.tex); gl.uniform1f(PD.u.uAmt, Math.min(1.5, e.defocus / 100 * 1.2)); this.quad();
    }
    const long = Math.max(W, H), sc = (n) => [Math.max(8, Math.round(W * n / long)), Math.max(8, Math.round(H * n / long))];
    this.blurInto(w0.tex, 'B1', W, H, 1.3);
    // 雙邊濾波：降噪（1/2）與修膚（固定 1024 長邊）
    const h2 = this.resample(w0.tex, 'H2', Math.ceil(W / 2), Math.ceil(H / 2));
    const PB = this.P.bil;
    if (this.lite) {
      // 輕量模式（AI 最佳化搜尋用）：省略雙邊濾波與斑點偵測
      const [sw, shh] = sc(256); this.t.B2 = this.resample(h2.tex, 'B2', h2.w, h2.h); this.t.BS = this.resample(w0.tex, 'BS', sw, shh);
    } else {
    const b2 = this.target('B2', h2.w, h2.h); this.draw(PB, b2.fb, h2.w, h2.h); this.bind(PB, 'uTex', 0, h2.tex); gl.uniform2f(PB.u.uPx, 1 / h2.w, 1 / h2.h); gl.uniform1f(PB.u.uStep, 1.0); gl.uniform1f(PB.u.uRange, 0.25); this.quad();
    const [sw, shh] = sc(1024);
    const s0 = this.resample(w0.tex, 'S0', sw, shh);
    // 依臉的大小決定修膚半徑
    const st2 = Math.max(0.6, Math.min(3.5, (this.faceFrac || 0.25) * 1024 * 0.03)), st1 = st2 * 0.55;
    const bs1 = this.target('BS1', sw, shh); this.draw(PB, bs1.fb, sw, shh); this.bind(PB, 'uTex', 0, s0.tex); gl.uniform2f(PB.u.uPx, 1 / sw, 1 / shh); gl.uniform1f(PB.u.uStep, st1); gl.uniform1f(PB.u.uRange, 0.4); this.quad();
    const bs = this.target('BS', sw, shh); this.draw(PB, bs.fb, sw, shh); this.bind(PB, 'uTex', 0, bs1.tex); gl.uniform1f(PB.u.uStep, st2); gl.uniform1f(PB.u.uRange, 0.32); this.quad();
    if (this.hasMask) {
      const PS = this.P.spot; const sp = this.target('SP', sw, shh);
      const r = Math.max(1.5, Math.min(6, (this.faceFrac || 0.25) * 1024 * 0.03));
      this.draw(PS, sp.fb, sw, shh); this.bind(PS, 'uTex', 0, s0.tex); this.bind(PS, 'uM1', 1, this.m1); this.bind(PS, 'uM2', 2, this.m2); gl.uniform2f(PS.u.uR, r / sw, r / shh); gl.uniform2f(PS.u.uR2, 2.0 / sw, 2.0 / shh); this.warpUniforms(PS); this.quad();
      this.blurInto(sp.tex, 'SPB', sw, shh, Math.max(1, r * 0.5));
    }
    }
    const [w3, h3] = sc(768);
    const q3 = this.resample(w0.tex, 'Q3', w3, h3); this.blurInto(q3.tex, 'B3', w3, h3, 2.2);
    const [w5, h5] = sc(384); const q5 = this.resample(w0.tex, 'Q5', w5, h5);
    const [w4, h4] = sc(160); const q4 = this.resample(q5.tex, 'Q4', w4, h4); this.blurInto(q4.tex, 'B4', w4, h4, 3.0);
    if (wantBloom) {
      const PH = this.P.hi; const [a1, a2] = sc(768); const hi = this.target('HI', a1, a2);
      this.draw(PH, hi.fb, a1, a2); this.bind(PH, 'uTex', 0, q3.tex); this.bind(PH, 'uBase', 1, this.baseTex); this.quad();
      const l1 = this.blurInto(hi.tex, 'L1', a1, a2, 2.5);
      const [c1, c2] = sc(384); const r2 = this.resample(l1.tex, 'R2', c1, c2); const l2 = this.blurInto(r2.tex, 'L2', c1, c2, 3.5);
      const [d1, d2] = sc(160); const r3 = this.resample(l2.tex, 'R3', d1, d2); const l3 = this.blurInto(r3.tex, 'L3', d1, d2, 4.0);
      const [e1, e2] = sc(64); const r4 = this.resample(l3.tex, 'R4', e1, e2); const l4 = this.blurInto(r4.tex, 'L4', e1, e2, 3.0);
      const z = bsz / 10; const PC = this.P.comb; const bl = this.target('BL', c1, c2);
      this.draw(PC, bl.fb, c1, c2); this.bind(PC, 'uA', 0, l1.tex); this.bind(PC, 'uB', 1, l2.tex); this.bind(PC, 'uC', 2, l3.tex); this.bind(PC, 'uD', 3, l4.tex);
      gl.uniform4f(PC.u.uW, 0.55 - 0.3 * z, 0.6, 0.35 + 0.5 * z, 0.15 + 0.7 * z); this.quad();
    }
    if (this.hasMask) {
      const PG = this.P.bgw; const g = this.target('G5', w5, h5);
      this.draw(PG, g.fb, w5, h5); this.bind(PG, 'uTex', 0, w0.tex); this.bind(PG, 'uM2', 1, this.m2); this.warpUniforms(PG); this.quad();
      this.blurInto(g.tex, 'BG1', w5, h5, 3.5);
      const [w6, h6] = sc(192); const g6 = this.resample(g.tex, 'G6', w6, h6); this.blurInto(g6.tex, 'BG2', w6, h6, 4.0);
    }
  }
  bindSrc(P) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex); gl.uniform1i(P.u.uSrc, 0);
    gl.uniform2f(P.u.uSrcSize, this.srcW, this.srcH); gl.uniform1f(P.u.uScale, this.srcScale); gl.uniform1i(P.u.uIsSRGB, this.srcSRGB ? 1 : 0);
  }
  setCurve(pts) { const k = JSON.stringify(pts); if (k === this.curveKey) return; this.curveKey = k; this.curveLut = curveLUT(pts); this.rebuildLUT(); }

  cropSizePx(c) { return [c.w * this.srcW, c.h * this.srcH]; }

  // 繪製到畫布或 framebuffer
  // opts: { width, height, fb, view:[x,y,w,h], split }
  render(e, opts = {}) {
    if (!this.srcTex) return;
    e = effective({ ...DEFAULT_EDITS(), ...e });
    const gl = this.gl;
    const LL = (e.local || []).filter(l => l.on !== false).slice(0, 8);
    const wantSky = e.skyRep > 0 && this.hasMask && this.skyRefTex;
    const wantFx = (e.lowLight > 0 && this.lowGainTex) || (e.fivekAmt > 0 && e.fivekW) || e.atmo > 0 || e.ldepth || e.scHi || e.scMid || e.scLo || e.rays > 0 || (e.lutPath && e.lutAmt > 0);
    if ((LL.length || wantSky || wantFx || (opts.showLayer ?? -1) >= 0 || opts.showMask) && !opts._inner && !opts.noPost) {
      const W0 = opts.width || this.canvas.width, H0 = opts.height || this.canvas.height;
      const F = this.fin8(W0, H0);
      this.ensureBrush(LL, this.liveBrush); this.neutralTex();
      this.render({ ...e, skyRep: 0 }, { ...opts, fb: F.fb, width: W0, height: H0, _inner: true });
      gl.bindTexture(gl.TEXTURE_2D, F.tex); gl.generateMipmap(gl.TEXTURE_2D);
      const P = this.P.local; this.draw(P, opts.fb || null, W0, H0);
      this.bind(P, 'uF', 0, F.tex); this.bind(P, 'uM1', 1, this.m1); this.bind(P, 'uM2', 2, this.m2); this.bind(P, 'uM3', 3, this.m3); this.bind(P, 'uM4', 4, this.m4);
      this.bind(P, 'uL0', 5, this.brushTex?.[0] || this.neutralTex()); this.bind(P, 'uL1', 6, this.brushTex?.[1] || this.neutralTex());
      gl.uniform1i(P.u.uShowM, opts.showMask && this.hasMask ? +opts.showMask[2][1] : 0); gl.uniform1i(P.u.uShowC, opts.showMask ? opts.showMask[3] : 0);
      gl.uniform1i(P.u.uN, LL.length); gl.uniform1i(P.u.uFlip, opts.fb ? 0 : 1); gl.uniform1i(P.u.uHasMask, this.hasMask ? 1 : 0);
      const all = (e.local || []); gl.uniform1i(P.u.uShow, opts.showLayer != null && opts.showLayer >= 0 ? LL.indexOf(all[opts.showLayer]) : -1);
      const c = e.crop || DEFAULT_EDITS().crop; gl.uniform4f(P.u.uCrop, c.cx, c.cy, c.w, c.h); gl.uniform1f(P.u.uAngle, (c.angle || 0) * Math.PI / 180);
      const v = opts.view || [0.5, 0.5, 1, 1]; gl.uniform4f(P.u.uView, v[0], v[1], v[2], v[3]); gl.uniform2f(P.u.uSrcPx, this.srcW, this.srcH);
      const MT = { none: 0, person: 1, bg: 2, sky: 3, skin: 4, hair: 5, water: 6, plants: 7, face: 8, all: 9, linear: 10, radial: 11 };
      const A0 = new Float32Array(32), A1 = new Float32Array(32), A2 = new Float32Array(32), A3 = new Float32Array(32), A4 = new Float32Array(32), A5 = new Float32Array(32), A6 = new Float32Array(32);
      LL.forEach((l, i) => { const q = (k) => (l[k] || 0) / 100;
        A0.set([q('exp'), q('con'), q('hl'), q('sh')], i * 4); A1.set([q('sat'), q('temp'), q('tint'), q('clar')], i * 4); A2.set([q('sharp'), q('dehaze'), 0, 0], i * 4);
        A3.set([MT[l.mask] ?? 0, l.inv ? 1 : 0, (l.amt ?? 100) / 100, (l.slot ?? i)], i * 4);
        const g = l.geo || {}; if (l.mask === 'linear') A4.set([g.x0 ?? .5, g.y0 ?? .1, g.x1 ?? .5, g.y1 ?? .5], i * 4); else if (l.mask === 'radial') { A4.set([g.cx ?? .5, g.cy ?? .5, g.rx ?? .25, g.ry ?? .25], i * 4); A5.set([(g.f ?? 50) / 100, g.rot || 0, 0, 0], i * 4); }
        if (l.tintA) { const h = (l.tintC || '#ffa040').replace('#', ''); A6.set([parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, l.tintA / 100], i * 4); } });
      gl.uniform4fv(P.u.uP4, A4); gl.uniform4fv(P.u.uP5, A5); gl.uniform4fv(P.u.uP6, A6);
      gl.uniform4fv(P.u.uP0, A0); gl.uniform4fv(P.u.uP1, A1); gl.uniform4fv(P.u.uP2, A2); gl.uniform4fv(P.u.uP3, A3);
      // 天空
      this.bind(P, 'uWt', 7, this.t.W.tex); this.bind(P, 'uBase', 8, this.baseTex); this.bind(P, 'uSkyRef', 9, this.skyRefTex || this.emptyMask); this.bind(P, 'uFgRef', 10, this.fgRefTex || this.emptyMask);
      const wantImg = e.skyType === 'custom' && e.skyImg; if (wantImg && this.skyImgKey !== e.skyImg) this.loadSkyImage(e.skyImg);
      const hasImg = wantImg && this.skyImgKey === e.skyImg && this.skyImgTex; this.bind(P, 'uSkyImg', 11, hasImg ? this.skyImgTex : this.emptyMask);
      gl.uniform1i(P.u.uHasSkyImg, hasImg ? 1 : 0); gl.uniform1f(P.u.uSkyImgAsp, this.skyImgAsp || 1.5); gl.uniform1i(P.u.uHasRef, this.skyRefTex ? 1 : 0);
      gl.uniform1i(P.u.uSkyType, SKY_TYPES[e.skyType] ?? 0);
      const g1 = (n, v) => P.u[n] && gl.uniform1f(P.u[n], v);
      g1('uSkyRep', wantSky ? e.skyRep / 100 : 0); g1('uSkyX', (e.skyX || 0) / 100); g1('uSkyHor', (e.skyHorizon || 0) / 100 * 0.3); g1('uSkyBlend', (e.skyBlend ?? 20) / 100);
      g1('uSkyBlur', (e.skyBlur || 0) / 100); g1('uSkyExp', (e.skyExp || 0) / 100 * 1.5); g1('uSkyTemp', (e.skyTemp || 0) / 100); g1('uSkyRelight', (e.skyRelight ?? 40) / 100);
      g1('uSkyHaze', (e.skyHaze || 0) / 100); g1('uSkyDetail', (e.skyDetail ?? 50) / 100); g1('uSkyReflect', (e.skyReflect || 0) / 100); g1('uSkyBottom', this.skyBottom || 0.5);
      // 效果
      const wantLut = e.lutPath && e.lutAmt > 0; if (wantLut && this.lutKey !== e.lutPath) this.loadLUT(e.lutPath);
      const hasLut = wantLut && this.lutKey === e.lutPath && this.lutTex; gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_3D, hasLut ? this.lutTex : this.emptyLut()); gl.uniform1i(P.u.uLut, 12);
      gl.uniform1i(P.u.uHasLut, hasLut ? 1 : 0); g1('uLutAmt', (e.lutAmt ?? 100) / 100); gl.uniform1i(P.u.uHasDepth, this.hasDepth ? 1 : 0);
      const wantFive = e.fivekAmt > 0 && e.fivekW; if (wantFive) this.ensureFivek(e.fivekW);
      gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_3D, wantFive && this.fiveTex ? this.fiveTex : this.emptyLut()); gl.uniform1i(P.u.uFive, 14); gl.uniform1i(P.u.uHasFive, wantFive && this.fiveTex ? 1 : 0); g1('uFiveAmt', (e.fivekAmt || 0) / 100);
      this.bind(P, 'uLowG', 13, this.lowGainTex || this.emptyMask); gl.uniform1i(P.u.uHasLow, this.lowGainTex ? 1 : 0); g1('uLowAmt', (e.lowLight || 0) / 100);
      g1('uAtmo', (e.atmo || 0) / 100); g1('uAtmoNear', (e.atmoNear ?? 40) / 100); g1('uAtmoTone', (e.atmoTone || 0) / 100); g1('uLDepth', (e.ldepth || 0) / 100);
      g1('uScHi', (e.scHi || 0) / 100); g1('uScMid', (e.scMid || 0) / 100); g1('uScLo', (e.scLo || 0) / 100);
      g1('uRays', (e.rays || 0) / 100); g1('uRaysLen', 0.35 + (e.raysLen ?? 50) / 100 * 0.65); g1('uRaysWarm', (e.raysWarm ?? 50) / 100);
      const sun = this.srcToOut(e.sun || { x: 0.65, y: 0.12 }, c, v); gl.uniform2f(P.u.uSun, sun[0], sun[1]);
      gl.uniform3f(P.u.uGeo, ...geoU(e)); g1('uLensK', (e.lensDist || 0) / 100 * 0.25); { const L = e.lensProf && e.lensP ? e.lensP : null; gl.uniform4f(P.u.uLP, L && L.dist ? L.m : 0, L?.a || 0, L?.b || 0, L?.c || 0); gl.uniform4f(P.u.uLP2, L?.k1 || 0, L?.k2 || 0, L?.s || 1, L?.fix || 1); }
      this.warpUniforms(P); this.quad(); return;
    }
    this.prepare(e); this.setCurve(e.curve);
    const P = this.P.fin, W = opts.width || this.canvas.width, H = opts.height || this.canvas.height;
    this.draw(P, opts.fb || null, W, H);
    const tx = [['uW', 'W'], ['uB1', 'B1'], ['uB2', 'B2'], ['uBS', 'BS'], ['uB3', 'B3'], ['uB4', 'B4']];
    tx.forEach(([u, n], i) => this.bind(P, u, i, this.t[n].tex));
    this.bind(P, 'uM1', 6, this.m1); this.bind(P, 'uM2', 7, this.m2); this.bind(P, 'uBase', 8, this.baseTex); this.bind(P, 'uM4', 9, this.m4);
    this.bind(P, 'uOrig', 10, this.t.O.tex);
    const hasSP = this.hasMask && this.t.SPB; gl.uniform1i(P.u.uHasSpot, hasSP ? 1 : 0); this.bind(P, 'uSPB', 13, hasSP ? this.t.SPB.tex : this.emptyMask); const hasBL = !!(this.t.BL && (e.mist > 0 || e.glow > 0 || e.halation > 0)); gl.uniform1i(P.u.uHasBL, hasBL ? 1 : 0); this.bind(P, 'uBL', 14, hasBL ? this.t.BL.tex : this.emptyMask); this.bind(P, 'uM3', 15, this.m3);
    const hasBG = this.hasMask && this.t.BG1; gl.uniform1i(P.u.uHasBG, hasBG ? 1 : 0);
    this.bind(P, 'uBG1', 11, hasBG ? this.t.BG1.tex : this.emptyMask); this.bind(P, 'uBG2', 12, hasBG ? this.t.BG2.tex : this.emptyMask);
    gl.uniform1i(P.u.uHasOrig, opts.split != null ? 1 : 0); gl.uniform1f(P.u.uSplit, opts.split != null ? opts.split : -1);
    gl.uniform1i(P.u.uHasMask, this.hasMask ? 1 : 0); gl.uniform1i(P.u.uFlip, opts.fb ? 0 : 1);
    gl.uniform2f(P.u.uOutSize, W, H); gl.uniform2f(P.u.uSrcPx, this.srcW, this.srcH);
    const c = e.crop || DEFAULT_EDITS().crop;
    gl.uniform4f(P.u.uCrop, c.cx, c.cy, c.w, c.h); gl.uniform1f(P.u.uAngle, (c.angle || 0) * Math.PI / 180);
    gl.uniform3f(P.u.uGeo, ...geoU(e));
    gl.uniform1f(P.u.uLensK, (e.lensDist || 0) / 100 * 0.25); gl.uniform1f(P.u.uLensCA, (e.lensCA || 0) / 100 * 0.004);
    { const L = e.lensProf && e.lensP ? e.lensP : null; gl.uniform4f(P.u.uLP, L && L.dist ? L.m : 0, L?.a || 0, L?.b || 0, L?.c || 0); gl.uniform4f(P.u.uLP2, L?.k1 || 0, L?.k2 || 0, L?.s || 1, L?.fix || 1);
      gl.uniform2f(P.u.uLT, L && L.tca ? L.kr : 1, L && L.tca ? L.kb : 1); gl.uniform4f(P.u.uLV, L?.v1 || 0, L?.v2 || 0, L?.v3 || 0, L && L.vig ? 1 : 0); }
    const v = opts.view || [0.5, 0.5, 1, 1]; gl.uniform4f(P.u.uView, v[0], v[1], v[2], v[3]);
    gl.uniform1f(P.u.uBaseSat, this.baseSat);
    const f = (n, val) => gl.uniform1f(P.u[n], val);
    f('uContrast', e.contrast / 100); f('uHighlights', e.highlights / 100); f('uShadows', e.shadows / 100); f('uWhites', e.whites / 100); f('uBlacks', e.blacks / 100);
    f('uVibrance', e.vibrance / 100); f('uSaturation', e.saturation / 100); f('uClarity', e.clarity / 100); f('uDehaze', e.dehaze / 100); f('uTexture', (e.texture || 0) / 100);
    f('uSharpen', e.sharpen / 100); f('uDenoise', e.denoise / 100); f('uColorNoise', e.colorNoise / 100); f('uVignette', e.vignette / 100); f('uGrain', e.grain / 100); f('uBW', e.bw ? 1 : 0);
    f('uSmooth', e.smooth / 100); f('uBlemish', e.blemish / 100); f('uDark', e.darkCircle / 100); f('uTeeth', e.teeth / 100); f('uEyes', e.eyeBright / 100);
    f('uSubject', e.subjectLight / 100); f('uSkinEven', (e.skinEven || 0) / 100); f('uBgBlur', e.bgBlur / 100); f('uSky', e.sky / 100);
    gl.uniform1fv(P.u.uHslH, e.hslH.map(x => x / 100)); gl.uniform1fv(P.u.uHslS, e.hslS.map(x => x / 100)); gl.uniform1fv(P.u.uHslL, e.hslL.map(x => x / 100));
    for (const [u, k, d] of [['uRosy','rosy',100],['uStructure','structure',100],['uMatte','matte',100],['uSkinHue','skinHue',100],['uSkinSat','skinSat',100],['uSkinLum','skinLum',100],['uFaceLight','faceLight',100],['uContour','contour',100],['uLips','lips',100],['uBrows','brows',100],['uBlush','blush',100],['uBgLight','bgLight',100],['uBgSat','bgSat',100],['uBgClean','bgClean',100],['uSkyRep','skyRep',100],['uFog','fog',100],['uDust','dust',100],['uCmAmt','cmAmt',100]]) f(u, (e[k] || 0) / d);
    if (!e.cm) f('uCmAmt', 0);
    const cm = e.cm || { s: [1, 1, 1], o: [0, 0, 0] }; gl.uniform3fv(P.u.uCmS, cm.s); gl.uniform3fv(P.u.uCmO, cm.o);
    const HAIR = { brown: '#7a4a2a', chestnut: '#5a2e1a', blonde: '#d8b878', wine: '#7a1f35', black: '#1a1716', gray: '#a8a8ad', ash: '#8c8478', pink: '#d8899e' };
    const hx = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
    f('uHairAmt', (e.hairAmt || 0) / 100); f('uHairRefL', this.hairL || 0.3); f('uHairLum', (e.hairLum || 0) / 100); gl.uniform3fv(P.u.uHairCol, hx(HAIR[e.hairColor] || e.hairColor || '#7a4a2a'));
    f('uWater', (e.water || 0) / 100); f('uWaterCol', (e.waterColor || 0) / 100); f('uGlow', (e.glow || 0) / 100); f('uHal', (e.halation || 0) / 100); f('uStar', (e.star || 0) / 100); f('uTwilight', (e.twilight || 0) / 100);
    const BGS = { white: ['#ffffff', '#ffffff'], black: ['#0c0c0e', '#0c0c0e'], gray: ['#8d9096', '#5d6066'], studio: ['#6f7a88', '#2a2f38'], warm: ['#f3e3cf', '#c9a888'], blue: ['#9cc6ef', '#3a6fb0'], custom: [e.bgColor || '#ffffff', e.bgColor || '#ffffff'] };
    const bg = BGS[e.bgType] || BGS.white; f('uBgRep', (e.bgRep || 0) / 100); gl.uniform3fv(P.u.uBgCol, hx(bg[0])); gl.uniform3fv(P.u.uBgCol2, hx(bg[1]));
    gl.uniform1i(P.u.uAlphaOut, opts.alpha ? 1 : 0);
    const BWF = { none: [0.3, 0.59, 0.11], ye: [0.42, 0.52, 0.06], r: [0.72, 0.28, 0.0], g: [0.22, 0.72, 0.06] };
    gl.uniform3fv(P.u.uBwW, BWF[e.bwFilter] || BWF.none); gl.uniform3f(P.u.uBwTone, (e.bwToneH ?? 35) / 360, 0, (e.bwToneS || 0) / 100);
    gl.uniform3f(P.u.uGradeS, (e.gradeSH ?? 200) / 360, 0, (e.gradeSS || 0) / 100); gl.uniform3f(P.u.uGradeH, (e.gradeHH ?? 40) / 360, 0, (e.gradeHS || 0) / 100);
    { const cg = new Float32Array(16); [['S', 'shadow'], ['M', 'mid'], ['H', 'high'], ['G', 'global']].forEach(([k], i) => cg.set([(e['cg' + k + 'h'] || 0) / 360, (e['cg' + k + 's'] || 0) / 100, (e['cg' + k + 'l'] || 0) / 100, 0], i * 4)); gl.uniform4fv(P.u.uCg, cg); f('uCgBlend', (e.cgBlend ?? 50) / 100); f('uCgBal', (e.cgBal || 0) / 100);
      const pc = (e.pointColors || []).slice(0, 4); const pa = new Float32Array(16), pl = new Float32Array(4); pc.forEach((q, i) => { pa.set([q.h / 360, (q.range ?? 30) / 360 + 0.01, (q.dh || 0) / 100, (q.ds || 0) / 100], i * 4); pl[i] = (q.dl || 0) / 100; }); gl.uniform1i(P.u.uPCN, pc.length); gl.uniform4fv(P.u.uPC, pa); gl.uniform1fv(P.u.uPCL, pl); }
    f('uGradeBal', (e.gradeBal || 0) / 100); f('uChrome', (e.chrome || 0) / 100); f('uChromeBlue', (e.chromeBlue || 0) / 100); f('uBleach', (e.bleach || 0) / 100);
    f('uFocusAmt', e.focus ? (e.focusAmt || 0) / 100 : 0); f('uFocusRange', (e.focusRange ?? 15) / 100 * 0.4); gl.uniform1i(P.u.uHasDepth, this.hasDepth ? 1 : 0);
    f('uFocusD', e.focus && this.depthAt ? this.depthAt(e.focus.x, e.focus.y) : 0.5);
    f('uMist', (e.mist || 0) / 100); f('uMistSize', (e.mistSize ?? 50) / 100); f('uMistSoft', (e.mistSoft ?? 40) / 100); f('uMistWarm', e.mistWarm === false ? 0 : 1);
    const L = []; const MT = {};
    gl.uniform1i(P.u.uLocN, L.length); const lm = [0, 0, 0, 0], la = new Float32Array(16);
    L.forEach((l, i) => { lm[i] = MT[l.mask] ?? 0; la.set([(l.exp || 0) / 100, (l.con || 0) / 100, (l.sat || 0) / 100, (l.temp || 0) / 100], i * 4); });
    gl.uniform4i(P.u.uLocM, ...lm); gl.uniform4fv(P.u.uLocA, la);
    gl.uniform1i(P.u.uSkyType, SKY_TYPES[e.skyType] ?? 0); f('uSkyBottom', this.skyBottom || 0.5);
    gl.uniform3fv(P.u.uSkinRef, this.skinRef); gl.uniform1f(P.u.uSpotR, Math.max(0.0012, Math.min(0.006, (this.faceFrac || 0.25) * 0.035)));
    this.warpUniforms(P);
    this.quad();
  }

  // 輸出成 RGBA 像素（匯出 / AI / 縮圖用）
  renderPixels(e, w, h, opts = {}) {
    const gl = this.gl;
    const rb = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, rb); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rb, 0);
    const out = new Uint8ClampedArray(w * h * 4);
    // 分塊繪製，避免大圖超時
    const tile = 2048;
    for (let y0 = 0; y0 < h; y0 += tile) {
      const th = Math.min(tile, h - y0);
      const v = opts.view || [0.5, 0.5, 1, 1];
      // 分塊：對應裁切區的部分範圍
      const vy0 = (v[1] - v[3] / 2) + v[3] * (y0 / h), vh = v[3] * (th / h);
      this.render(e, { ...opts, fb, width: w, height: th, view: [v[0], vy0 + vh / 2, v[2], vh] });
      const buf = new Uint8Array(w * th * 4);
      gl.readPixels(0, 0, w, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let y = 0; y < th; y++) out.set(buf.subarray(y * w * 4, (y + 1) * w * 4), (y0 + y) * w * 4);
    }
    gl.deleteFramebuffer(fb); gl.deleteTexture(rb);
    return new ImageData(out, w, h);
  }

  dispose() {
    const gl = this.gl; if (this.skyImgTex) { gl.deleteTexture(this.skyImgTex); this.skyImgTex = null; this.skyImgKey = null; } if (this.lutTex) { gl.deleteTexture(this.lutTex); this.lutTex = null; this.lutKey = null; }
    for (const k in this.t) { gl.deleteTexture(this.t[k].tex); gl.deleteFramebuffer(this.t[k].fb); }
    this.t = {};
    if (this.srcTex) gl.deleteTexture(this.srcTex); this.srcTex = null;
    this.setMasks(null);
  }
}
