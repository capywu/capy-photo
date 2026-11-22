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
  skyRep: 0, skyType: 'blue', fog: 0, dust: 0, cm: null, cmAmt: 0,
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
const SKY_TYPES = { blue: 0, sunset: 1, dusk: 2, clear: 3, cloudy: 4 };

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const WARP = `
uniform int uPins; uniform vec4 uPinA[48]; uniform vec4 uPinB[48]; uniform vec2 uAspect;
vec2 warpUV(vec2 uv){
  vec2 q = uv;
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
${WARP}
vec3 fetch(ivec2 p){ p = clamp(p, ivec2(0), ivec2(uSrcSize)-1); vec3 c = vec3(texelFetch(uSrc, p, 0).rgb) * uScale;
  if(uIsSRGB==1) c = mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); return c; }
void main(){
  vec2 q = warpUV(uv) * uSrcSize - 0.5;
  ivec2 i0 = ivec2(floor(q)); vec2 f = fract(q);
  vec3 c = mix(mix(fetch(i0), fetch(i0+ivec2(1,0)), f.x), mix(fetch(i0+ivec2(0,1)), fetch(i0+ivec2(1,1)), f.x), f.y);
  o = vec4(c * uMul, 1.0);
}`;

const FS_COPY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uTex;
void main(){ o = texture(uTex, uv); }`;

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
uniform float uStructure, uMatte, uSkinHue, uSkinSat, uSkinLum, uFaceLight, uContour, uLips, uBrows, uBlush, uBgLight, uBgSat, uBgClean, uSkyRep, uFog, uDust, uCmAmt, uSkyBottom;
uniform int uSkyType; uniform vec3 uCmS, uCmO;
uniform sampler2D uM4; uniform float uHal; uniform float uHairAmt, uHairLum, uWater, uWaterCol, uGlow, uStar, uTwilight, uBgRep; uniform vec3 uHairCol, uBgCol, uBgCol2; uniform int uAlphaOut;
uniform int uLocN; uniform ivec4 uLocM; uniform vec4 uLocA[4];
uniform float uMist, uMistSize, uMistSoft, uMistWarm;
uniform float uFocusAmt, uFocusRange, uFocusD; uniform int uHasDepth;
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

vec2 outToSrc(vec2 ou){
  // ou: 0..1 輸出畫面 → 裁切區座標 → 來源 uv
  vec2 q = uView.xy + (ou - 0.5) * uView.zw;              // 裁切區內 0..1（含縮放/平移）
  vec2 cropPx = uCrop.zw * uSrcPx;
  vec2 p = (q - 0.5) * cropPx;
  float s = sin(uAngle), co = cos(uAngle);
  p = vec2(co*p.x - s*p.y, s*p.x + co*p.y);
  return (uCrop.xy * uSrcPx + p) / uSrcPx;
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
    float hl2 = lum(d); vec3 tgt = clamp(uHairCol * (hl2 / max(lum(uHairCol), 0.05)), 0., 1.);
    vec3 nd = mix(d, mix(d, tgt, 0.85), uHairAmt); nd *= 1.0 + uHairLum * 0.45;
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
    this.P = { base: program(gl, FS_BASE), copy: program(gl, FS_COPY), blur: program(gl, FS_BLUR), bil: program(gl, FS_BILATERAL), fin: program(gl, FS_FINAL), bgw: program(gl, FS_BGW), spot: program(gl, FS_SPOT), hi: program(gl, FS_HI), comb: program(gl, FS_COMB), rldiv: program(gl, FS_RLDIV), rlmul: program(gl, FS_RLMUL), mixw: program(gl, FS_MIXW), addd: program(gl, FS_ADDD) };
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
    this.hasMask = true; this.dirty = true; if (m.skinRef) this.skinRef = m.skinRef; this.faceFrac = m.faceFrac || 0.25;
  }
  // pins: [{x,y,r,type:'mag'|'push', s, dx, dy}]（座標為來源 0..1）
  setPins(p) { this.pins = p || []; this.dirty = true; }

  draw(prog, fb, w, h) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.useProgram(prog.p); }
  bind(prog, name, unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u[name], unit); }
  quad() { this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }
  warpUniforms(prog) {
    const gl = this.gl; const A = new Float32Array(192), B = new Float32Array(192);
    const asp = this.srcW / this.srcH; const pins = this.pins.slice(0, 48);
    pins.forEach((p, i) => { A.set([p.x, p.y, p.r, p.type === 'push' ? 1 : 0], i * 4); B.set([p.type === 'push' ? p.dx : p.s, p.type === 'push' ? p.dy : 0, 0, 0], i * 4); });
    gl.uniform1i(prog.u.uPins, pins.length); gl.uniform4fv(prog.u.uPinA, A); gl.uniform4fv(prog.u.uPinB, B);
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
    const key = JSON.stringify([e.defocus, e.defocusR, e.temp, e.tint, e.exposure, this.pins, this.srcW, this.srcH, this.hasMask, wantBloom, bsz, this.lutVer]);
    if (!this.dirty && key === this.prepKey) return;
    this.prepKey = key; this.dirty = false;
    const gl = this.gl; const W = this.srcW, H = this.srcH;
    const t = e.temp / 100, ti = e.tint / 100, ev = Math.pow(2, e.exposure);
    const mul = [ev * (1 + 0.35 * t) * (1 + 0.1 * ti), ev * (1 - 0.22 * ti), ev * (1 - 0.35 * t) * (1 + 0.1 * ti)];
    const P = this.P.base;
    const w0 = this.target('W', W, H);
    this.draw(P, w0.fb, W, H); this.bindSrc(P); gl.uniform3fv(P.u.uMul, mul); this.warpUniforms(P); this.quad();
    if (this.origDirty) {
      const o = this.target('O', W, H); this.draw(P, o.fb, W, H); this.bindSrc(P); gl.uniform3fv(P.u.uMul, [1, 1, 1]); gl.uniform1i(P.u.uPins, 0); this.quad();
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
    const v = opts.view || [0.5, 0.5, 1, 1]; gl.uniform4f(P.u.uView, v[0], v[1], v[2], v[3]);
    gl.uniform1f(P.u.uBaseSat, this.baseSat);
    const f = (n, val) => gl.uniform1f(P.u[n], val);
    f('uContrast', e.contrast / 100); f('uHighlights', e.highlights / 100); f('uShadows', e.shadows / 100); f('uWhites', e.whites / 100); f('uBlacks', e.blacks / 100);
    f('uVibrance', e.vibrance / 100); f('uSaturation', e.saturation / 100); f('uClarity', e.clarity / 100); f('uDehaze', e.dehaze / 100); f('uTexture', (e.texture || 0) / 100);
    f('uSharpen', e.sharpen / 100); f('uDenoise', e.denoise / 100); f('uColorNoise', e.colorNoise / 100); f('uVignette', e.vignette / 100); f('uGrain', e.grain / 100); f('uBW', e.bw ? 1 : 0);
    f('uSmooth', e.smooth / 100); f('uBlemish', e.blemish / 100); f('uDark', e.darkCircle / 100); f('uTeeth', e.teeth / 100); f('uEyes', e.eyeBright / 100);
    f('uSubject', e.subjectLight / 100); f('uSkinEven', (e.skinEven || 0) / 100); f('uBgBlur', e.bgBlur / 100); f('uSky', e.sky / 100);
    gl.uniform1fv(P.u.uHslH, e.hslH.map(x => x / 100)); gl.uniform1fv(P.u.uHslS, e.hslS.map(x => x / 100)); gl.uniform1fv(P.u.uHslL, e.hslL.map(x => x / 100));
    for (const [u, k, d] of [['uStructure','structure',100],['uMatte','matte',100],['uSkinHue','skinHue',100],['uSkinSat','skinSat',100],['uSkinLum','skinLum',100],['uFaceLight','faceLight',100],['uContour','contour',100],['uLips','lips',100],['uBrows','brows',100],['uBlush','blush',100],['uBgLight','bgLight',100],['uBgSat','bgSat',100],['uBgClean','bgClean',100],['uSkyRep','skyRep',100],['uFog','fog',100],['uDust','dust',100],['uCmAmt','cmAmt',100]]) f(u, (e[k] || 0) / d);
    if (!e.cm) f('uCmAmt', 0);
    const cm = e.cm || { s: [1, 1, 1], o: [0, 0, 0] }; gl.uniform3fv(P.u.uCmS, cm.s); gl.uniform3fv(P.u.uCmO, cm.o);
    const HAIR = { brown: '#7a4a2a', chestnut: '#5a2e1a', blonde: '#d8b878', wine: '#7a1f35', black: '#1a1716', gray: '#a8a8ad', ash: '#8c8478', pink: '#d8899e' };
    const hx = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
    f('uHairAmt', (e.hairAmt || 0) / 100); f('uHairLum', (e.hairLum || 0) / 100); gl.uniform3fv(P.u.uHairCol, hx(HAIR[e.hairColor] || e.hairColor || '#7a4a2a'));
    f('uWater', (e.water || 0) / 100); f('uWaterCol', (e.waterColor || 0) / 100); f('uGlow', (e.glow || 0) / 100); f('uHal', (e.halation || 0) / 100); f('uStar', (e.star || 0) / 100); f('uTwilight', (e.twilight || 0) / 100);
    const BGS = { white: ['#ffffff', '#ffffff'], black: ['#0c0c0e', '#0c0c0e'], gray: ['#8d9096', '#5d6066'], studio: ['#6f7a88', '#2a2f38'], warm: ['#f3e3cf', '#c9a888'], blue: ['#9cc6ef', '#3a6fb0'], custom: [e.bgColor || '#ffffff', e.bgColor || '#ffffff'] };
    const bg = BGS[e.bgType] || BGS.white; f('uBgRep', (e.bgRep || 0) / 100); gl.uniform3fv(P.u.uBgCol, hx(bg[0])); gl.uniform3fv(P.u.uBgCol2, hx(bg[1]));
    gl.uniform1i(P.u.uAlphaOut, opts.alpha ? 1 : 0);
    const BWF = { none: [0.3, 0.59, 0.11], ye: [0.42, 0.52, 0.06], r: [0.72, 0.28, 0.0], g: [0.22, 0.72, 0.06] };
    gl.uniform3fv(P.u.uBwW, BWF[e.bwFilter] || BWF.none); gl.uniform3f(P.u.uBwTone, (e.bwToneH ?? 35) / 360, 0, (e.bwToneS || 0) / 100);
    gl.uniform3f(P.u.uGradeS, (e.gradeSH ?? 200) / 360, 0, (e.gradeSS || 0) / 100); gl.uniform3f(P.u.uGradeH, (e.gradeHH ?? 40) / 360, 0, (e.gradeHS || 0) / 100);
    f('uGradeBal', (e.gradeBal || 0) / 100); f('uChrome', (e.chrome || 0) / 100); f('uChromeBlue', (e.chromeBlue || 0) / 100); f('uBleach', (e.bleach || 0) / 100);
    f('uFocusAmt', e.focus ? (e.focusAmt || 0) / 100 : 0); f('uFocusRange', (e.focusRange ?? 15) / 100 * 0.4); gl.uniform1i(P.u.uHasDepth, this.hasDepth ? 1 : 0);
    f('uFocusD', e.focus && this.depthAt ? this.depthAt(e.focus.x, e.focus.y) : 0.5);
    f('uMist', (e.mist || 0) / 100); f('uMistSize', (e.mistSize ?? 50) / 100); f('uMistSoft', (e.mistSoft ?? 40) / 100); f('uMistWarm', e.mistWarm === false ? 0 : 1);
    const L = (e.local || []).filter(l => l.on !== false).slice(0, 4); const MT = { person: 0, bg: 1, sky: 2, skin: 3, hair: 4, water: 5, plants: 6, face: 7 };
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
    const gl = this.gl;
    for (const k in this.t) { gl.deleteTexture(this.t[k].tex); gl.deleteFramebuffer(this.t[k].fb); }
    this.t = {};
    if (this.srcTex) gl.deleteTexture(this.srcTex); this.srcTex = null;
    this.setMasks(null);
  }
}
