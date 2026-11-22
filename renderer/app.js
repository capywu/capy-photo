// Capy Photo — 介面與流程
import { Engine, DEFAULT_EDITS, isDefault, isFullCrop, effective } from './engine.js';
import { decodeRaw, decodeImage, cameraLook, fileURL } from './raw.js';
import { initAI, analyzeForCulling, buildMasks, pinsFor } from './ai.js';
import { applyHeals, detectLines, encodeRLE } from './heal.js';
import { deblurAI, backend as mlBackend } from './ml.js';
import { optimize, SCENE_NAMES } from './optimize.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

const COLORS = { red: '#d9534f', yellow: '#e8b04a', green: '#5cb85c', blue: '#4a8fe0', purple: '#9b6ce0' };
const AI_KEYS = ['smooth', 'blemish', 'skinEven', 'darkCircle', 'teeth', 'eyeBright', 'eyeEnlarge', 'slim', 'subjectLight', 'bgBlur', 'sky', 'enhance', 'matte', 'skinHue', 'skinSat', 'skinLum', 'faceLight', 'contour', 'lips', 'brows', 'blush', 'bgLight', 'bgSat', 'bgClean', 'skyRep', 'fog', 'dust', 'structure', 'hairAmt', 'hairLum', 'waist', 'bodySlim', 'water', 'waterColor', 'twilight', 'bgRep', 'focusAmt', 'atmo', 'ldepth'];
const needsAI = (e) => AI_KEYS.some(k => e[k]) || (e.local || []).length > 0;
// 富士底片模擬（依官方描述與常見特性調配，只改「色彩風格」，不動曝光、白平衡與人像修飾）
const FILM_LOOK_KEYS = ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation', 'clarity', 'hslH', 'hslS', 'hslL', 'curve', 'grain', 'bw', 'bwFilter', 'bwToneH', 'bwToneS', 'gradeSH', 'gradeSS', 'gradeHH', 'gradeHS', 'gradeBal', 'chrome', 'chromeBlue', 'bleach', 'dehaze', 'halation'];
const FILMS = [
  { cat: '經典特色與電影感' },
  { id: 'f_cc', name: 'Classic Chrome 經典正片', sw: 'linear-gradient(135deg,#9aa49a,#3d4a52)', e: { saturation: -28, contrast: 14, highlights: -12, blacks: -14, curve: [[0, 0], [0.25, 0.2], [0.75, 0.77], [1, 0.97]], hslH: [-6, -4, 6, 10, 0, -12, 0, 0], hslS: [-22, -10, -18, -22, -10, -12, -15, -20], gradeSH: 195, gradeSS: 10, gradeHH: 45, gradeHS: 6, chrome: 35 } },
  { id: 'f_cn', name: 'Classic Neg. 經典負片', sw: 'linear-gradient(135deg,#e8c9a0,#2f5a5a)', e: { saturation: -8, contrast: 26, highlights: -8, blacks: -10, curve: [[0, 0.02], [0.25, 0.19], [0.75, 0.8], [1, 0.97]], hslH: [-8, 0, -6, 14, 6, 0, 0, -6], hslS: [-10, -6, -14, -12, 0, -8, -10, -10], gradeSH: 172, gradeSS: 26, gradeHH: 38, gradeHS: 18, gradeBal: -10, grain: 12 } },
  { id: 'f_nn', name: 'Nostalgic Neg. 懷舊負片', sw: 'linear-gradient(135deg,#f2c27a,#5a4636)', e: { saturation: 6, contrast: 4, highlights: -22, shadows: 12, curve: [[0, 0.02], [0.3, 0.29], [0.75, 0.76], [1, 0.96]], hslS: [8, 10, 6, -6, -8, -10, 0, 0], gradeSH: 25, gradeSS: 8, gradeHH: 40, gradeHS: 32, gradeBal: 10, grain: 8 } },
  { id: 'f_et', name: 'ETERNA 電影', sw: 'linear-gradient(135deg,#c5ccc4,#4f6068)', e: { saturation: -32, contrast: -30, highlights: -30, shadows: 22, curve: [[0, 0.06], [0.5, 0.5], [1, 0.95]], hslH: [0, 0, 0, 10, 0, -6, 0, 0], gradeSH: 188, gradeSS: 14, gradeHH: 35, gradeHS: 6 } },
  { id: 'f_eb', name: 'ETERNA 電影漂白', sw: 'linear-gradient(135deg,#d8d8d2,#262a2e)', e: { bleach: 70, saturation: -45, contrast: 32, clarity: 14, highlights: -10, blacks: -12, gradeSH: 205, gradeSS: 10, gradeHH: 40, gradeHS: 4 } },
  { cat: '日常通用與風景高飽和' },
  { id: 'f_pv', name: 'PROVIA 標準', sw: 'linear-gradient(135deg,#7fb3e0,#3d7a3d)', e: { contrast: 6, vibrance: 6, curve: [[0, 0], [0.25, 0.24], [0.75, 0.77], [1, 1]] } },
  { id: 'f_vv', name: 'Velvia 鮮豔', sw: 'linear-gradient(135deg,#ff7a3d,#1f6fd1)', e: { saturation: 32, vibrance: 18, contrast: 24, blacks: -12, curve: [[0, 0], [0.25, 0.21], [0.75, 0.8], [1, 1]], hslS: [14, 10, 6, 18, 10, 20, 10, 10], hslL: [-4, 0, 0, -6, 0, -8, 0, 0], chrome: 40, chromeBlue: 35 } },
  { id: 'f_as', name: 'ASTIA 柔和', sw: 'linear-gradient(135deg,#f5c6b8,#6f9fc9)', e: { saturation: 14, contrast: -12, highlights: -16, shadows: 8, hslS: [6, -6, 4, 10, 6, 10, 0, 6], hslL: [0, 8, 0, 0, 0, 0, 0, 0], curve: [[0, 0.02], [0.5, 0.51], [1, 0.98]] } },
  { id: 'f_ra', name: 'REALA ACE', sw: 'linear-gradient(135deg,#d6dde6,#38505c)', e: { contrast: 16, vibrance: 6, saturation: 2, blacks: -8, curve: [[0, 0], [0.25, 0.22], [0.75, 0.78], [1, 0.99]], hslS: [0, -4, 0, 0, 0, 0, 0, 0] } },
  { cat: '人像專用負片' },
  { id: 'f_ph', name: 'PRO Neg. Hi', sw: 'linear-gradient(135deg,#f0d2c2,#5b6670)', e: { saturation: -8, contrast: 8, shadows: -6, blacks: -6, hslS: [-6, -12, -8, -10, 0, -6, 0, 0], hslL: [0, 6, 0, 0, 0, 0, 0, 0] } },
  { id: 'f_ps', name: 'PRO Neg. Std', sw: 'linear-gradient(135deg,#f3dccf,#8c959c)', e: { saturation: -14, contrast: -22, highlights: -12, shadows: 12, hslS: [-8, -14, -10, -12, 0, -8, 0, 0], hslL: [0, 8, 0, 0, 0, 0, 0, 0], curve: [[0, 0.03], [0.5, 0.51], [1, 0.97]] } },
  { cat: '黑白與單色懷舊' },
  { id: 'f_ac', name: 'ACROS', sw: 'linear-gradient(135deg,#eee,#111)', e: { bw: true, contrast: 16, blacks: -14, clarity: 10, grain: 22, curve: [[0, 0], [0.25, 0.2], [0.6, 0.62], [1, 1]] } },
  { id: 'f_acy', name: 'ACROS + 黃濾鏡', sw: 'linear-gradient(135deg,#f3f0d8,#111)', e: { bw: true, bwFilter: 'ye', contrast: 20, blacks: -14, clarity: 10, grain: 22, curve: [[0, 0], [0.25, 0.2], [0.6, 0.62], [1, 1]] } },
  { id: 'f_acr', name: 'ACROS + 紅濾鏡', sw: 'linear-gradient(135deg,#f2d6d6,#000)', e: { bw: true, bwFilter: 'r', contrast: 28, blacks: -18, clarity: 12, grain: 22, curve: [[0, 0], [0.25, 0.18], [0.6, 0.63], [1, 1]] } },
  { id: 'f_acg', name: 'ACROS + 綠濾鏡', sw: 'linear-gradient(135deg,#d9eedb,#111)', e: { bw: true, bwFilter: 'g', contrast: 12, blacks: -10, clarity: 6, grain: 22 } },
  { id: 'f_mo', name: '黑白 Monochrome', sw: 'linear-gradient(135deg,#ddd,#333)', e: { bw: true, contrast: 6 } },
  { id: 'f_moy', name: '黑白 + 黃濾鏡', sw: 'linear-gradient(135deg,#e9e6cf,#333)', e: { bw: true, bwFilter: 'ye', contrast: 10 } },
  { id: 'f_mor', name: '黑白 + 紅濾鏡', sw: 'linear-gradient(135deg,#e6caca,#222)', e: { bw: true, bwFilter: 'r', contrast: 20 } },
  { id: 'f_mog', name: '黑白 + 綠濾鏡', sw: 'linear-gradient(135deg,#d2e6d4,#333)', e: { bw: true, bwFilter: 'g', contrast: 4 } },
  { id: 'f_se', name: '復古棕 Sepia', sw: 'linear-gradient(135deg,#e8cfa4,#4a3520)', e: { bw: true, bwToneH: 32, bwToneS: 70, contrast: 4 } },
  { brand: 'kodak' },
  { cat: '柯達｜經典暖黃陽光' },
  { id: 'k_gd', name: 'Kodak Gold 200', sw: 'linear-gradient(135deg,#ffd166,#c2552d)', e: { saturation: 12, vibrance: 8, contrast: 10, highlights: -8, shadows: 6, hslH: [4, 6, -8, 8, 0, 0, 0, 0], hslS: [14, 12, 22, -10, -4, -6, 0, 0], hslL: [0, 4, 6, -6, 0, -4, 0, 0], gradeSH: 35, gradeSS: 10, gradeHH: 45, gradeHS: 26, gradeBal: 6, curve: [[0, 0.03], [0.25, 0.23], [0.75, 0.78], [1, 0.98]], grain: 14 } },
  { id: 'k_cp', name: 'Kodak ColorPlus 200', sw: 'linear-gradient(135deg,#f0a35e,#5a3d2a)', e: { saturation: 4, contrast: 18, highlights: -12, blacks: -6, hslH: [6, 4, -10, 10, 0, -4, 0, 0], hslS: [10, 14, 10, -16, -10, -12, 0, 0], gradeSH: 28, gradeSS: 14, gradeHH: 36, gradeHS: 30, gradeBal: 0, curve: [[0, 0.05], [0.25, 0.22], [0.75, 0.79], [1, 0.95]], grain: 26 } },
  { id: 'k_um', name: 'Kodak Ultramax 400', sw: 'linear-gradient(135deg,#e63946,#1d6fd1)', e: { saturation: 18, vibrance: 10, contrast: 20, blacks: -8, hslS: [18, 10, 10, 0, 6, 18, 6, 6], hslL: [-4, 0, 4, 0, 0, -6, 0, 0], gradeSH: 200, gradeSS: 6, gradeHH: 42, gradeHS: 16, curve: [[0, 0.02], [0.25, 0.21], [0.75, 0.79], [1, 0.99]], grain: 20 } },
  { cat: '柯達｜奶油人像粉彩' },
  { id: 'k_p4', name: 'Kodak Portra 400', sw: 'linear-gradient(135deg,#f6d5c3,#8fa7a0)', e: { saturation: -6, vibrance: 6, contrast: -12, highlights: -14, shadows: 10, hslH: [2, -2, -6, 6, 0, -6, 0, 0], hslS: [-6, -4, -6, -18, -8, -12, -10, -6], hslL: [4, 8, 4, 0, 0, 0, 0, 0], gradeSH: 185, gradeSS: 8, gradeHH: 30, gradeHS: 14, curve: [[0, 0.04], [0.25, 0.27], [0.75, 0.77], [1, 0.97]], grain: 8 } },
  { id: 'k_p16', name: 'Kodak Portra 160', sw: 'linear-gradient(135deg,#f3e0d6,#a9b7b2)', e: { saturation: -14, contrast: -18, highlights: -12, shadows: 12, hslS: [-10, -8, -10, -22, -10, -14, -12, -10], hslL: [4, 10, 4, 0, 0, 2, 0, 0], gradeSH: 190, gradeSS: 6, gradeHH: 28, gradeHS: 8, curve: [[0, 0.04], [0.25, 0.28], [0.75, 0.77], [1, 0.97]], grain: 4 } },
  { id: 'k_p8', name: 'Kodak Portra 800', sw: 'linear-gradient(135deg,#f2b880,#2f3e46)', e: { saturation: 6, vibrance: 8, contrast: 6, highlights: -12, shadows: 6, hslS: [8, 6, 4, -12, -4, -6, 0, 0], hslL: [0, 6, 0, 0, 0, 0, 0, 0], gradeSH: 195, gradeSS: 12, gradeHH: 38, gradeHS: 24, gradeBal: 8, curve: [[0, 0.04], [0.25, 0.24], [0.75, 0.77], [1, 0.97]], grain: 18 } },
  { cat: '柯達｜正片、高飽和與電影' },
  { id: 'k_e1', name: 'Kodak Ektachrome E100', sw: 'linear-gradient(135deg,#e8f1ff,#1c4fa0)', e: { saturation: 10, vibrance: 12, contrast: 20, blacks: -10, clarity: 8, hslS: [0, -6, 0, 4, 10, 20, 8, 0], hslL: [0, 2, 0, 0, 0, -6, 0, 0], gradeSH: 215, gradeSS: 12, gradeHH: 210, gradeHS: 6, chromeBlue: 25, curve: [[0, 0], [0.25, 0.21], [0.75, 0.8], [1, 1]] } },
  { id: 'k_ek', name: 'Kodak Ektar 100', sw: 'linear-gradient(135deg,#ff3d2e,#0b3d91)', e: { saturation: 30, vibrance: 14, contrast: 24, blacks: -12, clarity: 10, hslH: [-4, -6, 0, 6, 0, 4, 0, 0], hslS: [24, 20, 6, 10, 10, 24, 10, 10], hslL: [-6, -2, 0, -4, 0, -10, 0, 0], gradeHH: 38, gradeHS: 10, chrome: 35, chromeBlue: 25, curve: [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]] } },
  { id: 'k_5t', name: 'Kodak Vision3 500T', sw: 'linear-gradient(135deg,#ff6b4a,#0f3a52)', e: { saturation: -8, contrast: -6, highlights: -18, shadows: 10, hslH: [0, -4, 0, 0, 0, -10, 0, 0], hslS: [10, 6, -10, -20, 6, 10, 0, 0], gradeSH: 192, gradeSS: 32, gradeHH: 205, gradeHS: 10, gradeBal: -6, halation: 45, curve: [[0, 0.05], [0.25, 0.25], [0.75, 0.75], [1, 0.96]], grain: 16 } },
  { id: 'k_25d', name: 'Kodak Vision3 250D', sw: 'linear-gradient(135deg,#f1c27d,#355c7d)', e: { saturation: -6, contrast: -10, highlights: -20, shadows: 14, hslS: [4, 4, 0, -14, -4, 4, 0, 0], gradeSH: 205, gradeSS: 14, gradeHH: 40, gradeHS: 14, curve: [[0, 0.05], [0.25, 0.26], [0.75, 0.76], [1, 0.97]], grain: 10 } },
  { cat: '柯達｜經典黑白' },
  { id: 'k_tx', name: 'Kodak Tri-X 400', sw: 'linear-gradient(135deg,#f5f5f5,#000)', e: { bw: true, bwFilter: 'ye', contrast: 32, blacks: -22, whites: 6, clarity: 18, grain: 40, curve: [[0, 0], [0.25, 0.17], [0.75, 0.82], [1, 1]] } }
];
const BUILTIN_PRESETS = [
  { id: 'b1', name: '婚禮｜暖調柔光', sw: 'linear-gradient(135deg,#f3c79a,#b8735a)', e: { temp: 12, tint: 3, exposure: 0.15, contrast: 8, highlights: -35, shadows: 25, vibrance: 15, saturation: -5, clarity: 5, curve: [[0, 0.04], [0.25, 0.25], [0.75, 0.78], [1, 0.98]] } },
  { id: 'b2', name: '人像｜清透膚色', sw: 'linear-gradient(135deg,#ffe0cc,#d79a86)', e: { exposure: 0.25, highlights: -25, shadows: 20, vibrance: 10, hslL: [0, 12, 0, 0, 0, 0, 0, 0], hslS: [0, -10, 0, 0, 0, 0, 0, 0], smooth: 35, blemish: 50, darkCircle: 25, eyeBright: 20 } },
  { id: 'b3', name: '人像｜日系低對比', sw: 'linear-gradient(135deg,#dfe8e4,#9fb5ae)', e: { exposure: 0.35, contrast: -25, highlights: -40, shadows: 30, whites: -10, blacks: -20, temp: -6, tint: 4, saturation: -12, hslH: [0, 0, 0, 20, 0, 0, 0, 0], curve: [[0, 0.08], [0.5, 0.52], [1, 0.95]] } },
  { id: 'b4', name: '商品｜乾淨明亮', sw: 'linear-gradient(135deg,#ffffff,#c9ccd3)', e: { exposure: 0.3, whites: 25, blacks: -5, contrast: 10, clarity: 10, sharpen: 40, vibrance: 5 } },
  { id: 'b5', name: '風景｜黃金時刻', sw: 'linear-gradient(135deg,#ffbf5a,#5a7bb5)', e: { temp: 18, vibrance: 25, dehaze: 12, clarity: 15, highlights: -30, shadows: 25, sky: 40, hslS: [0, 12, 0, 0, 0, 0, 0, 0] } },
  { id: 'b6', name: '黑白｜高反差', sw: 'linear-gradient(135deg,#eee,#222)', e: { bw: true, contrast: 35, clarity: 20, blacks: -15, whites: 15 } }
];

const S = {
  projects: [], presets: [], settings: {}, cur: null, photos: [], cacheDir: '',
  view: 'lib', libMode: 'grid', sel: new Set(), focus: null, anchor: null,
  filter: { folder: null, smart: null, minRating: 0, flag: null, edited: null, color: null, camera: null },
  sort: 'date', clipboard: null, jobs: { derive: [0, 0], ai: [0, 0], thumbs: [0, 0] }
};

const api = window.api;
const photoById = (id) => S.photos.find(p => p.id === id);
const thumbURL = (p) => p.thumbVer ? fileURL(`${S.cacheDir}${api.sep}${p.id}_${p.edVer ? 'e_t' : 't'}.jpg`) + `?v=${p.edVer || p.thumbVer}` : '';
const previewURL = (p) => p.thumbVer ? fileURL(`${S.cacheDir}${api.sep}${p.id}_${p.edVer ? 'e' : 'p'}.jpg`) + `?v=${p.edVer || p.thumbVer}` : '';
const origPreviewURL = (p) => fileURL(`${S.cacheDir}${api.sep}${p.id}_p.jpg`) + `?v=${p.thumbVer}`;
const dateOf = (p) => { const d = p.info?.date; if (d) { const m = d.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/); if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); } return p.mtime || 0; };

function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }

// ─────────────────────────── 啟動 ───────────────────────────
async function boot() {
  const v = await api.version(); document.title = 'Capy Photo V' + v.replace(/\.0$/, ''); $('#ver').textContent = 'V' + v.replace(/\.0$/, '').replace(/^(\d+)$/, '$1.0');
  const st = await api.getState();
  S.projects = st.projects; S.presets = st.presets || []; S.settings = st.settings || {};
  document.documentElement.style.setProperty('--ts', (S.settings.thumbSize || 180) + 'px');
  bindGlobal();
  if (S.projects.length) await openProject(S.settings.lastProject && S.projects.find(p => p.id === S.settings.lastProject) ? S.settings.lastProject : S.projects[0].id);
  else renderLibrary();
  initAI().catch(err => console.warn('AI 載入失敗', err));
}

function saveSettings() { api.saveSettings(S.settings); }

async function openProject(id) {
  const p = await api.openProject(id);
  S.cur = S.projects.find(x => x.id === id); S.photos = p.photos; S.cacheDir = p.cacheDir;
  S.sel.clear(); S.focus = S.photos[0]?.id || null;
  S.filter = { folder: null, smart: null, minRating: 0, flag: null, edited: null, color: null, camera: null };
  S.settings.lastProject = id; saveSettings();
  if (S.view === 'edit') switchView('lib');
  renderLibrary();
  resumeJobs();
}

// ─────────────────────────── 篩選 ───────────────────────────
function filtered() {
  const f = S.filter;
  let list = S.photos.filter(p => {
    if (f.folder != null && p.folder !== f.folder) return false;
    if (f.minRating && (p.rating || 0) < f.minRating) return false;
    if (f.flag === 'pick' && p.flag !== 1) return false;
    if (f.flag === 'reject' && p.flag !== -1) return false;
    if (f.flag === 'none' && p.flag) return false;
    if (f.edited === true && !p.edits) return false;
    if (f.edited === false && p.edits) return false;
    if (f.color && p.color !== f.color) return false;
    if (f.camera && p.info?.model !== f.camera) return false;
    if (f.smart === 'closed' && !(p.ai?.closed > 0)) return false;
    if (f.smart === 'blur' && !p.ai?.blur) return false;
    if (f.smart === 'similar' && !p.ai?.group) return false;
    if (f.smart === 'best' && !p.ai?.best) return false;
    if (f.smart === 'faces' && !(p.ai?.faces > 0)) return false;
    if (f.smart === 'smile' && !(p.ai?.smiles > 0)) return false;
    return true;
  });
  const by = {
    date: (a, b) => dateOf(a) - dateOf(b), name: (a, b) => a.name.localeCompare(b.name), rating: (a, b) => (b.rating || 0) - (a.rating || 0) || dateOf(a) - dateOf(b),
    sharp: (a, b) => (b.ai?.score || 0) - (a.ai?.score || 0)
  }[S.sort] || ((a, b) => 0);
  list.sort(by);
  if (f.smart === 'similar') list.sort((a, b) => (a.ai.group - b.ai.group) || dateOf(a) - dateOf(b));
  return list;
}

// ─────────────────────────── 圖庫畫面 ───────────────────────────
function renderLibrary() { renderLibSide(); renderLibBar(); renderGrid(); renderInfo(); renderStatus(); }

function renderLibSide() {
  const ps = S.photos;
  const count = (fn) => ps.filter(fn).length;
  const folders = [...new Set(ps.map(p => p.folder))].sort();
  const cams = [...new Set(ps.map(p => p.info?.model).filter(Boolean))];
  const groups = new Set(ps.filter(p => p.ai?.group).map(p => p.ai.group)).size;
  const f = S.filter;
  const smart = (k, label, n) => `<div class="item ${f.smart === k ? 'on' : ''}" data-smart="${k}"><span class="nm">${label}</span><span>${n}</span></div>`;
  $('#libSide').innerHTML = `
  <h4>專案</h4>
  ${S.projects.map(p => `<div class="item ${S.cur?.id === p.id ? 'on' : ''}" data-proj="${p.id}"><span class="nm">${esc(p.name)}</span><span>${S.cur?.id === p.id ? ps.length : p.count || 0}</span></div>`).join('')}
  <div class="item add" id="newProj">＋ 新增專案</div>
  ${S.cur ? `
  <h4>資料夾</h4>
  <div class="item ${f.folder == null ? 'on' : ''}" data-folder="__all"><span class="nm">全部照片</span><span>${ps.length}</span></div>
  ${folders.map(d => `<div class="item ${f.folder === d ? 'on' : ''}" data-folder="${esc(d)}"><span class="nm">📁 ${esc(d || '(根目錄)')}</span><span>${count(p => p.folder === d)}</span></div>`).join('')}
  <h4>智慧挑片 <span class="ai">AI</span></h4>
  ${smart('best', '⭐ AI 推薦（每組最佳）', count(p => p.ai?.best))}
  ${smart('closed', '閉眼照片', count(p => p.ai?.closed > 0))}
  ${smart('blur', '失焦 / 模糊', count(p => p.ai?.blur))}
  ${f.smart === 'blur' ? '<div class="item" id="fixBlur"><span class="nm" style="color:#e0874a">✦ 一鍵救回這些模糊照片</span></div>' : ''}
  ${smart('similar', '相似照片群組', groups + ' 組')}
  ${smart('faces', '有人臉的照片', count(p => p.ai?.faces > 0))}
  ${smart('smile', '笑容', count(p => p.ai?.smiles > 0))}
  <div class="item" id="aiPickAll"><span class="nm" style="color:#e0874a">✦ 一鍵 AI 挑片</span></div>
  <div class="item" id="reAnalyze"><span class="nm" style="color:#9aa">↻ 重新 AI 分析全部照片</span></div>
  <div class="item" id="aiRateAll"><span class="nm" style="color:#e0874a">✦ AI 自動評星</span></div>
  <h4>篩選</h4>
  <div class="chips">
    ${[1, 2, 3, 4, 5].map(r => `<div class="chip ${f.minRating === r ? 'on' : ''}" data-rating="${r}">★${r}${r < 5 ? '+' : ''}</div>`).join('')}
    <div class="chip ${f.flag === 'pick' ? 'on' : ''}" data-flag="pick">⚑ 已選</div>
    <div class="chip ${f.flag === 'reject' ? 'on' : ''}" data-flag="reject">✕ 淘汰</div>
    <div class="chip ${f.flag === 'none' ? 'on' : ''}" data-flag="none">未標記</div>
    <div class="chip ${f.edited === true ? 'on' : ''}" data-edited="1">已修圖</div>
    <div class="chip ${f.edited === false ? 'on' : ''}" data-edited="0">未修圖</div>
    ${cams.map(c => `<div class="chip ${f.camera === c ? 'on' : ''}" data-cam="${esc(c)}">${esc(c)}</div>`).join('')}
  </div>
  <h4>色標</h4>
  <div class="chips">${Object.entries(COLORS).map(([k, c]) => `<div class="cdot ${f.color === k ? 'on' : ''}" data-color="${k}" style="background:${c}"></div>`).join('')}</div>
  ` : ''}`;
}

function renderLibBar() {
  const list = filtered();
  $('#libBar').innerHTML = S.cur ? `
    <span class="ttl">${esc(S.cur.name)}${S.filter.folder != null ? ' / ' + esc(S.filter.folder) : ''}</span><span>顯示 ${list.length} / ${S.photos.length} 張</span>
    <div class="spacer"></div>
    <span>排序 <select id="sort">${[['date', '拍攝時間'], ['name', '檔名'], ['rating', '評等'], ['sharp', 'AI 品質分數']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></span>
    <span>縮圖 <input type="range" id="tsize" min="110" max="360" value="${S.settings.thumbSize || 180}" style="width:90px;vertical-align:middle"></span>
    <span class="lnk ${S.libMode === 'grid' ? 'on' : ''}" data-mode="grid">▦ 格狀</span>
    <span class="lnk ${S.libMode === 'loupe' ? 'on' : ''}" data-mode="loupe">▭ 單張</span>
    <span class="lnk ${S.libMode === 'compare' ? 'on' : ''}" data-mode="compare">◫ 比較</span>` : '';
}

function tileHTML(p) {
  const r = p.rating || 0;
  const b = [];
  if (p.ai?.best) b.push('<span class="badge g">★ AI 推薦</span>');
  if (p.ai?.closed > 0) b.push('<span class="badge">閉眼</span>');
  if (p.ai?.blur) b.push('<span class="badge">模糊</span>');
  if (p.ai?.group && p.ai.groupSize > 1) b.push(`<span class="badge b">相似 ×${p.ai.groupSize}</span>`);
  const u = thumbURL(p);
  return `<div class="th ${S.sel.has(p.id) ? 'sel' : ''} ${S.focus === p.id ? 'focus' : ''} ${p.flag === -1 ? 'rej' : ''}" data-id="${p.id}">
    <div class="ph">${u ? `<img src="${u}" loading="lazy" decoding="async" draggable="false">` : '產生預覽中…'}</div>
    <div class="badges">${b.join('')}</div>
    ${p.flag === 1 ? '<div class="flag">⚑</div>' : p.flag === -1 ? '<div class="flag rej">✕</div>' : ''}
    ${p.edits ? '<div class="edited">✎</div>' : ''}
    ${p.color ? `<div class="cbar" style="background:${COLORS[p.color]}"></div>` : ''}
    <div class="meta"><span class="stars">${'★'.repeat(r)}<i>${'★'.repeat(5 - r)}</i></span><span class="fn">${esc(p.name)}</span></div></div>`;
}

function renderGrid() {
  const list = filtered();
  const empty = $('#empty');
  if (!S.cur || !S.photos.length) {
    $('#grid').innerHTML = ''; $('#loupe').classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = S.cur ? `<div class="big">這個專案還沒有照片</div><div>可匯入整個資料夾的 RAW（ARW、NEF、DNG、PEF…），也可以直接把資料夾拖進來</div><div style="display:flex;gap:8px"><div class="btn p" data-imp="dir">匯入資料夾</div><div class="btn" data-imp="files">選擇檔案</div></div>`
      : `<div class="big">歡迎使用 Capy Photo</div><div>先建立一個專案（例如「2026-11 婚禮」），再匯入照片</div><div class="btn p" id="emptyNew">＋ 建立專案</div>`;
    return;
  }
  empty.classList.add('hidden');
  if (S.libMode === 'grid') {
    $('#loupe').classList.add('hidden'); $('#grid').classList.remove('hidden');
    $('#grid').innerHTML = list.map(tileHTML).join('');
  } else {
    $('#grid').classList.add('hidden'); renderLoupe();
  }
}
function updateTile(id) {
  const p = photoById(id); const el = document.querySelector(`.th[data-id="${id}"]`);
  if (el && p) { const tmp = document.createElement('div'); tmp.innerHTML = tileHTML(p); el.replaceWith(tmp.firstElementChild); }
  if (S.libMode !== 'grid' && (id === S.focus)) renderLoupe();
}
function renderLoupe() {
  const L = $('#loupe'); L.classList.remove('hidden');
  const p = photoById(S.focus); if (!p) { L.innerHTML = ''; return; }
  const pane = (q, act) => q ? `<div class="pane ${act ? 'act' : ''}" data-id="${q.id}"><img src="${previewURL(q)}" draggable="false"><div class="cap">${esc(q.name)} · ${'★'.repeat(q.rating || 0) || '未評等'} ${q.flag === 1 ? '⚑' : q.flag === -1 ? '✕' : ''} ${q.ai?.closed ? '· 閉眼' : ''}${q.ai?.blur ? ' · 模糊' : ''}</div></div>` : '';
  if (S.libMode === 'compare') {
    const list = filtered(); const i = list.findIndex(x => x.id === S.focus);
    const other = [...S.sel].map(photoById).find(x => x && x.id !== p.id) || list[i + 1] || list[i - 1];
    L.innerHTML = pane(p, true) + pane(other, false);
  } else L.innerHTML = pane(p, false);
}

function renderInfo() {
  const p = photoById(S.focus);
  if (!p) { $('#libInfo').innerHTML = '<h4>資訊</h4><div class="hint">選一張照片查看拍攝資訊</div>'; return; }
  const i = p.info || {};
  const exp = i.exposure ? (i.exposure >= 1 ? i.exposure + 's' : '1/' + Math.round(1 / i.exposure) + 's') : '';
  const r = p.rating || 0;
  $('#libInfo').innerHTML = `
  <h4>直方圖</h4><div class="hist"><canvas id="libHist" width="560" height="192"></canvas></div>
  <h4>拍攝資訊</h4>
  <div class="kv"><span>檔名</span><span title="${esc(p.path)}">${esc(p.name)}</span></div>
  <div class="kv"><span>相機</span><span>${esc([i.make, i.model].filter(Boolean).join(' ') || '—')}</span></div>
  <div class="kv"><span>鏡頭</span><span>${esc(i.lens || '—')}</span></div>
  <div class="kv"><span>參數</span><span>${[i.fnum ? 'f/' + (+i.fnum).toFixed(1) : '', exp, i.iso ? 'ISO ' + i.iso : '', i.focal ? Math.round(i.focal) + 'mm' : ''].filter(Boolean).join(' · ') || '—'}</span></div>
  <div class="kv"><span>拍攝時間</span><span>${esc((i.date || '').replace(/^(\d{4}):(\d\d):(\d\d)/, '$1/$2/$3') || '—')}</span></div>
  <div class="kv"><span>尺寸</span><span>${i.width ? `${i.width} × ${i.height} · ${Math.round(i.width * i.height / 1e6)}MP` : (p.dims ? p.dims.join(' × ') : '—')}</span></div>
  <div class="kv"><span>檔案</span><span>${p.ext} · ${(p.size / 1048576).toFixed(1)} MB</span></div>
  <h4>標記</h4>
  <div class="kv rate"><span>評等</span><span class="stars">${[1, 2, 3, 4, 5].map(n => `<span data-setrate="${n}">${n <= r ? '★' : '<i>★</i>'}</span>`).join('')}</span></div>
  <div class="kv"><span>旗標</span><span class="chips"><span class="chip ${p.flag === 1 ? 'on' : ''}" data-setflag="1">⚑ 選取</span><span class="chip ${p.flag === -1 ? 'on' : ''}" data-setflag="-1">✕ 淘汰</span></span></div>
  <div class="kv"><span>色標</span><span class="chips">${Object.entries(COLORS).map(([k, c]) => `<div class="cdot ${p.color === k ? 'on' : ''}" data-setcolor="${k}" style="background:${c}"></div>`).join('')}</span></div>
  <h4>AI 分析 <span class="ai">AI</span></h4>
  ${p.ai?.analyzed ? `
  <div class="kv"><span>人臉</span><span>${p.ai.faces || 0} 人${p.ai.closed ? `，${p.ai.closed} 人閉眼` : ''}${p.ai.smiles ? `，${p.ai.smiles} 人笑` : ''}</span></div>
  <div class="kv"><span>清晰度</span><span>${p.ai.blur ? '偏模糊' : '清晰'}（${Math.round(p.ai.score || 0)} 分）</span></div>
  <div class="kv"><span>相似群組</span><span>${p.ai.group ? `第 ${p.ai.group} 組，共 ${p.ai.groupSize} 張${p.ai.best ? '（本組最佳）' : ''}` : '無'}</span></div>` : '<div class="hint">分析中…</div>'}
  <h4>快速修圖</h4>
  <div class="chips"><span class="chip" data-quick="edit">進入編輯 (E)</span><span class="chip" data-quick="optimize">✦ AI 最佳化修圖</span><span class="chip" data-quick="beauty">一鍵人像美化</span><span class="chip" data-quick="deblur">AI 去模糊</span><span class="chip" data-quick="preset">套用預設…</span><span class="chip" data-quick="film">軟片模擬…</span><span class="chip" data-quick="copy">複製設定</span><span class="chip ${S.clipboard ? '' : 'dis'}" data-quick="paste">貼上設定</span><span class="chip" data-quick="reset">重設修圖</span></div>
  <div class="hint" style="margin-top:10px">選取多張後按「貼上設定」或「套用預設」可整批修圖。</div>`;
  drawHist($('#libHist'), p.ai?.hist);
}
function drawHist(cv, hist) {
  if (!cv) return; const x = cv.getContext('2d'); x.clearRect(0, 0, cv.width, cv.height);
  if (!hist) return;
  const draw = (h, color) => { const mx = Math.max(...h.slice(1, -1), 1); x.fillStyle = color; x.beginPath(); x.moveTo(0, cv.height); h.forEach((v, i) => x.lineTo(i / (h.length - 1) * cv.width, cv.height - Math.min(1, v / mx) * cv.height * 0.95)); x.lineTo(cv.width, cv.height); x.fill(); };
  if (hist.r) { x.globalCompositeOperation = 'lighter'; draw(hist.r, 'rgba(230,80,70,.55)'); draw(hist.g, 'rgba(90,200,100,.5)'); draw(hist.b, 'rgba(80,130,240,.6)'); x.globalCompositeOperation = 'source-over'; }
  else draw(hist, 'rgba(200,205,215,.45)');
}

function renderStatus() {
  const j = S.jobs;
  const parts = [];
  let pr = null;
  if (j.derive[1] && j.derive[0] < j.derive[1]) { parts.push(`產生預覽中 ${j.derive[0]} / ${j.derive[1]}`); pr = j.derive[0] / j.derive[1]; }
  else if (j.ai[1] && j.ai[0] < j.ai[1]) { parts.push(`AI 挑片分析中 ${j.ai[0]} / ${j.ai[1]}`); pr = j.ai[0] / j.ai[1]; }
  else if (j.thumbs[1] && j.thumbs[0] < j.thumbs[1]) { parts.push(`更新修圖縮圖 ${j.thumbs[0]} / ${j.thumbs[1]}`); pr = j.thumbs[0] / j.thumbs[1]; }
  $('#status').innerHTML = `<span>已選 ${S.sel.size} 張</span><span>1–5 評星 · P 選取 · X 淘汰 · U 取消 · ←→ 切換 · 空白鍵 單張/格狀 · E 編輯 · Ctrl+C / Ctrl+V 複製貼上設定</span><div class="spacer"></div>${parts.map(t => `<span>${t}</span>`).join('')}${pr != null ? `<div class="prog"><b style="width:${Math.round(pr * 100)}%"></b></div>` : ''}`;
}

// ─────────────────────────── 選取與標記 ───────────────────────────
function select(id, e) {
  const list = filtered();
  if (e && (e.ctrlKey || e.metaKey)) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); }
  else if (e && e.shiftKey && S.anchor) {
    const a = list.findIndex(p => p.id === S.anchor), b = list.findIndex(p => p.id === id);
    if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(list[i].id); }
  } else { S.sel.clear(); S.sel.add(id); S.anchor = id; }
  S.focus = id;
  document.querySelectorAll('.th').forEach(el => { el.classList.toggle('sel', S.sel.has(el.dataset.id)); el.classList.toggle('focus', el.dataset.id === id); });
  renderInfo(); renderStatus();
  if (S.libMode !== 'grid') renderLoupe();
}
function targets() { return S.sel.size ? [...S.sel] : (S.focus ? [S.focus] : []); }
async function patchPhotos(ids, patch) {
  ids.forEach(id => Object.assign(photoById(id) || {}, patch));
  await api.updatePhotos(S.cur.id, ids, patch);
  ids.forEach(updateTile);
  renderInfo(); renderLibSide();
  if (S.view === 'edit') renderFilm();
}
function move(dx, extend) {
  const list = filtered(); if (!list.length) return;
  let i = list.findIndex(p => p.id === S.focus);
  if (S.libMode === 'grid' && S.view === 'lib' && Math.abs(dx) > 1) {
    const g = $('#grid'); const tile = g.querySelector('.th'); const cols = tile ? Math.max(1, Math.round(g.clientWidth / (tile.offsetWidth + 10))) : 1;
    dx = Math.sign(dx) * cols;
  }
  i = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + dx));
  const id = list[i].id;
  if (S.view === 'edit') { openEdit(id); return; }
  select(id, extend ? { shiftKey: true } : null);
  const el = document.querySelector(`.th[data-id="${id}"]`); el && el.scrollIntoView({ block: 'nearest' });
}

// ─────────────────────────── 匯入與背景作業 ───────────────────────────
async function doImport(mode) {
  if (!S.cur) { const name = await askText('建立專案', '專案名稱', defaultProjectName()); if (!name) return; await createProject(name); }
  const r = await api.pickImport(mode); if (!r || !r.files.length) { if (r) toast('資料夾裡沒有找到支援的照片'); return; }
  await importFiles(r.files, r.roots);
}
async function importFiles(files, roots) {
  const added = await api.addImport(S.cur.id, files, roots);
  if (!added.length) { toast('這些照片已經在專案裡了'); return; }
  S.photos.push(...added);
  toast(`已加入 ${added.length} 張照片，背景產生預覽中…`);
  renderLibrary();
  resumeJobs();
}
function defaultProjectName() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')} 新專案`; }
async function createProject(name) { const m = await api.createProject(name); S.projects.unshift(m); await openProject(m.id); }

// 縮圖產生（3 個背景執行緒）
const workers = [...Array(Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 2)))].map(() => new Worker('thumbworker.js'));
let deriveRunning = false;
async function resumeJobs() {
  if (!S.cur) return;
  const projId = S.cur.id;
  if (!deriveRunning) runDerive(projId);
}
async function runDerive(projId) {
  deriveRunning = true;
  try {
    const todo = () => S.photos.filter(p => !p.thumbVer && !p.failed);
    let list = todo();
    S.jobs.derive = [0, list.length];
    const pending = new Map();
    workers.forEach(w => w.onmessage = (ev) => { const cb = pending.get(ev.data.id); pending.delete(ev.data.id); cb && cb(ev.data); });
    const run = (w, p) => new Promise(async (resolve) => {
      let em = await api.embedded(p.path);
      if (!em) em = await fallbackPreview(p);
      if (!em) { p.failed = true; resolve(null); return; }
      pending.set(p.id, resolve);
      const buf = em.buf.buffer ? em.buf.buffer.slice(em.buf.byteOffset, em.buf.byteOffset + em.buf.byteLength) : em.buf;
      w.postMessage({ id: p.id, buf, type: em.type, orientation: em.srgbDone ? 1 : (p.info?.orientation || 1) }, [buf]);
    });
    let idx = 0;
    await Promise.all(workers.map(async (w) => {
      while (idx < list.length) {
        if (S.cur?.id !== projId) return;
        const p = list[idx++];
        const r = await run(w, p);
        if (r && r.ok) {
          await api.saveDerived(projId, p.id, r.thumb, r.preview);
          const ai = { ...(p.ai || {}), hash: r.hash, sharp: r.sharp, hist: r.hist };
          p.thumbVer = 1; p.ai = ai; p.dims = [r.w, r.h];
          api.updatePhotos(projId, [p.id], { thumbVer: 1, ai, dims: p.dims });
          updateTile(p.id); if (p.id === S.focus) renderInfo();
        } else { p.failed = true; updateTile(p.id); }
        S.jobs.derive[0]++; renderStatusThrottled();
      }
    }));
  } finally { deriveRunning = false; }
  renderStatus();
  runAI(projId);
}
let stT = 0; function renderStatusThrottled() { const n = performance.now(); if (n - stT > 250) { stT = n; renderStatus(); } }

// 沒有內嵌預覽時，直接解 RAW 產生
async function fallbackPreview(p) {
  if (!p.isRaw) return null;
  try {
    const src = await decodeRaw(p.path, true);
    const look = await cameraLook(src, null);
    const eng = bgEngine(); eng.setSource(src); eng.setBase(look.lut, look.sat);
    const s = Math.min(1, 2048 / Math.max(src.width, src.height));
    const w = Math.round(src.width * s), h = Math.round(src.height * s);
    const img = eng.renderPixels(DEFAULT_EDITS(), w, h);
    const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return { buf: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', srgbDone: true };
  } catch (err) { console.warn('fallback', err); return null; }
}

let aiRunning = false;
async function runAI(projId) {
  if (aiRunning) return; aiRunning = true;
  try {
    await initAI();
    const list = S.photos.filter(p => p.thumbVer && !p.ai?.analyzed);
    S.jobs.ai = [0, list.length]; renderStatus();
    for (const p of list) {
      if (S.cur?.id !== projId) return;
      try {
        const blob = await (await fetch(origPreviewURL(p))).blob();
        const bmp = await createImageBitmap(blob);
        const r = await analyzeForCulling(bmp); bmp.close();
        p.ai = { ...p.ai, ...r, analyzed: true };
      } catch (err) { console.warn('ai', err); p.ai = { ...p.ai, analyzed: true }; }
      S.jobs.ai[0]++; renderStatusThrottled();
      if (S.jobs.ai[0] % 20 === 0) { computeGroups(); }
    }
    computeGroups();
    for (const p of S.photos) await api.updatePhotos(projId, [p.id], { ai: p.ai });
  } finally { aiRunning = false; renderStatus(); renderLibSide(); renderInfo(); }
}

function hamming(a, b) { if (!a || !b || a.length !== b.length) return 64; let d = 0; for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } } return d; }
// 相似群組、模糊判斷、每組最佳
function computeGroups() {
  const ps = [...S.photos].filter(p => p.ai?.hash).sort((a, b) => dateOf(a) - dateOf(b));
  let g = 0, prev = null;
  for (const p of ps) {
    const sameShot = prev && hamming(p.ai.hash, prev.ai.hash) <= 12 && Math.abs(dateOf(p) - dateOf(prev)) <= 20000;
    if (!sameShot) g++;
    p.ai._g = g; prev = p;
  }
  const by = new Map(); ps.forEach(p => { if (!by.has(p.ai._g)) by.set(p.ai._g, []); by.get(p.ai._g).push(p); });
  const metric = (p) => p.ai.faceSharp != null ? Math.min(100, Math.sqrt(p.ai.faceSharp) * 8) : Math.min(100, Math.sqrt(p.ai.sharp || 0) * 1.2);
  let gid = 0;
  for (const [, arr] of by) {
    const isGroup = arr.length > 1; if (isGroup) gid++;
    const gmax = Math.max(...arr.map(metric));
    for (const p of arr) {
      const m = metric(p);
      p.ai.score = Math.round(Math.min(100, m * (p.ai.closed ? 0.4 : 1) + (p.ai.faces ? 8 * (p.ai.smiles || 0) / p.ai.faces : 0)));
      p.ai.group = isGroup ? gid : 0; p.ai.groupSize = isGroup ? arr.length : 0;
      // 臉部：銳利度分數 < 40；無臉：< 20；同組明顯比最清楚那張差
      p.ai.blur = (p.ai.faceSharp != null ? m < 40 : m < 20) || (isGroup && m < gmax * 0.55);
    }
    const best = [...arr].sort((a, b) => (b.ai.score || 0) - (a.ai.score || 0))[0];
    for (const p of arr) p.ai.best = isGroup ? p === best : false;
  }
  for (const p of ps) delete p.ai._g;
  if (S.view === 'lib') { renderLibSide(); renderGrid(); renderInfo(); }
}

// 一鍵 AI 挑片：每組最佳 → ⚑，閉眼/模糊 → ✕
async function aiPickAll() {
  const ok = await api.confirm('一鍵 AI 挑片', '會把每組相似照片中最好的一張和單獨的清晰照片標為「⚑ 選取」，閉眼和模糊的標為「✕ 淘汰」。已經手動標記過的照片不會更動。');
  if (!ok) return;
  const pick = [], rej = [];
  for (const p of S.photos) {
    if (p.flag || !p.ai?.analyzed) continue;
    if (p.ai.closed > 0 || p.ai.blur) rej.push(p.id);
    else if (p.ai.best || !p.ai.group) pick.push(p.id);
  }
  if (pick.length) await patchPhotos(pick, { flag: 1 });
  if (rej.length) await patchPhotos(rej, { flag: -1 });
  toast(`已選取 ${pick.length} 張，淘汰 ${rej.length} 張`);
  renderGrid();
}

// AI 自動評星：依清晰度、閉眼、是否為組內最佳（不動已評等的照片）
async function aiRateAll() {
  if (!(await api.confirm('AI 自動評星', '依 AI 品質分數替還沒評等的照片打 1–5 星：組內最佳且清晰 5 星，清晰 3–4 星，模糊或閉眼 1 星。'))) return;
  const by = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const p of S.photos) {
    if (p.rating || !p.ai?.analyzed) continue;
    const sc = p.ai.score || 0;
    let r = p.ai.closed > 0 || p.ai.blur ? 1 : sc >= 85 ? 4 : sc >= 65 ? 3 : 2;
    if (p.ai.best && r >= 3) r = 5;
    by[r].push(p.id);
  }
  let n = 0; for (const r of [1, 2, 3, 4, 5]) if (by[r].length) { await patchPhotos(by[r], { rating: r }); n += by[r].length; }
  toast(`已替 ${n} 張照片評星`); renderGrid();
}

// ─────────────────────────── 編輯畫面 ───────────────────────────
let engine = null, bg = null;
const E = { brush: { size: 0.04, f: 0.6, flow: 0.7, erase: false }, brushMode: false, showMask: false, layerSel: null, focusMode: false, healMode: false, healR: 0.02, photo: null, edits: null, src: null, masks: null, maskState: 'none', undo: [], redo: [], split: null, zoom: 'fit', pan: [0.5, 0.5], tab: 'basic', hslTab: 'hslS', crop: false, hover: null, decodeToken: 0 };
const decodeCache = new Map(); // photoId -> {src, look}
function bgEngine() { if (!bg) { const c = document.createElement('canvas'); c.width = c.height = 16; bg = new Engine(c); } return bg; }

function switchView(v) {
  if (v === 'edit' && !S.focus) { toast('先選一張照片'); return; }
  if (S.view === 'edit' && v !== 'edit') leaveEdit();
  S.view = v;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === v));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('on', el.id === v));
  if (v === 'edit') openEdit(S.focus); else renderLibrary();
}

async function openEdit(id) {
  const p = photoById(id); if (!p) return;
  if (E.photo && E.photo.id !== id) await commitEditThumb(E.photo);
  if (!engine) { try { engine = new Engine($('#cv')); engine.onSkyLoaded = () => draw(); } catch (err) { toast('無法啟動圖形引擎：' + err.message, 6000); return; } }
  S.focus = id; if (!S.sel.has(id) || S.sel.size <= 1) { S.sel.clear(); S.sel.add(id); }
  E.photo = p; E.edits = { ...DEFAULT_EDITS(), ...clone(p.edits || {}) }; E.undo = []; E.redo = []; E.masks = null; E.maskState = 'none'; E.split = null; E.zoom = 'fit'; E.crop = false; E.healMode = false; E.focusMode = false; E.healKey = ''; E.layerSel = null; if (E.brushMode) setBrushMode(false); E.deblurDone = 0;
  renderEditSide(); renderEditBar(); renderTools(); renderFilm();
  const token = ++E.decodeToken;
  // 先顯示預覽圖
  const ph = $('#placeholder'); ph.src = previewURL(p); ph.classList.remove('hidden'); $('#cv').style.visibility = 'hidden';
  setBusy(p.isRaw ? '解碼 RAW 中…' : '載入中…');
  try {
    let c = decodeCache.get(id);
    if (!c) {
      const src = p.isRaw ? await decodeRaw(p.path, true) : await decodeImage(p.path);
      let jb = null; try { jb = await (await fetch(origPreviewURL(p))).blob(); } catch {}
      const look = await cameraLook(src, jb);
      c = { src, look }; decodeCache.set(id, c);
      while (decodeCache.size > 3) decodeCache.delete(decodeCache.keys().next().value);
    }
    if (token !== E.decodeToken) return;
    E.src = c.src;
    engine.setSource(c.src); engine.setBase(c.look.lut, c.look.sat);
    if ((E.edits.heal || []).length) { engine.prepare(E.edits); setBusy('套用物件移除…'); await sleep(20); refreshHeal(); }
    if (E.edits.deblur) { engine.prepare(E.edits); scheduleDeblur(); }
    ph.classList.add('hidden'); $('#cv').style.visibility = 'visible';
    layoutCanvas(); draw();
    setBusy(null);
    loadMasks(token);
    prefetchNext();
  } catch (err) {
    console.error(err); setBusy(null);
    toast('無法解碼這個檔案：' + err.message, 6000);
  }
}
async function loadMasks(token) {
  E.maskState = 'loading'; renderMaskStatus();
  try {
    await initAI();
    const s = Math.min(1, 1536 / Math.max(engine.srcW, engine.srcH));
    const w = Math.round(engine.srcW * s), h = Math.round(engine.srcH * s);
    const base = { ...DEFAULT_EDITS(), temp: E.edits.temp, tint: E.edits.tint, exposure: E.edits.exposure, sharpen: 0, colorNoise: 0 };
    const savePins = engine.pins; engine.setPins([]); engine.setMasks(null);
    const img = engine.renderPixels(base, w, h);
    const m = await buildMasks(img);
    if (token !== E.decodeToken) return;
    E.masks = m; engine.setMasks(m); engine.setPins(pinsFor(m.pins, E.edits));
    if (E.edits.enhance && !E.edits.enhanceVec) { E.edits.enhanceVec = enhanceVector(engine, E.edits, m); persistEdits(); }
    E.maskState = 'ready'; if (E.tab === 'creative') renderTools();
  } catch (err) { console.warn('masks', err); E.maskState = 'error'; }
  renderMaskStatus(); draw();
}
function prefetchNext() {
  const list = filtered(); const i = list.findIndex(p => p.id === E.photo?.id); const n = list[i + 1];
  if (!n || decodeCache.has(n.id) || !n.isRaw) return;
  setTimeout(async () => { if (decodeCache.has(n.id)) return; try { const src = await decodeRaw(n.path, true); let jb = null; try { jb = await (await fetch(origPreviewURL(n))).blob(); } catch {} const look = await cameraLook(src, jb); decodeCache.set(n.id, { src, look }); while (decodeCache.size > 3) decodeCache.delete(decodeCache.keys().next().value); } catch {} }, 600);
}
function setBusy(t) { const b = $('#busy'); if (!t) { b.classList.add('hidden'); return; } b.classList.remove('hidden'); b.querySelector('span').textContent = t; }

function layoutCanvas() {
  const v = $('#viewer'), cv = $('#cv');
  if (!engine?.srcTex) return;
  const vw = v.clientWidth - 24, vh = v.clientHeight - 24;
  const c = E.crop ? fullFrame(E.edits.crop.angle) : E.healMode ? { cx: .5, cy: .5, w: 1, h: 1, angle: 0 } : E.edits.crop;
  const cw = c.w * engine.srcW, ch = c.h * engine.srcH;
  const dpr = window.devicePixelRatio || 1;
  if (E.zoom === 'fit' || E.crop || E.healMode) {
    const s = Math.min(vw / cw, vh / ch);
    cv.style.width = Math.round(cw * s) + 'px'; cv.style.height = Math.round(ch * s) + 'px';
    cv.width = Math.min(Math.round(cw * s * dpr), Math.round(cw)); cv.height = Math.min(Math.round(ch * s * dpr), Math.round(ch));
    E.view = [0.5, 0.5, 1, 1];
  } else {
    cv.style.width = vw + 'px'; cv.style.height = vh + 'px'; cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    const zw = Math.min(1, cv.width / cw), zh = Math.min(1, cv.height / ch);
    E.pan[0] = Math.max(zw / 2, Math.min(1 - zw / 2, E.pan[0])); E.pan[1] = Math.max(zh / 2, Math.min(1 - zh / 2, E.pan[1]));
    E.view = [E.pan[0], E.pan[1], cv.width / cw, cv.height / ch];
  }
  cv.classList.toggle('zoomed', E.zoom !== 'fit');
  positionSplit(); positionCrop();
}
let rafId = 0;
function draw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0; if (!engine?.srcTex) return;
    const e = E.hover ? E.hover : E.edits;
    const ed = E.crop ? { ...e, crop: fullFrame(e.crop.angle) } : E.healMode ? { ...e, crop: { cx: .5, cy: .5, w: 1, h: 1, angle: 0 } } : e;
    engine.render(ed, { view: E.view, split: E.split, showLayer: E.showMask && E.tab === 'local' && !E.hover ? (E.layerSel ?? -1) : -1 });
    histSoon();
  });
}
let histT = 0;
function histSoon() { clearTimeout(histT); histT = setTimeout(editHistogram, 220); }
function editHistogram() {
  const cv = $('#editHist'); if (!cv || !engine) return;
  const gl = engine.gl; const w = engine.canvas.width, h = engine.canvas.height;
  const px = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const r = new Array(64).fill(0), g = new Array(64).fill(0), b = new Array(64).fill(0);
  for (let i = 0; i < px.length; i += 16) { r[px[i] >> 2]++; g[px[i + 1] >> 2]++; b[px[i + 2] >> 2]++; }
  drawHist(cv, { r, g, b });
}

// ── 修改參數 ──
let saveT = 0, histPushT = 0;
function setEdit(patch, opts = {}) {
  if (!opts.noUndo) { clearTimeout(histPushT); if (!E.pendingUndo) { E.pendingUndo = clone(E.edits); } histPushT = setTimeout(() => { E.undo.push(E.pendingUndo); E.pendingUndo = null; E.redo = []; if (E.undo.length > 100) E.undo.shift(); renderHistory(opts.label); }, 350); }
  Object.assign(E.edits, patch);
  if ('slim' in patch || 'eyeEnlarge' in patch || 'waist' in patch || 'bodySlim' in patch) engine.setPins(pinsFor(E.masks?.pins, E.edits));
  if ('crop' in patch) layoutCanvas();
  if ('deblur' in patch && !opts.noDeblur) scheduleDeblur();
  draw();
  clearTimeout(saveT); saveT = setTimeout(persistEdits, 500);
}
const historyLog = [];
function renderHistory(label) { if (label) historyLog.push(label); const el = $('#histList'); if (!el) return; el.innerHTML = E.undo.length ? historyLog.slice(-12).map((t, i, a) => `<div class="item ${i === a.length - 1 ? 'on' : ''}">${esc(t)}</div>`).join('') : '<div class="hint">還沒有修改</div>'; }
async function persistEdits() {
  const p = E.photo; if (!p) return;
  const val = isDefault(E.edits) ? null : clone(E.edits);
  p.edits = val; p.dirtyThumb = true;
  await api.updatePhotos(S.cur.id, [p.id], { edits: val });
  renderFilmItem(p.id);
}
function undo() { if (E.pendingUndo) { E.undo.push(E.pendingUndo); E.pendingUndo = null; } const s = E.undo.pop(); if (!s) return; E.redo.push(clone(E.edits)); E.edits = s; engine.setPins(pinsFor(E.masks?.pins, E.edits)); layoutCanvas(); draw(); renderTools(); persistEdits(); historyLog.push('復原'); renderHistory(); }
function redoFn() { const s = E.redo.pop(); if (!s) return; E.undo.push(clone(E.edits)); E.edits = s; engine.setPins(pinsFor(E.masks?.pins, E.edits)); layoutCanvas(); draw(); renderTools(); persistEdits(); }

// 離開照片時，以目前修圖產生新縮圖
async function commitEditThumb(p) {
  if (!p || !p.dirtyThumb || !engine?.srcTex || E.photo?.id !== p.id) return;
  p.dirtyThumb = false;
  try { await writeEditedThumbs(p, engine, E.edits); } catch (err) { console.warn(err); }
}
async function writeEditedThumbs(p, eng, edits) {
  if (!edits || isDefault(edits)) {
    p.edVer = 0; await api.updatePhotos(S.cur.id, [p.id], { edVer: 0 }); updateTile(p.id); renderFilmItem(p.id); return;
  }
  const c = edits.crop; const cw = c.w * eng.srcW, ch = c.h * eng.srcH;
  const s = Math.min(1, 2048 / Math.max(cw, ch)); const w = Math.round(cw * s), h = Math.round(ch * s);
  const img = eng.renderPixels(edits, w, h);
  const oc = new OffscreenCanvas(w, h); oc.getContext('2d').putImageData(img, 0, 0);
  const pv = await (await oc.convertToBlob({ type: 'image/jpeg', quality: 0.88 })).arrayBuffer();
  const ts = Math.min(1, 420 / Math.max(w, h)); const tc = new OffscreenCanvas(Math.round(w * ts), Math.round(h * ts)); const tx = tc.getContext('2d'); tx.imageSmoothingQuality = 'high'; tx.drawImage(oc, 0, 0, tc.width, tc.height);
  const th = await (await tc.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer();
  await writeCache(p.id + '_e.jpg', pv); await writeCache(p.id + '_e_t.jpg', th);
  p.edVer = (p.edVer || 0) + 1;
  await api.updatePhotos(S.cur.id, [p.id], { edVer: p.edVer });
  updateTile(p.id); renderFilmItem(p.id);
}
async function writeCache(name, data) { await api.writeCache(S.cur.id, name, data); }
function leaveEdit() { commitEditThumb(E.photo); }

// ── 編輯畫面版面 ──
function renderEditSide() {
  const _st = $('#editSide').scrollTop; requestAnimationFrame(() => { $('#editSide').scrollTop = _st; });
  const all = [...BUILTIN_PRESETS, ...S.presets];
  const fm = E.edits?.film;
  const filmHTML = FILMS.map(f => f.brand ? '<h4 style="margin-top:14px">柯達底片模擬</h4>' : f.cat ? `<div class="hint" style="margin:10px 0 4px;color:#9a8">${f.cat}</div>` : `<div class="preset ${fm?.id === f.id ? 'on' : ''}" data-film="${f.id}"><div class="sw" style="background:${f.sw}"></div><span>${esc(f.name)}</span></div>`).join('');
  $('#editSide').innerHTML = `
  <h4>富士底片模擬</h4>
  <div class="filmBar">${fm ? `<div class="hint" style="color:#f3b07a;margin-bottom:2px">目前：${esc(FILMS.find(f => f.id === fm.id)?.name || '')}</div><div class="sl"><label>底片強度</label><input type="range" id="filmAmt" min="0" max="150" value="${fm.amt}"><em id="filmAmtV">${fm.amt}</em></div><div class="item add" id="filmOff">✕ 取消底片色調</div>` : '<div class="hint">只改變色彩風格，不影響曝光、白平衡與人像修飾</div>'}</div>
  ${filmHTML}
  <h4>預設集</h4>
  ${all.map(p => `<div class="preset" data-preset="${p.id}"><div class="sw" style="background:${p.sw || 'linear-gradient(135deg,#777,#333)'}"></div><span>${esc(p.name)}</span>${p.user ? `<span class="del" data-delpreset="${p.id}">刪除</span>` : ''}</div>`).join('')}
  <div class="item add" id="savePreset">＋ 從目前設定建立預設</div>
  <div class="hint">滑鼠移到預設上可以先預覽效果</div>
  <h4>編輯紀錄</h4><div id="histList"></div>`;
  renderHistory();
}
function renderEditBar() {
  const p = E.photo; const list = filtered(); const i = list.findIndex(x => x.id === p.id);
  const n = S.sel.size > 1 ? S.sel.size - (S.sel.has(p.id) ? 1 : 0) : 0;
  $('#editBar').innerHTML = `<span class="ttl">${esc(p.name)}</span><span>${i + 1} / ${list.length}</span><div class="spacer"></div>
  <span class="lnk ${E.split != null ? 'on' : ''}" id="tBefore" title="快捷鍵 \\">◧ 修圖前後對比</span>
  <span class="lnk" id="tZoom" title="點畫面也可以切換">${E.zoom === 'fit' ? '符合視窗' : '100%'}</span>
  <span class="lnk" id="tUndo" title="Ctrl+Z">↶</span><span class="lnk" id="tRedo" title="Ctrl+Y">↷</span>
  <div class="btn sm" id="tCopy">複製設定</div><div class="btn sm" id="tPaste">貼上設定</div>
  <div class="btn sm p ${n ? '' : 'dis'}" id="tSync" title="在底片列 Ctrl / Shift 點選多張">同步到所選 ${n} 張</div>`;
}
function renderFilm() {
  if (S.view !== 'edit') return;
  const list = filtered();
  $('#film').innerHTML = list.map(p => filmItemHTML(p)).join('');
  const cur = document.querySelector('.film .f.cur'); cur && cur.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function filmItemHTML(p) { return `<div class="f ${E.photo?.id === p.id ? 'cur' : ''} ${S.sel.has(p.id) && S.sel.size > 1 ? 'sel' : ''}" data-fid="${p.id}"><img src="${thumbURL(p)}" loading="lazy" draggable="false">${p.edits ? '<span class="sy">✎</span>' : ''}</div>`; }
function renderFilmItem(id) { const el = document.querySelector(`.film .f[data-fid="${id}"]`); const p = photoById(id); if (el && p) { const t = document.createElement('div'); t.innerHTML = filmItemHTML(p); el.replaceWith(t.firstElementChild); } }

const SL = (key, label, min, max, step = 1, fmt) => ({ key, label, min, max, step, fmt });
const GROUPS = {
  basic: [
    { title: '智慧增強', ai: true, extra: '<span class="x" data-act="optimizeOne">✦ AI 最佳化這張</span>', items: [SL('enhance', '智慧增強', 0, 100)], note: '一個滑桿同時調整曝光、亮暗部、色彩、細節與天空（依照片內容分析）。「AI 最佳化這張」會自動判斷場景與主體，找出分數最高的調整。' },
    { title: '白平衡', extra: '<span class="x" data-act="autowb">自動</span>', items: [SL('temp', '色溫', -100, 100), SL('tint', '色調', -100, 100)] },
    { title: '光線', extra: '<span class="x" data-act="auto">✦ 自動調整</span>', items: [SL('exposure', '曝光', -5, 5, 0.05, v => (v > 0 ? '+' : '') + v.toFixed(2)), SL('contrast', '對比', -100, 100), SL('highlights', '亮部', -100, 100), SL('shadows', '暗部', -100, 100), SL('whites', '白色', -100, 100), SL('blacks', '黑色', -100, 100)] },
    { title: '底片模擬', filmUI: true },
    { title: '色彩', items: [SL('vibrance', '自然飽和', -100, 100), SL('saturation', '飽和度', -100, 100)] },
    { title: 'HSL / 顏色', hsl: true },
    { title: '色調曲線', curve: true },
    { title: '鏡頭校正', items: [SL('lensDist', '變形校正（桶狀↔枕狀）', -100, 100), SL('lensCA', '紫邊 / 色差校正', -100, 100)] },
    { title: '細節', items: [SL('sharpen', '銳利化', 0, 150), SL('texture', '紋理', -100, 100), SL('denoise', '降噪', 0, 100), SL('colorNoise', '色彩雜訊', 0, 100), SL('dust', '去除灰塵', 0, 100)] }
  ],
  ai: [
    { title: '皮膚', ai: true, extra: '<span class="x" data-act="beauty">✦ 一鍵美化</span>', items: [SL('smooth', '膚質平滑', 0, 100), SL('blemish', '去瑕疵', 0, 100), SL('skinEven', '膚色均勻', 0, 100), SL('matte', '去油光', 0, 100)] },
    { title: '膚色', ai: true, items: [SL('skinHue', '色調', -100, 100), SL('skinSat', '飽和度', -100, 100), SL('skinLum', '亮度', -100, 100)] },
    { title: '臉部', ai: true, items: [SL('faceLight', '臉部補光', -100, 100), SL('contour', '立體光影', 0, 100), SL('darkCircle', '去黑眼圈', 0, 100), SL('eyeBright', '眼睛提亮', 0, 100), SL('teeth', '牙齒美白', 0, 100), SL('lips', '唇色', -100, 100), SL('brows', '眉毛加深', 0, 100), SL('blush', '腮紅', 0, 100)] },
    { title: '頭髮', ai: true, hair: true, items: [SL('hairAmt', '換髮色強度', 0, 100), SL('hairLum', '頭髮亮度', -100, 100)] },
    { title: '臉型與身形', ai: true, items: [SL('slim', '瘦臉', -100, 100), SL('eyeEnlarge', '放大眼睛', -100, 100), SL('waist', '腰身', -100, 100), SL('bodySlim', '整體瘦身', -100, 100)], body: true },
    { title: '主體與背景', ai: true, items: [SL('subjectLight', '主體補光', -100, 100), SL('bgLight', '背景亮度', -100, 100), SL('bgSat', '背景飽和', -100, 100), SL('bgClean', '背景淨化', 0, 100), SL('bgBlur', '背景模糊', 0, 100)] },
    { title: '去背 / 換背景', ai: true, bgRep: true }
  ],
  creative: [
    { title: '天空', ai: true, items: [SL('sky', '天空加強', -100, 100), SL('twilight', '黃昏加強', 0, 100)], skyRep: true },
    { title: '光源', ai: true, items: [SL('glow', '光暈', 0, 100), SL('star', '星芒', 0, 100)], note: '讓燈泡、蠟燭、路燈等亮點發出光暈與星芒' },
    { title: '水面', ai: true, items: [SL('water', '水面清透', -100, 100), SL('waterColor', '水色（藍↔青綠）', -100, 100)], water: true },
    { title: '大氣（3D 霧氣）', ai: true, items: [SL('atmo', '霧氣濃度', 0, 100), SL('atmoNear', '起始距離', 0, 100), SL('atmoTone', '霧氣色溫（冷↔暖）', 0, 100)], note: '用 AI 深度圖判斷遠近，遠處霧氣較濃，有自然的雲霧紋理' },
    { title: '陽光光束', ai: true, extra: '<span class="x" data-act="sunPick">☀ 點選太陽位置</span>', items: [SL('rays', '光束強度', 0, 100), SL('raysLen', '光束長度', 0, 100), SL('raysWarm', '光線暖度', 0, 100)], note: '光線從太陽位置穿過樹葉、建築縫隙形成光束' },
    { title: '立體光影與超級對比', ai: true, items: [SL('ldepth', '立體光影（近亮遠暗）', -100, 100), SL('scHi', '亮部對比', -100, 100), SL('scMid', '中間調對比', -100, 100), SL('scLo', '暗部對比', -100, 100)] },
    { title: 'LUT 色彩風格', lutUI: true, items: [SL('lutAmt', 'LUT 強度', 0, 100)] },
    { title: '黑柔濾鏡', mist: true, items: [SL('mist', '強度', 0, 100), SL('mistSize', '光暈範圍', 0, 100), SL('mistSoft', '柔化', 0, 100)] },
    { title: '氛圍', items: [SL('structure', '結構 AI', -100, 100), SL('fog', '霧氣', 0, 100), SL('clarity', '清晰度', -100, 100), SL('dehaze', '去朦朧', -100, 100), SL('vignette', '暗角', -100, 100), SL('grain', '顆粒', 0, 100)] },
    { title: '色彩比對', ai: true, cm: true },
    { title: '黑白', bw: true }
  ],
  local: [{ localUI: true }, { refocusUI: true }, { healUI: true }],
  crop: [{ cropUI: true }]
};
const HAIR_COLORS = [['brown', '棕', '#7a4a2a'], ['chestnut', '栗', '#5a2e1a'], ['blonde', '金', '#d8b878'], ['ash', '霧灰', '#8c8478'], ['wine', '酒紅', '#7a1f35'], ['pink', '粉', '#d8899e'], ['black', '黑', '#1a1716'], ['gray', '銀灰', '#a8a8ad']];
const BG_TYPES = [['white', '白', '#fff'], ['black', '黑', '#0c0c0e'], ['gray', '灰漸層', '#8d9096'], ['studio', '棚拍藍灰', '#4a5260'], ['warm', '暖米色', '#e8d4bc'], ['blue', '天藍漸層', '#6f9fd6']];
const LOCAL_MASKS = [['person', '人物'], ['bg', '背景'], ['sky', '天空'], ['skin', '皮膚'], ['hair', '頭髮'], ['face', '臉部'], ['water', '水面'], ['plants', '植物']];
const SKY_TYPES = [['blue', '藍天白雲'], ['clear', '晴朗無雲'], ['golden', '金黃時刻'], ['sunset', '夕陽'], ['dusk', '粉紫黃昏'], ['cloudy', '多雲'], ['storm', '暴風雨'], ['night', '星空夜晚'], ['custom', '📁 自訂照片…']];
const HSL_COLORS = [['紅', '#e05050'], ['橙', '#e98a3c'], ['黃', '#e0c040'], ['綠', '#5cb85c'], ['青', '#3fc1c9'], ['藍', '#4a7fe0'], ['紫', '#8a5ce0'], ['洋紅', '#d04fb0']];

// 每個區塊對應的設定值，用來「單項重設」
function groupKeys(g) {
  if (g.refocusUI) return ['deblur', 'defocus', 'defocusR', 'focus', 'focusAmt', 'focusRange'];
  if (g.healUI) return ['heal'];
  if (g.localUI) return ['local'];
  if (g.cropUI) return ['crop'];
  if (g.filmUI) return [...FILM_LOOK_KEYS, 'film'];
  return (g.items || []).map(i => i.key).concat(g.hsl ? ['hslH', 'hslS', 'hslL'] : [], g.curve ? ['curve'] : [], g.bw ? ['bw', 'bwFilter', 'bwToneH', 'bwToneS'] : [],
    g.skyRep ? ['skyRep', 'skyType', 'skyImg', 'skyX', 'skyHorizon', 'skyBlend', 'skyBlur', 'skyExp', 'skyTemp', 'skyRelight', 'skyHaze', 'skyDetail', 'skyReflect'] : [], g.cm ? ['cm', 'cmAmt'] : [], g.hair ? ['hairColor'] : [], g.bgRep ? ['bgRep', 'bgType', 'bgColor'] : [], g.mist ? ['mistWarm'] : [], g.lutUI ? ['lutPath'] : [], g.items?.some(i => i.key === 'rays') ? ['sun'] : []);
}
const sameVal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function resetKeys(keys, label) {
  const d = DEFAULT_EDITS(); const patch = {}; keys.forEach(k => patch[k] = clone(d[k]));
  if (keys.includes('crop') && typeof resetCropState === 'function') resetCropState();
  setEdit(patch, { label }); if (engine && E.masks) engine.setPins(pinsFor(E.masks?.pins, E.edits));
  if (keys.includes('heal') && typeof refreshHeal === 'function') refreshHeal();
  if (keys.includes('deblur') && typeof scheduleDeblur === 'function') scheduleDeblur();
  renderTools();
}
function resetGroup(g) {
  const name = g.title || (g.refocusUI ? '重新對焦' : g.healUI ? '移除物件' : g.localUI ? '局部調整' : g.cropUI ? '裁切' : '');
  resetKeys(groupKeys(g), '重設「' + name + '」');
}
function groupChanged(g) { const d = DEFAULT_EDITS(); return groupKeys(g).some(k => !sameVal(E.edits[k], d[k])); }
function resetBtn(gi) { return `<span class="rst" data-rstg="${gi}" title="把這一項回復成原始設定">↺ 重設</span>`; }
function sliderHTML(s) {
  const v = E.edits[s.key]; const changed = v !== DEFAULT_EDITS()[s.key];
  const txt = s.fmt ? s.fmt(v) : (v > 0 && s.min < 0 ? '+' : '') + Math.round(v);
  return `<div class="sl"><label title="雙擊可重設">${s.label}</label><input type="range" class="${changed ? 'ch' : ''}" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}"><em data-v="${s.key}" title="雙擊可重設">${txt}</em><span class="rsk ${changed ? '' : 'off'}" data-rstk="${s.key}" title="重設這個滑桿">↺</span></div>`;
}
function renderTools() {
  if (!E.photo) return;
  const tabs = [['basic', '基本'], ['ai', '人像 AI'], ['creative', '創意'], ['local', '局部'], ['crop', '裁切']];
  let html = `<div class="ttabs">${tabs.map(([k, l]) => `<div class="ttab ${E.tab === k ? 'on' : ''}" data-tab="${k}">${l}</div>`).join('')}</div>`;
  if (E.tab === 'basic') html += `<div class="sec"><div class="hist" style="height:80px"><canvas id="editHist" width="560" height="160"></canvas></div></div>`;
  if (E.tab === 'ai') html += `<div class="sec" id="maskStatus"></div>`;
  const withRst = (h, gi, g) => groupChanged(g) ? h.replace(/(<div class="sec"><div class="t">[\s\S]*?)(<\/div>)/, `$1${resetBtn(gi)}$2`) : h;
  for (const [gi, g] of GROUPS[E.tab].entries()) {
    if (g.cropUI) { html += withRst(cropToolsHTML(), gi, g); continue; }
    if (g.refocusUI) { html += withRst(refocusHTML(), gi, g); continue; }
    if (g.healUI) { html += withRst(healToolsHTML(), gi, g); continue; }
    if (g.localUI) { html += withRst(localToolsHTML(), gi, g); continue; }
    html += `<div class="sec"><div class="t"><span>${g.title}${g.ai ? ' <span class="ai">AI</span>' : ''}</span><span class="tx">${g.extra || ''}${groupChanged(g) ? resetBtn(gi) : ''}</span></div>`;
    if (g.items) html += g.items.map(sliderHTML).join('');
    if (g.note) html += `<div class="hint">${g.note}</div>`;
    if (g.mist) html += `<div class="chips" style="margin-top:6px">${[['1/8', 30], ['1/4', 55], ['1/2', 85], ['1', 100]].map(([l, v]) => `<span class="chip ${E.edits.mist === v ? 'on' : ''}" data-mist="${v}">${l}</span>`).join('')}<span class="chip ${E.edits.mistWarm !== false ? 'on' : ''}" data-act="mistWarm">${E.edits.mistWarm !== false ? '✓ ' : ''}暖色光暈</span></div><div class="hint">模擬 Black Pro-Mist 濾鏡：亮部柔柔散開、暗部維持深黑，人像與夜景特別有電影感</div>`;
    if (g.hair) html += `<div class="chips" style="margin:6px 0">${HAIR_COLORS.map(([k, l, c]) => `<span class="chip ${E.edits.hairColor === k ? 'on' : ''}" data-hair="${k}"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:4px"></span>${l}</span>`).join('')}</div><div class="hint">${E.masks ? (E.masks.hasHair ? 'AI 已找到頭髮範圍' : '沒有偵測到頭髮') : 'AI 分析中…'}</div>`;
    if (g.body) html += `<div class="hint">${E.masks ? (E.masks.hasBody ? '已偵測到身形輪廓（含衣服、側身）' : '沒有偵測到身體，腰身與瘦身不會作用') : 'AI 分析中…'}</div>`;
    if (g.water) html += `<div class="hint">${E.masks ? (E.masks.hasWater ? 'AI 已找到水面範圍' : '沒有偵測到水面') : 'AI 分析中…'}</div>`;
    if (g.bgRep) html += `<div class="chips" style="margin-bottom:6px">${BG_TYPES.map(([k, l, c]) => `<span class="chip ${E.edits.bgType === k ? 'on' : ''}" data-bgtype="${k}"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c};margin-right:4px;border:1px solid #555"></span>${l}</span>`).join('')}<label class="chip">自訂 <input type="color" id="bgColor" value="${E.edits.bgColor}" style="width:22px;height:14px;border:0;background:none;vertical-align:middle"></label></div>${sliderHTML(SL('bgRep', '換背景強度', 0, 100))}<div class="hint">匯出時選「PNG（透明背景）」可直接輸出去背圖。</div>`;
    if (g.skyRep) html += `<div class="t" style="margin-top:10px"><span>天空替換</span></div><div class="chips" style="margin-bottom:6px">${SKY_TYPES.map(([k, l]) => `<span class="chip ${E.edits.skyType === k ? 'on' : ''}" data-skytype="${k}">${l}</span>`).join('')}</div>${E.edits.skyType === 'custom' && E.edits.skyImg ? `<div class="hint" style="margin-bottom:4px">自訂天空：${esc(decodeURIComponent(E.edits.skyImg.split('/').pop()))}</div>` : ''}${[SL('skyRep', '替換強度', 0, 100), SL('skyDetail', '邊緣細節', 0, 100), SL('skyHorizon', '地平線位置', -100, 100), SL('skyBlend', '地平線融合', 0, 100), SL('skyX', '天空左右位置', -100, 100), SL('skyExp', '天空亮度', -100, 100), SL('skyTemp', '天空色溫', -100, 100), SL('skyBlur', '天空景深', 0, 100), SL('skyRelight', '場景配色', 0, 100), SL('skyHaze', '大氣霧化', 0, 100), SL('skyReflect', '水面倒影', 0, 100)].map(sliderHTML).join('')}<div class="hint">${E.masks ? (E.masks.hasSky ? 'AI 已找到天空範圍；樹枝、電線、建築邊緣會逐像素分離，「邊緣細節」越高保留越多細枝' : '這張照片沒有偵測到天空') : 'AI 分析中…'}</div>`;
    if (g.cm) html += `<div class="hint" style="margin-bottom:6px">選一張已修好的照片當參考，讓這張的色調、亮度跟它一致（適合整場婚禮統一色調）。</div><div class="chips" style="margin-bottom:6px"><span class="chip" data-act="cmPick">${E.edits.cm ? '✓ 已比對 · 重新選擇參考照片' : '選擇參考照片…'}</span>${E.edits.cm ? '<span class="chip" data-act="cmClear">清除</span>' : ''}</div>${E.edits.cm ? sliderHTML(SL('cmAmt', '比對強度', 0, 100)) : ''}`;
    if (g.hsl) {
      const k = E.hslTab;
      html += `<div class="hsltabs">${[['hslH', '色相'], ['hslS', '飽和度'], ['hslL', '明度']].map(([kk, l]) => `<span class="${k === kk ? 'on' : ''}" data-hsl="${kk}">${l}</span>`).join('')}</div>`;
      html += HSL_COLORS.map(([n, c], i) => { const v = E.edits[k][i]; return `<div class="sl"><label><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:6px"></span>${n}</label><input type="range" class="${v ? 'ch' : ''}" data-hk="${k}" data-i="${i}" min="-100" max="100" value="${v}"><em>${v > 0 ? '+' : ''}${v}</em></div>`; }).join('');
    }
    if (g.curve) html += `<canvas id="curve" width="560" height="400"></canvas><div class="hint">拖曳調整點，雙擊新增 / 刪除點 · <span class="x" data-act="curveReset" style="cursor:pointer;color:#e0874a">重設</span></div>`;
    if (g.lutUI) html += `<div class="chips" style="margin:4px 0"><span class="chip" data-act="lutPick">📁 載入 .cube LUT…</span>${E.edits.lutPath ? `<span class="chip" data-act="lutOff">✕ 移除</span>` : ''}</div><div class="hint">${E.edits.lutPath ? '目前：' + esc(decodeURIComponent(E.edits.lutPath.split('/').pop())) : '支援 Adobe / DaVinci 的 .cube 3D LUT 檔'}</div>`;
    if (g.filmUI) { const fm = E.edits.film; html += `<div class="sl"><label>底片</label><select id="filmSel" style="flex:1"><option value="">（無）</option>${FILMS.map(f => f.brand ? '' : f.cat ? `<optgroup label="${esc(f.cat.replace(/^柯達｜/, '柯達・'))}">` : `<option value="${f.id}" ${fm?.id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>${fm ? `<div class="sl"><label>強度</label><input type="range" id="filmAmt2" min="0" max="150" value="${fm.amt}"><em id="filmAmt2V">${fm.amt}</em></div>` : ''}`; }
    if (g.bw) html += `<div class="chips"><span class="chip ${E.edits.bw ? 'on' : ''}" data-act="bw">${E.edits.bw ? '✓ 黑白已開啟' : '轉成黑白'}</span></div>`;
    html += `</div>`;
  }
  html += `<div style="display:flex;gap:6px;margin-top:6px"><div class="btn sm" data-act="resetAll">重設全部</div><div class="btn sm" data-act="resetTab">重設此分頁</div></div>`;
  $('#tools').innerHTML = html;
  if (E.tab === 'ai') renderMaskStatus();
  if ($('#curve')) drawCurve();
  if (E.tab === 'basic') histSoon();
}
function renderMaskStatus() {
  const el = $('#maskStatus'); if (!el) return;
  const m = E.masks;
  el.innerHTML = E.maskState === 'loading' ? '<div class="t"><span><span class="spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>AI 正在分析人臉與主體…</span></div>'
    : E.maskState === 'ready' ? `<div class="t"><span>偵測結果</span></div><div class="hint">人臉 ${m.faces} 人 · ${m.hasPerson ? '已分離主體與背景' : '未偵測到人物主體'}${m.faces ? '' : '<br>沒有偵測到人臉，人像修飾不會作用；背景模糊、主體補光、天空仍可使用。'}</div>`
      : E.maskState === 'error' ? '<div class="hint">AI 分析失敗，可以換一張照片再試。</div>' : '';
}
function refocusHTML() {
  const e = E.edits;
  return `<div class="sec"><div class="t"><span>重新對焦｜救回失焦 <span class="ai">AI</span></span></div>
  <div class="hint" style="margin-bottom:6px"><b>AI 去模糊</b>：用 NAFNet 神經網路還原手震、動態模糊與輕微失焦。</div>
  ${sliderHTML(SL('deblur', 'AI 去模糊', 0, 100))}
  <div class="hint" style="margin:8px 0 6px"><b>失焦還原</b>：用反卷積把散開的光點收回來，適合對焦偏掉的照片。模糊半徑請調到眼睛、睫毛最銳利、但還沒出現白邊的位置。</div>
  ${sliderHTML(SL('defocus', '還原強度', 0, 100))}${sliderHTML(SL('defocusR', '模糊半徑', 0, 100))}
  </div>
  <div class="sec"><div class="t"><span>重新對焦｜改變焦點 <span class="ai">AI</span></span></div>
  <div class="hint" style="margin-bottom:6px">用 AI 深度圖（Depth Anything V2）判斷遠近，點畫面選擇要清楚的位置，其他地方依距離自然模糊，亮點會變成光斑。</div>
  <div style="display:flex;gap:6px;margin-bottom:6px"><div class="btn sm ${E.focusMode ? 'on' : 'p'}" data-act="focusPick">${E.focusMode ? '✓ 點畫面選焦點…' : '🎯 點選對焦位置'}</div>${e.focus ? '<div class="btn sm" data-act="focusClear">取消</div>' : ''}</div>
  ${sliderHTML(SL('focusAmt', '背景模糊量', 0, 100))}${sliderHTML(SL('focusRange', '景深範圍', 0, 100))}
  <div class="hint">${E.masks ? (E.masks.hasDepth ? (e.focus ? '已設定焦點' : '尚未選擇焦點') : '深度估計失敗，無法使用') : 'AI 分析深度中…'}</div></div>`;
}
function healToolsHTML() {
  const ops = E.edits.heal || [];
  return `<div class="sec"><div class="t"><span>移除物件 / 電線 <span class="ai">AI</span></span></div>
  <div class="hint" style="margin-bottom:6px">開啟筆刷後，在畫面上塗抹想移除的東西（路人、垃圾、電線、痘痘以外的瑕疵），放開滑鼠會自動補上周圍的紋理。</div>
  <div style="display:flex;gap:6px;margin-bottom:6px"><div class="btn sm ${E.healMode ? 'on' : 'p'}" data-act="healToggle">${E.healMode ? '✓ 完成塗抹' : '🖌 筆刷移除物件'}</div><div class="btn sm" data-act="autoLines">✦ 自動偵測電線</div></div>
  <div class="sl"><label>筆刷大小</label><input type="range" id="healR" min="0.004" max="0.08" step="0.001" value="${E.healR}"><em id="healRv">${Math.round(E.healR * 1000)}</em></div>
  ${ops.length ? ops.map((o, i) => `<div class="item"><span class="nm">${o.rle ? '電線 / 細線' : '筆刷移除'} #${i + 1}</span><span class="x" data-delheal="${i}" style="cursor:pointer">刪除</span></div>`).join('') : '<div class="hint">還沒有修補</div>'}
  </div>`;
}
const LAYER_SL = [['exp', '曝光'], ['con', '對比'], ['hl', '亮部'], ['sh', '暗部'], ['sat', '飽和度'], ['temp', '色溫'], ['tint', '色調'], ['clar', '清晰度'], ['dehaze', '去朦朧'], ['sharp', '銳利 / 柔化']];
const LAYER_BASE = [['none', '純筆刷'], ['all', '整張'], ['person', '人物'], ['bg', '背景'], ['sky', '天空'], ['skin', '皮膚'], ['hair', '頭髮'], ['face', '臉部'], ['water', '水面'], ['plants', '植物']];
function layerName(l) { return l.name || ((LAYER_BASE.find(m => m[0] === l.mask) || [, '圖層'])[1] + (l.mask === 'none' ? '' : ' 範圍')); }
function localToolsHTML() {
  const L = E.edits.local || []; if (E.layerSel == null || E.layerSel >= L.length) E.layerSel = L.length - 1;
  const cur = L[E.layerSel]; const B = E.brush;
  let h = `<div class="sec"><div class="t"><span>圖層（筆刷 ＋ AI 範圍）<span class="ai">AI</span></span></div>
  <div class="hint" style="margin-bottom:6px">每個圖層有自己的範圍與調整。可以只用筆刷塗出範圍，也可以從 AI 範圍（人物、天空…）開始，再用筆刷增加或擦掉（最多 8 層）。</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap"><div class="btn sm p" data-act="layerAddBrush">＋ 筆刷圖層</div><div class="btn sm" data-act="dodge">☀ 加亮筆刷</div><div class="btn sm" data-act="burn">◐ 加深筆刷</div><select id="layerAddAI" class="btn sm" style="padding:3px 6px"><option value="">＋ AI 範圍圖層…</option>${LAYER_BASE.slice(1).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></div>
  <div class="layers">${L.map((l, i) => `<div class="layer ${i === E.layerSel ? 'on' : ''}" data-lsel="${i}"><span class="eye" data-leye="${i}" title="顯示 / 隱藏">${l.on === false ? '◌' : '●'}</span><span class="nm">${esc(layerName(l))}</span><span class="cnt">${(l.strokes || []).length ? '🖌' + l.strokes.length : ''}</span><span class="x" data-dellocal="${i}" title="刪除圖層">✕</span></div>`).reverse().join('') || '<div class="hint">還沒有圖層</div>'}</div></div>`;
  if (cur) {
    h += `<div class="sec"><div class="t"><span>${esc(layerName(cur))}</span><span class="tx"><span class="x" data-act="layerRename">改名</span></span></div>
    <div class="sl"><label>範圍</label><select id="layerBase" style="flex:1">${LAYER_BASE.map(([k, n]) => `<option value="${k}" ${cur.mask === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="chips" style="margin:6px 0"><span class="chip ${E.brushMode && !B.erase ? 'on' : ''}" data-act="brushPaint">🖌 筆刷</span><span class="chip ${E.brushMode && B.erase ? 'on' : ''}" data-act="brushErase">⌫ 橡皮擦</span><span class="chip ${cur.inv ? 'on' : ''}" data-act="layerInv">反轉範圍</span><span class="chip ${E.showMask ? 'on' : ''}" data-act="layerShow">顯示範圍</span><span class="chip" data-act="layerClear">清除筆畫</span></div>
    <div class="sl"><label>筆刷大小</label><input type="range" id="brSize" min="2" max="300" value="${Math.round(B.size * 1000)}"><em id="brSizeV">${Math.round(B.size * 1000)}</em></div>
    <div class="sl"><label>羽化</label><input type="range" id="brFeather" min="0" max="100" value="${Math.round(B.f * 100)}"><em>${Math.round(B.f * 100)}</em></div>
    <div class="sl"><label>流量</label><input type="range" id="brFlow" min="5" max="100" value="${Math.round(B.flow * 100)}"><em>${Math.round(B.flow * 100)}</em></div>
    <div class="hint">開啟筆刷後直接在照片上塗抹（可先放大畫面細修）；[ ] 鍵調整筆刷大小，按住 Alt 暫時切換橡皮擦。</div>
    <div class="sl" style="margin-top:6px"><label>圖層強度</label><input type="range" data-lk="amt" data-li="${E.layerSel}" min="0" max="100" value="${cur.amt ?? 100}"><em>${cur.amt ?? 100}</em></div>
    ${LAYER_SL.map(([k, n]) => `<div class="sl"><label>${n}</label><input type="range" class="${cur[k] ? 'ch' : ''}" data-lk="${k}" data-li="${E.layerSel}" min="-100" max="100" value="${cur[k] || 0}"><em>${cur[k] > 0 ? '+' : ''}${cur[k] || 0}</em></div>`).join('')}
    </div>`;
  }
  return h;
}
function cropToolsHTML() {
  const c = E.edits.crop;
  const asp = [['free', '自由'], ['orig', '原始比例'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:2', '3:2'], ['16:9', '16:9'], ['9:16', '9:16']];
  return `<div class="sec"><div class="t"><span>裁切與拉直</span></div>
  <div class="chips" style="margin-bottom:8px">${asp.map(([k, l]) => `<span class="chip ${c.aspect === k ? 'on' : ''}" data-aspect="${k}">${l}</span>`).join('')}</div>
  <div class="sl"><label>拉直角度</label><input type="range" id="angle" min="-45" max="45" step="0.1" value="${(c.angle || 0) - 90 * quarterOf(c.angle)}"><em id="angleV">${((c.angle || 0) - 90 * quarterOf(c.angle)).toFixed(1)}°</em></div>
  <div style="display:flex;gap:6px;margin-top:8px"><div class="btn sm p" data-act="aiCrop">✦ AI 構圖</div></div>
  <div style="display:flex;gap:6px;margin-top:8px"><div class="btn sm ${E.crop ? 'on' : ''}" data-act="cropToggle">${E.crop ? '✓ 完成裁切' : '在畫面上裁切'}</div><div class="btn sm" data-act="cropRotate">旋轉 90°</div><div class="btn sm" data-act="cropReset">重設</div></div>
  <div class="hint">開啟「在畫面上裁切」後，拖曳框線調整範圍，完成後按「完成裁切」。</div></div>`;
}

// ── 曲線編輯器 ──
function drawCurve() {
  const cv = $('#curve'); if (!cv) return; const x = cv.getContext('2d'); const W = cv.width, H = cv.height;
  x.clearRect(0, 0, W, H); x.strokeStyle = '#2a2c31'; x.lineWidth = 1;
  for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(i * W / 4, 0); x.lineTo(i * W / 4, H); x.moveTo(0, i * H / 4); x.lineTo(W, i * H / 4); x.stroke(); }
  x.strokeStyle = '#3a3c42'; x.beginPath(); x.moveTo(0, H); x.lineTo(W, 0); x.stroke();
  import('./engine.js').then(({ curveLUT }) => {
    const lut = curveLUT(E.edits.curve);
    x.strokeStyle = '#eee'; x.lineWidth = 3; x.beginPath(); for (let i = 0; i < 256; i++) { const px = i / 255 * W, py = H - lut[i] * H; i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
    x.fillStyle = '#f3b07a'; for (const [a, b] of E.edits.curve) { x.beginPath(); x.arc(a * W, H - b * H, 9, 0, 7); x.fill(); }
  });
}
function bindCurve() {
  let drag = -1;
  const pos = (ev) => { const cv = $('#curve'); const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height))]; };
  document.addEventListener('pointerdown', (ev) => {
    if (ev.target.id !== 'curve') return;
    const [a, b] = pos(ev); const pts = E.edits.curve;
    drag = pts.findIndex(([x, y]) => Math.hypot(x - a, (y - b) * 0.8) < 0.05);
    if (drag < 0) { const np = [...pts, [a, b]].sort((p, q) => p[0] - q[0]); drag = np.findIndex(p => p[0] === a && p[1] === b); setEdit({ curve: np }, { label: '色調曲線' }); drawCurve(); }
    ev.target.setPointerCapture(ev.pointerId);
  });
  document.addEventListener('pointermove', (ev) => {
    if (drag < 0 || ev.target.id !== 'curve') return;
    const [a, b] = pos(ev); const pts = clone(E.edits.curve);
    const lo = drag > 0 ? pts[drag - 1][0] + 0.01 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 0.01 : 1;
    pts[drag] = [drag === 0 ? 0 : drag === pts.length - 1 ? 1 : Math.max(lo, Math.min(hi, a)), b];
    if (drag === 0) pts[0][0] = Math.min(a, pts[1][0] - 0.01); if (drag === pts.length - 1) pts[drag][0] = Math.max(a, pts[drag - 1][0] + 0.01);
    setEdit({ curve: pts }, { label: '色調曲線' }); drawCurve();
  });
  document.addEventListener('pointerup', () => { drag = -1; });
  document.addEventListener('dblclick', (ev) => {
    if (ev.target.id !== 'curve') return;
    const [a, b] = pos(ev); const pts = E.edits.curve;
    const i = pts.findIndex(([x, y]) => Math.hypot(x - a, y - b) < 0.05);
    if (i > 0 && i < pts.length - 1) { setEdit({ curve: pts.filter((_, k) => k !== i) }, { label: '色調曲線' }); drawCurve(); }
  });
}

// ── 裁切框 ──
// 裁切資料：cx,cy 為「旋轉後畫面」中的中心（相對畫面中心的偏移以來源寬高正規化），w,h 為裁切尺寸 / 來源寬高，angle 含 90° 旋轉
const quarterOf = (ang) => Math.round((ang || 0) / 90);
function frameDims(ang) { const W = engine.srcW, H = engine.srcH; return (Math.abs(quarterOf(ang)) % 2) ? [H, W] : [W, H]; }
function fullFrame(ang) { const [FW, FH] = frameDims(ang); return { cx: .5, cy: .5, w: FW / engine.srcW, h: FH / engine.srcH, angle: ang || 0 }; }
// 裁切 ↔ 畫面像素矩形
function cropToRect(c) { const W = engine.srcW, H = engine.srcH; const [FW, FH] = frameDims(c.angle); const w = c.w * W, h = c.h * H; return { x: (c.cx - .5) * W + FW / 2 - w / 2, y: (c.cy - .5) * H + FH / 2 - h / 2, w, h }; }
function rectToCrop(r, c) { const W = engine.srcW, H = engine.srcH; const [FW, FH] = frameDims(c.angle); return { ...c, cx: (r.x + r.w / 2 - FW / 2) / W + .5, cy: (r.y + r.h / 2 - FH / 2) / H + .5, w: r.w / W, h: r.h / H }; }
// 矩形四角轉回來源後都在照片內才算有效（不會裁到旋轉後的空白角落）
function rectInside(r, ang) {
  const W = engine.srcW, H = engine.srcH; const [FW, FH] = frameDims(ang); const a = (ang || 0) * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
  for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const px = x - FW / 2, py = y - FH / 2; const sx = co * px - si * py + W / 2, sy = si * px + co * py + H / 2;
    if (sx < -0.5 || sy < -0.5 || sx > W + 0.5 || sy > H + 0.5) return false;
  }
  return true;
}
function scaleRect(r, k) { const cx = r.x + r.w / 2, cy = r.y + r.h / 2; return { x: cx - r.w * k / 2, y: cy - r.h * k / 2, w: r.w * k, h: r.h * k }; }
function maxScale(r, ang, hi = 1) { if (rectInside(scaleRect(r, hi), ang)) return hi; let lo = 0; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (rectInside(scaleRect(r, m), ang)) lo = m; else hi = m; } return lo; }
// 保持比例與中心，必要時縮小並往畫面中心移，讓裁切框完全落在照片內
function constrainCrop(c) {
  const r = cropToRect(c); if (rectInside(r, c.angle)) return c;
  const [FW, FH] = frameDims(c.angle); let best = null;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const cx = (r.x + r.w / 2) * (1 - t) + FW / 2 * t, cy = (r.y + r.h / 2) * (1 - t) + FH / 2 * t;
    const rr = { x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h }; const k = maxScale(rr, c.angle);
    if (!best || k > best.k + 0.02) best = { k, rr }; if (k > 0.97) break;
  }
  return rectToCrop(scaleRect(best.rr, best.k * 0.999), c);
}
// 依比例取得照片內可裁切的最大範圍（置中）
function maxCropForAspect(ang, ratio) {
  const [FW, FH] = frameDims(ang); let w = FW, h = FH;
  if (ratio) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
  const r = { x: (FW - w) / 2, y: (FH - h) / 2, w, h }; return scaleRect(r, maxScale(r, ang) * 0.999);
}
function positionCrop() {
  const o = $('#cropOverlay');
  if (!E.crop || !engine?.srcTex) { o.classList.add('hidden'); return; }
  const cv = $('#cv'), r = cv.getBoundingClientRect(), vr = $('#viewer').getBoundingClientRect();
  const c = E.edits.crop; const [FW, FH] = frameDims(c.angle); const rc = cropToRect(c);
  o.classList.remove('hidden');
  o.style.left = (r.left - vr.left + rc.x / FW * r.width) + 'px'; o.style.top = (r.top - vr.top + rc.y / FH * r.height) + 'px';
  o.style.width = rc.w / FW * r.width + 'px'; o.style.height = rc.h / FH * r.height + 'px';
  if (!o.innerHTML) o.innerHTML = '<div class="g"></div><div class="g2"></div>' + ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'].map(k => {
    const pos = k.length === 2 ? `${k[0] === 'n' ? 'top:-7px' : 'bottom:-7px'};${k[1] === 'w' ? 'left:-7px' : 'right:-7px'};cursor:${k === 'nw' || k === 'se' ? 'nwse' : 'nesw'}-resize`
      : k === 'n' || k === 's' ? `${k === 'n' ? 'top' : 'bottom'}:-5px;left:calc(50% - 12px);width:24px;height:10px;cursor:ns-resize` : `${k === 'w' ? 'left' : 'right'}:-5px;top:calc(50% - 12px);width:10px;height:24px;cursor:ew-resize`;
    return `<i data-h="${k}" style="${pos}"></i>`; }).join('');
  o.classList.toggle('rot', !!E.rotating);
}
function aspectValue(a) { if (a === 'free') return null; if (a === 'orig') { const [FW, FH] = frameDims(E.edits?.crop?.angle); return FW / FH; } const [x, y] = a.split(':').map(Number); return x / y; }
function fitAspect(c, a) {
  const r = aspectValue(a); return { ...rectToCrop(maxCropForAspect(c.angle, r), c), aspect: a };
}
// 拉直角度改變：保持原比例，自動縮放到照片內最大範圍
function cropForAngle(c, ang) {
  const n = { ...c, angle: ang }; const old = cropToRect(c);
  const ratio = aspectValue(c.aspect) || old.w / old.h;
  const full = isFullCrop0(c);
  if (full) return { ...rectToCrop(maxCropForAspect(ang, ratio), n), angle: ang };
  return constrainCrop(n);
}
function isFullCrop0(c) { const r = cropToRect(c); const [FW, FH] = frameDims(c.angle); const ratio = r.w / r.h; const m = maxCropForAspect(c.angle, ratio); return r.w >= m.w * 0.985 && Math.abs(r.x + r.w / 2 - FW / 2) < 2 && Math.abs(r.y + r.h / 2 - FH / 2) < 2; }
function bindCrop() {
  let st = null;
  $('#cropOverlay').addEventListener('pointerdown', (ev) => {
    const r = $('#cv').getBoundingClientRect(); const [FW, FH] = frameDims(E.edits.crop.angle);
    st = { h: ev.target.dataset.h || 'move', x: ev.clientX, y: ev.clientY, c: clone(E.edits.crop), r0: cropToRect(E.edits.crop), sx: FW / r.width, sy: FH / r.height };
    ev.currentTarget.setPointerCapture(ev.pointerId); ev.preventDefault();
  });
  $('#cropOverlay').addEventListener('pointermove', (ev) => {
    if (!st) return;
    const dx = (ev.clientX - st.x) * st.sx, dy = (ev.clientY - st.y) * st.sy; const r0 = st.r0, ang = st.c.angle;
    const ratio = aspectValue(st.c.aspect);
    const make = (f) => {
      const ddx = dx * f, ddy = dy * f;
      if (st.h === 'move') return { ...r0, x: r0.x + ddx, y: r0.y + ddy };
      let x0 = r0.x, x1 = r0.x + r0.w, y0 = r0.y, y1 = r0.y + r0.h; const h = st.h;
      if (h.includes('w')) x0 = Math.min(x1 - 20, x0 + ddx); if (h.includes('e')) x1 = Math.max(x0 + 20, x1 + ddx);
      if (h.includes('n')) y0 = Math.min(y1 - 20, y0 + ddy); if (h.includes('s')) y1 = Math.max(y0 + 20, y1 + ddy);
      if (ratio) {
        if (h === 'n' || h === 's') { const w = (y1 - y0) * ratio, cx = (x0 + x1) / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
        else if (h === 'w' || h === 'e') { const hh = (x1 - x0) / ratio, cy = (y0 + y1) / 2; y0 = cy - hh / 2; y1 = cy + hh / 2; }
        else { const hh = (x1 - x0) / ratio; if (h.includes('n')) y0 = y1 - hh; else y1 = y0 + hh; }
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    // 超出照片時，找出能走到的最遠位置（邊界自動停住）
    let rr = make(1);
    if (!rectInside(rr, ang)) {
      if (st.h === 'move') { // 移動：分別嘗試 x、y 方向
        let lo = 0, hi = 1; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (rectInside(make(m), ang)) lo = m; else hi = m; } rr = make(lo);
        const tryX = { ...rr, x: r0.x + dx }, tryY = { ...rr, y: r0.y + dy }; if (rectInside(tryX, ang)) rr = tryX; else if (rectInside(tryY, ang)) rr = tryY;
      } else { let lo = 0, hi = 1; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (rectInside(make(m), ang)) lo = m; else hi = m; } rr = make(lo); }
    }
    E.edits.crop = rectToCrop(rr, st.c); positionCrop();
  });
  $('#cropOverlay').addEventListener('pointerup', () => { if (st) { const c = E.edits.crop; E.edits.crop = st.c; setEdit({ crop: c }, { label: '裁切' }); } st = null; });
}

// ── 前後對比 ──
function positionSplit() {
  const l = $('#splitLine');
  if (E.split == null || E.crop) { l.classList.add('hidden'); return; }
  const r = $('#cv').getBoundingClientRect(), vr = $('#viewer').getBoundingClientRect();
  l.classList.remove('hidden'); l.style.left = (r.left - vr.left + E.split * r.width) + 'px'; l.style.top = (r.top - vr.top) + 'px'; l.style.height = r.height + 'px'; l.style.bottom = 'auto';
}
function bindSplit() {
  let d = false;
  $('#splitLine').addEventListener('pointerdown', (ev) => { d = true; ev.currentTarget.setPointerCapture(ev.pointerId); });
  $('#splitLine').addEventListener('pointermove', (ev) => { if (!d) return; const r = $('#cv').getBoundingClientRect(); E.split = Math.max(0.02, Math.min(0.98, (ev.clientX - r.left) / r.width)); positionSplit(); draw(); });
  $('#splitLine').addEventListener('pointerup', () => d = false);
}

// ── 圖層筆刷 ──
function addLayer(mask) {
  const L = [...(E.edits.local || [])]; if (L.length >= 8) { toast('最多 8 個圖層'); renderTools(); return; }
  L.push({ mask, strokes: [], exp: 0, con: 0, hl: 0, sh: 0, sat: 0, temp: 0, tint: 0, clar: 0, dehaze: 0, sharp: 0, amt: 100 });
  E.layerSel = L.length - 1; setEdit({ local: L }, { label: '新增圖層' });
  if (mask === 'none') { E.brush.erase = false; setBrushMode(true); }
  renderTools(); draw();
}
function setBrushMode(on) {
  E.brushMode = on && (E.edits.local || []).length > 0; if (E.brushMode) { E.healMode = false; E.focusMode = false; if (E.crop) { E.crop = false; layoutCanvas(); } }
  $('#cv').classList.toggle('brushing', E.brushMode); let c = $('#brushCur'); if (!c) { c = document.createElement('div'); c.id = 'brushCur'; $('#viewer').appendChild(c); } c.classList.toggle('hidden', !E.brushMode);
}
// 畫面座標 → 來源 0..1（含裁切、旋轉、縮放）
function screenToSrc(ev) {
  const r = $('#cv').getBoundingClientRect(); const ox = (ev.clientX - r.left) / r.width, oy = (ev.clientY - r.top) / r.height;
  const c = E.edits.crop, v = E.view || [0.5, 0.5, 1, 1];
  const qx = v[0] + (ox - 0.5) * v[2], qy = v[1] + (oy - 0.5) * v[3];
  const W = engine.srcW, H = engine.srcH; const px = (c.cx - 0.5) * W + (qx - 0.5) * c.w * W, py = (c.cy - 0.5) * H + (qy - 0.5) * c.h * H;
  const a = (c.angle || 0) * Math.PI / 180; const rx = Math.cos(a) * px - Math.sin(a) * py, ry = Math.sin(a) * px + Math.cos(a) * py;
  return [(W / 2 + rx) / W, (H / 2 + ry) / H];
}
// 筆刷大小以來源長邊比例；換算成畫面像素顯示游標
function brushScreenR() { const r = $('#cv').getBoundingClientRect(); const c = E.edits.crop, v = E.view || [.5, .5, 1, 1]; const L = Math.max(engine.srcW, engine.srcH); return E.brush.size * L / (c.w * engine.srcW * v[2]) * r.width; }
function updBrushCursor(ev) {
  const c = $('#brushCur'); if (!c || !E.brushMode) return; if (ev) { const vr = $('#viewer').getBoundingClientRect(); E._bx = ev.clientX - vr.left; E._by = ev.clientY - vr.top; }
  const r = brushScreenR(); c.style.width = c.style.height = r * 2 + 'px'; c.style.left = (E._bx || 0) - r + 'px'; c.style.top = (E._by || 0) - r + 'px'; c.classList.toggle('er', E.brush.erase !== !!E.altErase);
}
let brushSt = null;
function brushDown(ev) {
  const L = E.edits.local || []; const l = L[E.layerSel]; if (!l) return;
  brushSt = { pts: [screenToSrc(ev)], r: E.brush.size, f: E.brush.f, flow: E.brush.flow, erase: E.brush.erase !== ev.altKey };
  engine.liveBrush = { layer: l, stroke: brushSt, key: 'live' + Math.random() }; $('#cv').setPointerCapture(ev.pointerId); draw();
}
function brushMove(ev) {
  updBrushCursor(ev); if (!brushSt) return; const p = screenToSrc(ev); const q = brushSt.pts[brushSt.pts.length - 1];
  const L = Math.max(engine.srcW, engine.srcH); if (Math.hypot((p[0] - q[0]) * engine.srcW, (p[1] - q[1]) * engine.srcH) < brushSt.r * L * 0.15) return;
  brushSt.pts.push(p); engine.liveBrush.key = 'live' + brushSt.pts.length; draw();
}
function brushUp() {
  if (!brushSt) return; const st = { ...brushSt, pts: brushSt.pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]) }; brushSt = null; engine.liveBrush = null;
  const L = clone(E.edits.local); const l = L[E.layerSel]; l.strokes = [...(l.strokes || []), st];
  setEdit({ local: L }, { label: st.erase ? '橡皮擦' : '筆刷' }); renderTools(); draw();
}

// ── 改變焦點：點畫面 → 轉回來源座標 ──
function pickFocus(ev) {
  const r = $('#cv').getBoundingClientRect(); const ox = (ev.clientX - r.left) / r.width, oy = (ev.clientY - r.top) / r.height;
  const c = E.edits.crop, v = E.view || [0.5, 0.5, 1, 1];
  const qx = v[0] + (ox - 0.5) * v[2], qy = v[1] + (oy - 0.5) * v[3];
  const W = engine.srcW, H = engine.srcH; let px = (c.cx - 0.5) * W + (qx - 0.5) * c.w * W, py = (c.cy - 0.5) * H + (qy - 0.5) * c.h * H;
  const a = (c.angle || 0) * Math.PI / 180; const rx = Math.cos(a) * px - Math.sin(a) * py, ry = Math.sin(a) * px + Math.cos(a) * py;
  const sx = (W / 2 + rx) / W, sy = (H / 2 + ry) / H;
  setEdit({ focus: { x: sx, y: sy }, focusAmt: E.edits.focusAmt || 60 }, { label: '改變焦點' });
  E.focusMode = false; renderTools();
}

// ── 物件移除筆刷 ──
let healStroke = null;
function healCanvas() {
  let o = $('#healOverlay'); const cv = $('#cv');
  if (!o) { o = document.createElement('canvas'); o.id = 'healOverlay'; o.style.cssText = 'position:absolute;pointer-events:none'; $('#viewer').appendChild(o); }
  const r = cv.getBoundingClientRect(), vr = $('#viewer').getBoundingClientRect();
  o.style.left = (r.left - vr.left) + 'px'; o.style.top = (r.top - vr.top) + 'px'; o.style.width = r.width + 'px'; o.style.height = r.height + 'px';
  o.width = Math.round(r.width); o.height = Math.round(r.height); return o;
}
function healPos(e) { const r = $('#cv').getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }
function healDown(e) { const o = healCanvas(); healStroke = { pts: [healPos(e)], r: E.healR }; $('#cv').setPointerCapture(e.pointerId); paintStroke(o); }
function healMove(e) { if (!healStroke) return; healStroke.pts.push(healPos(e)); paintStroke($('#healOverlay')); }
function paintStroke(o) { const x = o.getContext('2d'); x.clearRect(0, 0, o.width, o.height); x.strokeStyle = x.fillStyle = 'rgba(255,60,60,.5)'; x.lineCap = x.lineJoin = 'round'; x.lineWidth = healStroke.r * 2 * o.height; x.beginPath(); healStroke.pts.forEach(([a, b], i) => i ? x.lineTo(a * o.width, b * o.height) : x.moveTo(a * o.width, b * o.height)); if (healStroke.pts.length === 1) { x.arc(healStroke.pts[0][0] * o.width, healStroke.pts[0][1] * o.height, healStroke.r * o.height, 0, 7); x.fill(); } else x.stroke(); }
async function healUp() {
  if (!healStroke) return; const st = healStroke; healStroke = null;
  const H = [...(E.edits.heal || []), { strokes: [st] }];
  setEdit({ heal: H }, { label: '移除物件' }); setBusy('AI 補圖中…'); await sleep(30);
  refreshHeal(); setBusy(null); const o = $('#healOverlay'); o && o.getContext('2d').clearRect(0, 0, o.width, o.height); renderTools();
}
function refreshHeal() {
  const c = decodeCache.get(E.photo?.id); if (!c) return;
  const key = JSON.stringify([E.edits.heal || [], E.deblurDone || 0]); if (key === E.healKey) return; E.healKey = key;
  const t0 = performance.now();
  const base = E.deblurDone && c.deblurred ? c.deblurred : c.src;
  const src = (E.edits.heal || []).length ? applyHeals(base, E.edits.heal) : base;
  engine.updateSource(src); draw();
  console.log('heal ms', Math.round(performance.now() - t0));
}
// AI 去模糊：滑桿停下來後才計算（神經網路較慢）
let deblurT = 0, deblurRun = 0;
function scheduleDeblur() {
  clearTimeout(deblurT);
  deblurT = setTimeout(async () => {
    const c = decodeCache.get(E.photo?.id); if (!c) return;
    const amt = E.edits.deblur || 0; const run = ++deblurRun;
    if (!amt) { E.deblurDone = 0; refreshHeal(); return; }
    try {
      if (!c.deblurFull) { setBusy('AI 去模糊運算中… 0%'); c.deblurFull = await deblurAI(c.src, 1, (p) => setBusy(`AI 去模糊運算中（${mlBackend === 'webgpu' ? '顯示卡' : 'CPU'}）… ${Math.round(p * 100)}%`), () => run !== deblurRun); }
      if (run !== deblurRun) return;
      // 依強度混合
      const s0 = c.src.data, s1 = c.deblurFull.data, out = new s0.constructor(s0.length); const k = amt / 100;
      for (let i = 0; i < s0.length; i++) out[i] = s0[i] + (s1[i] - s0[i]) * k;
      c.deblurred = { ...c.src, data: out }; E.deblurDone = amt; E.healKey = ''; refreshHeal();
    } catch (err) { if (!/取消/.test(err.message)) { console.warn(err); toast('AI 去模糊失敗：' + err.message, 5000); } }
    setBusy(null);
  }, 500);
}
async function autoLines() {
  if (!E.masks) { toast('AI 還在分析，請稍候'); return; }
  if (!E.masks.hasSky) { toast('沒有偵測到天空，電線偵測只在天空範圍內作用'); return; }
  setBusy('偵測電線中…'); await sleep(20);
  const m = E.masks; const img = engine.renderPixels({ ...DEFAULT_EDITS(), sharpen: 0, colorNoise: 0 }, m.w, m.h);
  const sky = new Uint8Array(m.w * m.h); for (let i = 0; i < sky.length; i++) sky[i] = m.m2[i * 4 + 1];
  const r = detectLines(img, sky);
  if (r.count < 30) { setBusy(null); toast('沒有找到明顯的電線'); return; }
  const H = [...(E.edits.heal || []), { rle: encodeRLE(r.mask, m.w, m.h) }];
  setEdit({ heal: H }, { label: '移除電線' }); setBusy('移除電線中…'); await sleep(20); refreshHeal(); setBusy(null); renderTools();
  toast('已移除偵測到的電線，如有遺漏可用筆刷補塗');
}

// ── 自動調整 ──
function analyzeAuto(eng, ed) {
  const s = Math.min(1, 400 / Math.max(eng.srcW, eng.srcH));
  const w = Math.round(eng.srcW * s), h = Math.round(eng.srcH * s);
  const base = { ...DEFAULT_EDITS(), temp: ed.temp, tint: ed.tint, crop: ed.crop };
  const px = eng.renderPixels(base, w, h).data;
  const L = []; let clipH = 0, sat = 0;
  for (let i = 0; i < px.length; i += 4) { const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255; L.push(l); if (l > 0.97) clipH++; sat += (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2])) / 255; }
  L.sort((a, b) => a - b); const n = L.length; const med = L[n >> 1], p5 = L[Math.floor(n * 0.05)], p95 = L[Math.floor(n * 0.95)];
  const ev = Math.max(-2, Math.min(2, Math.log2(0.46 / Math.max(med, 0.02)) * 1.6));
  return {
    exposure: Math.round(ev * 20) / 20,
    highlights: clipH / n > 0.01 || p95 > 0.9 ? -Math.min(60, Math.round(20 + clipH / n * 800)) : -10,
    shadows: p5 < 0.08 ? Math.min(50, Math.round(15 + (0.08 - p5) * 400)) : 5,
    whites: p95 < 0.85 ? Math.round((0.9 - p95) * 80) : 0,
    blacks: p5 > 0.06 ? -Math.round(p5 * 120) : -5,
    contrast: 8, vibrance: sat / n < 0.25 ? 25 : 12
  };
}
function autoAdjust() { setEdit(analyzeAuto(engine, E.edits), { label: '自動調整' }); renderTools(); }
// 智慧增強的完整效果（滑桿 100 時）
function enhanceVector(eng, ed, masks) {
  const a = analyzeAuto(eng, ed);
  const v = { ...a, structure: 30, clarity: 8, vibrance: (a.vibrance || 10) + 10, dehaze: 6 };
  if (masks?.hasSky) v.sky = 35;
  if (masks?.faces) { v.structure = 15; v.faceLight = 10; }
  return v;
}
function autoWB() {
  const s = Math.min(1, 300 / Math.max(engine.srcW, engine.srcH));
  const w = Math.round(engine.srcW * s), h = Math.round(engine.srcH * s);
  const px = engine.renderPixels({ ...DEFAULT_EDITS(), sharpen: 0, crop: E.edits.crop }, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; if (l < 30 || l > 235) continue; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  if (!n) return; r /= n; g /= n; b /= n;
  const temp = Math.max(-100, Math.min(100, Math.round(Math.log(r / b) * -160)));
  const tint = Math.max(-100, Math.min(100, Math.round(Math.log(g / ((r + b) / 2)) * 200)));
  setEdit({ temp, tint }, { label: '自動白平衡' }); renderTools();
}
function beautyPatch() { return { smooth: 45, blemish: 60, skinEven: 20, matte: 30, faceLight: 15, contour: 20, darkCircle: 35, teeth: 25, eyeBright: 25, lips: 12, eyeEnlarge: 10, slim: 12, subjectLight: 10 }; }

// ── 色彩比對 ──
function ycStats(data) {
  let n = 0; const m = [0, 0, 0], q = [0, 0, 0];
  for (let i = 0; i < data.length; i += 8) { const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const y = [0.299 * r + 0.587 * g + 0.114 * b, -0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
    for (let k = 0; k < 3; k++) { m[k] += y[k]; q[k] += y[k] * y[k]; } n++; }
  return { m: m.map(v => v / n), s: q.map((v, k) => Math.sqrt(Math.max(1e-6, v / n - (m[k] / n) ** 2))) };
}
function pickColorRef(x, y) {
  const list = S.photos.filter(p => p.id !== E.photo.id && p.thumbVer).sort((a, b) => (b.edits ? 1 : 0) - (a.edits ? 1 : 0)).slice(0, 30);
  showMenu(x, y, list.map(p => [`${p.edits ? '✎ ' : ''}${p.name}`, () => colorMatch(p)]));
}
async function colorMatch(ref) {
  const blob = await (await fetch(previewURL(ref))).blob(); const bmp = await createImageBitmap(blob, { resizeWidth: 320, resizeQuality: 'medium' });
  const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
  const rs = ycStats(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
  const sc = Math.min(1, 320 / Math.max(engine.srcW, engine.srcH));
  const cur = engine.renderPixels({ ...E.edits, cm: null, cmAmt: 0 }, Math.round(engine.srcW * sc), Math.round(engine.srcH * sc));
  const cs = ycStats(cur.data);
  const sArr = [0, 1, 2].map(k => Math.max(0.6, Math.min(1.6, rs.s[k] / cs.s[k])));
  const oArr = [0, 1, 2].map(k => rs.m[k] - cs.m[k] * sArr[k]);
  setEdit({ cm: { s: sArr, o: oArr, ref: ref.name }, cmAmt: 80 }, { label: '色彩比對：' + ref.name }); renderTools();
  toast('已比對「' + ref.name + '」的色調');
}

// ── AI 構圖 ──
function aiCrop() {
  const m = E.masks; if (!m || (!m.subject && !m.faceBoxes?.length)) { toast('沒有偵測到主體，無法自動構圖'); return; }
  const W = engine.srcW, H = engine.srcH; const c = E.edits.crop;
  const ar = aspectValue(c.aspect) || (c.w * W) / (c.h * H);
  const sub = m.subject || m.faceBoxes[0];
  const face = m.faceBoxes?.length ? m.faceBoxes.reduce((a, b) => (b[2] - b[0] > a[2] - a[0] ? b : a)) : null;
  // 裁切框：盡量大（原圖 88%），保持比例
  let cw = 0.88, ch = cw * W / ar / H; if (ch > 0.88) { ch = 0.88; cw = ch * H * ar / W; }
  // 主體水平置於三分線或中央；眼睛放在上三分之一線
  const sx = (sub[0] + sub[2]) / 2;
  let cx = Math.abs(sx - 0.5) < 0.12 ? sx : (sx < 0.5 ? sx + cw / 6 : sx - cw / 6);
  let cy = face ? (face[1] + (face[3] - face[1]) * 0.45) + ch / 6 : (sub[1] + sub[3]) / 2;
  cx = Math.max(cw / 2, Math.min(1 - cw / 2, cx)); cy = Math.max(ch / 2, Math.min(1 - ch / 2, cy));
  setEdit({ crop: constrainCrop({ ...c, cx, cy, w: cw, h: ch }) }, { label: 'AI 構圖' }); renderTools();
  toast('已依主體位置自動構圖（三分法），可再手動微調');
}

// ── 預設集 ──
function filmPatch(id, amt) {
  const f = FILMS.find(x => x.id === id); const d = DEFAULT_EDITS(); const k = amt / 100; const out = {};
  for (const key of FILM_LOOK_KEYS) {
    const v = f.e[key], dv = d[key];
    if (v === undefined) out[key] = clone(dv);
    else if (typeof v === 'number' && typeof dv === 'number' && !/^grade.H$|bwToneH/.test(key)) out[key] = Math.round((dv + (v - dv) * k) * 100) / 100;
    else if (Array.isArray(v) && key !== 'curve') out[key] = v.map((x, i) => Math.round(x * k));
    else if (key === 'curve') out[key] = v.map(([a, b]) => [a, Math.min(1, Math.max(0, a + (b - a) * Math.min(k, 1.5)))]);
    else out[key] = clone(v);
  }
  if (/S$/.test('gradeSS')) { out.gradeSS = Math.round((f.e.gradeSS || 0) * k); out.gradeHS = Math.round((f.e.gradeHS || 0) * k); }
  out.film = { id, amt };
  return out;
}
function applyFilm(id, amt = 100, hover = false) {
  const p = filmPatch(id, amt);
  if (hover) { E.hover = { ...E.edits, ...p }; draw(); return; }
  setEdit(p, { label: '底片：' + FILMS.find(x => x.id === id).name }); renderTools(); renderEditSide();
}
function presetEdits(pr) { const d = DEFAULT_EDITS(); const e = { ...d, ...clone(pr.e) }; return e; }
function applyPresetToCurrent(pr) { const keep = { crop: E.edits.crop }; setEdit({ ...presetEdits(pr), ...keep }, { label: '套用預設：' + pr.name }); renderTools(); document.querySelectorAll('.preset').forEach(el => el.classList.toggle('on', el.dataset.preset === pr.id)); }
async function savePresetFromCurrent() {
  const name = await askText('建立預設', '預設名稱', '我的預設'); if (!name) return;
  const e = clone(E.edits); delete e.crop;
  const d = DEFAULT_EDITS(); for (const k of Object.keys(e)) if (JSON.stringify(e[k]) === JSON.stringify(d[k])) delete e[k];
  const hue = Math.floor(Math.random() * 360);
  S.presets.push({ id: 'u' + Date.now(), name, user: true, e, sw: `linear-gradient(135deg,hsl(${hue},45%,60%),hsl(${(hue + 40) % 360},40%,30%))` });
  await api.savePresets(S.presets); renderEditSide(); toast('已建立預設「' + name + '」');
}

// ── 批次套用（同步 / 貼上 / 預設）──
async function applyToPhotos(ids, editsOrFn, label) {
  const keepCrop = true;
  for (const id of ids) {
    const p = photoById(id); if (!p) continue;
    const base = { ...DEFAULT_EDITS(), ...(p.edits || {}) };
    let ne = typeof editsOrFn === 'function' ? editsOrFn(base) : { ...clone(editsOrFn) };
    if (keepCrop) ne.crop = base.crop;
    p.edits = isDefault(ne) ? null : ne;
    await api.updatePhotos(S.cur.id, [id], { edits: p.edits });
    if (E.photo?.id === id && S.view === 'edit') { E.edits = { ...DEFAULT_EDITS(), ...clone(p.edits || {}) }; engine.setPins(pinsFor(E.masks?.pins, E.edits)); draw(); renderTools(); }
  }
  toast(`${label}：已套用到 ${ids.length} 張`);
  queueThumbs(ids.filter(id => id !== (S.view === 'edit' ? E.photo?.id : null)));
  if (S.view === 'edit') { E.photo.dirtyThumb = true; renderFilm(); } else { ids.forEach(updateTile); renderInfo(); }
}

// 背景重新產生修圖後縮圖
const thumbQueue = []; let thumbRunning = false;
function queueThumbs(ids) { for (const id of ids) if (!thumbQueue.includes(id)) thumbQueue.push(id); S.jobs.thumbs = [0, thumbQueue.length]; runThumbs(); }
async function runThumbs() {
  if (thumbRunning) return; thumbRunning = true;
  try {
    while (thumbQueue.length) {
      const id = thumbQueue.shift(); const p = photoById(id); if (!p) continue;
      try { await renderPhotoOffscreen(p, async (eng, edits) => { await writeEditedThumbs(p, eng, edits); }, true); } catch (err) { console.warn('thumb', err); }
      S.jobs.thumbs[0]++; renderStatusThrottled();
    }
  } finally { thumbRunning = false; S.jobs.thumbs = [0, 0]; renderStatus(); }
}
// 在背景引擎完整處理一張照片
async function renderPhotoOffscreen(p, fn, half, opts) {
  const edits = { ...DEFAULT_EDITS(), ...clone(p.edits || {}) };
  if (!p.edits) { await fn(null, null); return; }
  let c = half ? decodeCache.get(p.id) : null;
  let src = c?.src, look = c?.look;
  if (!src) {
    src = p.isRaw ? await decodeRaw(p.path, half) : await decodeImage(p.path);
    let jb = null; try { jb = await (await fetch(origPreviewURL(p))).blob(); } catch {}
    look = await cameraLook(src, jb);
  }
  if (edits.deblur) src = await deblurAI(src, edits.deblur / 100, opts?.onDeblur);
  if ((edits.heal || []).length) src = applyHeals(src, edits.heal);
  const eng = bgEngine(); eng.setSource(src); eng.setBase(look.lut, look.sat);
  const needAI = needsAI(edits) || (opts && opts.alpha);
  if (needAI) {
    await initAI();
    const s = Math.min(1, 1536 / Math.max(src.width, src.height)); const w = Math.round(src.width * s), h = Math.round(src.height * s);
    const img = eng.renderPixels({ ...DEFAULT_EDITS(), temp: edits.temp, tint: edits.tint, exposure: edits.exposure, sharpen: 0, colorNoise: 0 }, w, h);
    const m = await buildMasks(img); eng.setMasks(m); eng.setPins(pinsFor(m.pins, edits));
    if (edits.enhance && !edits.enhanceVec) edits.enhanceVec = enhanceVector(eng, edits, m);
  } else if (edits.enhance && !edits.enhanceVec) edits.enhanceVec = enhanceVector(eng, edits, null);
  if (edits.lutPath && edits.lutAmt > 0 && eng.lutKey !== edits.lutPath) await eng.loadLUT(edits.lutPath);
  if (edits.skyType === 'custom' && edits.skyImg && edits.skyRep > 0 && eng.skyImgKey !== edits.skyImg) await eng.loadSkyImage(edits.skyImg);
  await fn(eng, edits);
  eng.dispose();
}

// ─────────────────────────── AI 最佳化修圖 ───────────────────────────
async function optimizeCurrent() {
  const c = decodeCache.get(E.photo?.id); if (!c || !engine?.srcTex) return;
  if (!E.masks) { toast('AI 還在分析主體，請稍候再按'); return; }
  setBusy('AI 判斷場景、主體與最佳曝光…'); await sleep(30);
  try {
    const r = optimize(c.src, c.look, E.masks, E.photo.info, { portrait: true, skinStyle: S.settings.skinStyle || 'asian' });
    const keep = { crop: E.edits.crop, heal: E.edits.heal, local: E.edits.local, deblur: E.edits.deblur, focus: E.edits.focus, focusAmt: E.edits.focusAmt };
    setEdit({ ...r.edits, ...keep }, { label: 'AI 最佳化（' + SCENE_NAMES[r.scene.scene] + '）' });
    engine.setPins(pinsFor(E.masks.pins, E.edits)); layoutCanvas(); renderTools();
    toast(`判斷為「${SCENE_NAMES[r.scene.scene]}」，已套用最佳化修圖`, 3500);
  } catch (err) { console.error(err); toast('最佳化失敗：' + err.message, 5000); }
  setBusy(null);
}
function aiOptimizeDialog(ids) {
  if (!ids.length) return;
  const m = $('#modal');
  m.innerHTML = `<div class="modal"><h3>✦ AI 最佳化修圖（${ids.length} 張）</h3>
  <div class="hint" style="margin-bottom:10px">每張照片會分別判斷場景（人像、團體、風景、夕陽、夜景、室內）、主體位置與曝光，再自動找出分數最高的白平衡、曝光、亮暗部、對比與色彩，並依場景加上合適的效果（例如人像修膚、風景天空、夜景降噪、逆光主體補光）。</div>
  <div class="row"><label>強度</label><select id="oStr"><option value="0.6">輕微</option><option value="1" selected>標準</option><option value="1.25">強烈</option></select></div>
  <div class="row"><label>膚色風格</label><select id="oSkin"><option value="asian">亞洲｜白裡透紅（不死白）</option><option value="natural">自然膚色</option><option value="tan">小麥健康膚色</option></select></div>
  <div class="row"><label>人像美顏</label><label style="width:auto"><input type="checkbox" id="oPor" checked> 有人臉時自動修膚、亮眼、去黑眼圈</label></div>
  <div class="row"><label>原有修圖</label><select id="oKeep"><option value="replace">重新最佳化（保留裁切、移除物件）</option><option value="merge">只最佳化光線與色彩，保留其他效果</option></select></div>
  <div class="acts"><div class="btn" id="oNo">取消</div><div class="btn p" id="oGo">開始</div></div></div>`;
  m.classList.remove('hidden');
  $('#oNo').onclick = () => m.classList.add('hidden');
  $('#oSkin').value = S.settings.skinStyle || 'asian';
  $('#oGo').onclick = () => { S.settings.skinStyle = $('#oSkin').value; saveSettings(); runOptimize(ids, { strength: +$('#oStr').value, portrait: $('#oPor').checked, keep: $('#oKeep').value, skinStyle: $('#oSkin').value }); };
}
const LIGHT_KEYS = ['temp', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation', 'subjectLight', 'skinHue', 'skinSat', 'skinLum'];
async function runOptimize(ids, opt) {
  const m = $('#modal'); let stop = false;
  m.innerHTML = `<div class="modal"><h3>AI 最佳化修圖中…</h3><div id="oMsg" class="hint">準備中</div><div class="prog" style="width:100%;margin:14px 0"><b id="oBar"></b></div><div id="oLog" class="hint" style="max-height:160px;overflow:auto"></div><div class="acts"><div class="btn" id="oStop">停止</div></div></div>`;
  $('#oStop').onclick = () => { stop = true; $('#oStop').textContent = '停止中…'; };
  await initAI();
  const counts = {}; let done = 0;
  for (const id of ids) {
    if (stop) break;
    const p = photoById(id); if (!p) continue;
    $('#oMsg').textContent = `${done + 1} / ${ids.length}　${p.name}`;
    try {
      let c = decodeCache.get(p.id);
      let src = c?.src, look = c?.look;
      if (!src) { src = p.isRaw ? await decodeRaw(p.path, true) : await decodeImage(p.path); let jb = null; try { jb = await (await fetch(origPreviewURL(p))).blob(); } catch {} look = await cameraLook(src, jb); }
      const old = { ...DEFAULT_EDITS(), ...clone(p.edits || {}) };
      if ((old.heal || []).length) src = applyHeals(src, old.heal);
      const eng = bgEngine(); eng.setSource(src); eng.setBase(look.lut, look.sat);
      const s = Math.min(1, 1536 / Math.max(src.width, src.height));
      const img = eng.renderPixels({ ...DEFAULT_EDITS(), sharpen: 0, colorNoise: 0 }, Math.round(src.width * s), Math.round(src.height * s));
      const masks = await buildMasks(img);
      const r = optimize(src, look, masks, p.info, opt);
      let ne;
      if (opt.keep === 'merge') { ne = { ...old }; for (const k of LIGHT_KEYS) ne[k] = r.edits[k] ?? 0; }
      else ne = { ...r.edits, crop: old.crop, heal: old.heal, deblur: old.deblur };
      p.edits = ne; p.ai = { ...(p.ai || {}), scene: r.scene.scene };
      await api.updatePhotos(S.cur.id, [p.id], { edits: ne, ai: p.ai });
      eng.setMasks(masks); eng.setPins(pinsFor(masks.pins, ne));
      await writeEditedThumbs(p, eng, ne);
      eng.dispose();
      if (E.photo?.id === p.id && S.view === 'edit') { E.edits = { ...DEFAULT_EDITS(), ...clone(ne) }; engine.setPins(pinsFor(E.masks?.pins, E.edits)); draw(); renderTools(); }
      const sn = SCENE_NAMES[r.scene.scene]; counts[sn] = (counts[sn] || 0) + 1;
      $('#oLog').insertAdjacentHTML('afterbegin', `<div>${esc(p.name)}：${sn}${r.edits.subjectLight ? '・逆光補光' : ''}${r.edits.denoise ? '・高 ISO 降噪' : ''}</div>`);
    } catch (err) { console.error(err); $('#oLog').insertAdjacentHTML('afterbegin', `<div style="color:#e66">${esc(p.name)}：失敗（${esc(err.message)}）</div>`); }
    done++; $('#oBar').style.width = Math.round(done / ids.length * 100) + '%';
  }
  m.innerHTML = `<div class="modal"><h3>${stop ? '已停止' : 'AI 最佳化完成'}</h3><div class="hint">處理 ${done} 張：${Object.entries(counts).map(([k, v]) => `${k} ${v} 張`).join('、') || '—'}</div><div class="hint" style="margin-top:6px">每張的修圖都可以再進入編輯微調；不滿意可以在照片上按右鍵選「重設修圖」。</div><div class="acts"><div class="btn p" id="oClose">完成</div></div></div>`;
  $('#oClose').onclick = () => { m.classList.add('hidden'); if (S.view === 'lib') { renderGrid(); renderInfo(); } else renderFilm(); };
}

// ─────────────────────────── 匯出 ───────────────────────────
// 自訂輸出檔名的可用欄位
const NAME_TOKENS = [['原檔名'], ['專案'], ['序號'], ['拍攝日期'], ['拍攝時間'], ['匯出日期'], ['相機'], ['評等']];
function exportName(opt, p, i) {
  const pad = (n) => String(n).padStart(2, '0'); const shot = new Date(dateOf(p)); const now = new Date();
  const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  if (opt.naming === 'seq') return `${S.cur.name}_${String(i + 1).padStart(3, '0')}`;
  if (opt.naming !== 'custom') return p.name.replace(/\.[^.]+$/, '');
  const v = { 原檔名: p.name.replace(/\.[^.]+$/, ''), 專案: S.cur?.name || '', 序號: String((opt.seqStart ?? 1) + i).padStart(opt.seqDigits || 3, '0'), 拍攝日期: ymd(shot), 拍攝時間: `${pad(shot.getHours())}${pad(shot.getMinutes())}${pad(shot.getSeconds())}`, 匯出日期: ymd(now), 相機: (p.info?.model || '').replace(/\s+/g, '-'), 評等: (p.rating || 0) + '星' };
  return (opt.tpl || '{原檔名}').replace(/\{([^}]+)\}/g, (m, k) => v[k] ?? m);
}
async function exportDialog() {
  if (!S.cur || !S.photos.length) { toast('沒有可以匯出的照片'); return; }
  if (S.view === 'edit') await persistEdits();
  const o = { scope: S.sel.size > 1 ? 'sel' : 'pick', dir: '', quality: 90, size: 'orig', long: 2048, naming: 'orig', tpl: '{原檔名}', seqStart: 1, seqDigits: 3, wm: '', wmPos: 'br', wmOpacity: 60, ...(S.settings.export || {}) };
  const nSel = S.sel.size, nPick = S.photos.filter(p => p.flag === 1).length, nFil = filtered().length;
  const html = `<div class="modal"><h3>匯出照片</h3>
  <div class="row"><label>匯出範圍</label><select id="xScope"><option value="sel" ${o.scope === 'sel' ? 'selected' : ''}>目前選取（${nSel} 張）</option><option value="pick" ${o.scope === 'pick' ? 'selected' : ''}>⚑ 已選旗標（${nPick} 張）</option><option value="filtered" ${o.scope === 'filtered' ? 'selected' : ''}>目前篩選全部（${nFil} 張）</option></select></div>
  <div class="row"><label>資料夾</label><input type="text" id="xDir" value="${esc(o.dir)}" placeholder="選擇匯出資料夾" readonly><div class="btn sm" id="xPick">選擇…</div></div>
  <div class="row"><label>尺寸</label><select id="xSize"><option value="orig" ${o.size === 'orig' ? 'selected' : ''}>原始大小（完整解析度）</option><option value="long" ${o.size === 'long' ? 'selected' : ''}>長邊指定像素</option></select><input type="number" id="xLong" value="${o.long}" style="width:80px" ${o.size === 'long' ? '' : 'disabled'}> px</div>
  <div class="row"><label>格式</label><select id="xFmt"><option value="jpg" ${o.fmt !== 'png' && o.fmt !== 'pngA' ? 'selected' : ''}>JPG</option><option value="png" ${o.fmt === 'png' ? 'selected' : ''}>PNG</option><option value="pngA" ${o.fmt === 'pngA' ? 'selected' : ''}>PNG（透明背景，AI 去背）</option></select></div>
  <div class="row"><label>JPG 品質</label><input type="range" id="xQ" min="60" max="100" value="${o.quality}" style="flex:1"><span id="xQv">${o.quality}</span></div>
  <div class="row"><label>檔名</label><select id="xName"><option value="orig" ${o.naming === 'orig' ? 'selected' : ''}>原始檔名</option><option value="seq" ${o.naming === 'seq' ? 'selected' : ''}>專案名稱_序號</option><option value="custom" ${o.naming === 'custom' ? 'selected' : ''}>自訂檔名…</option></select></div>
  <div id="xTplBox" class="${o.naming === 'custom' ? '' : 'hidden'}" style="margin:-2px 0 8px 92px">
    <input type="text" id="xTpl" value="${esc(o.tpl || '{原檔名}')}" style="width:100%" placeholder="例如：婚禮_{拍攝日期}_{序號}">
    <div class="chips" style="margin:6px 0">${NAME_TOKENS.map(([k]) => `<span class="chip" data-tok="${k}">＋${k}</span>`).join('')}</div>
    <div class="row" style="margin:0"><label style="width:auto">序號起始</label><input type="number" id="xSeqS" value="${o.seqStart ?? 1}" style="width:70px"><label style="width:auto;margin-left:10px">位數</label><select id="xSeqD">${[1, 2, 3, 4, 5].map(n => `<option ${+(o.seqDigits ?? 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="hint">範例：<b id="xTplEx"></b></div>
  </div>
  <div class="row"><label>浮水印文字</label><input type="text" id="xWm" value="${esc(o.wm)}" placeholder="留空＝不加浮水印"></div>
  <div class="row"><label>浮水印位置</label><select id="xWmPos">${[['br', '右下'], ['bl', '左下'], ['tr', '右上'], ['tl', '左上'], ['c', '中央']].map(([k, l]) => `<option value="${k}" ${o.wmPos === k ? 'selected' : ''}>${l}</option>`).join('')}</select><label style="width:auto">透明度</label><input type="range" id="xWmO" min="10" max="100" value="${o.wmOpacity}" style="width:90px"></div>
  <div class="hint">原始大小會完整解碼 RAW，每張約數秒；長邊 3000px 以下會用較快的模式。</div>
  <div class="acts"><div class="btn" id="xCancel">取消</div><div class="btn p" id="xGo">開始匯出</div></div></div>`;
  const m = $('#modal'); m.innerHTML = html; m.classList.remove('hidden');
  $('#xSize').onchange = () => { $('#xLong').disabled = $('#xSize').value !== 'long'; };
  const exP = S.photos.find(p => S.sel.has(p.id)) || S.photos[0];
  const upd = () => { $('#xTplEx').textContent = exportName({ naming: 'custom', tpl: $('#xTpl').value, seqStart: +$('#xSeqS').value, seqDigits: +$('#xSeqD').value }, exP, 0) + ($('#xFmt').value.startsWith('png') ? '.png' : '.jpg'); };
  $('#xName').onchange = () => { $('#xTplBox').classList.toggle('hidden', $('#xName').value !== 'custom'); upd(); };
  ['#xTpl', '#xSeqS', '#xSeqD', '#xFmt'].forEach(q => $(q).addEventListener('input', upd)); $('#xSeqD').onchange = upd;
  $('#xTplBox').onclick = (e) => { const t = e.target.closest('[data-tok]'); if (!t) return; const inp = $('#xTpl'); const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? a; const tok = '{' + t.dataset.tok + '}'; inp.value = inp.value.slice(0, a) + tok + inp.value.slice(b); inp.focus(); inp.setSelectionRange(a + tok.length, a + tok.length); upd(); };
  upd();
  $('#xQ').oninput = () => $('#xQv').textContent = $('#xQ').value;
  $('#xPick').onclick = async () => { const d = await api.pickExportDir(); if (d) $('#xDir').value = d; };
  $('#xCancel').onclick = () => m.classList.add('hidden');
  $('#xGo').onclick = async () => {
    const opt = { fmt: $('#xFmt').value, scope: $('#xScope').value, dir: $('#xDir').value, quality: +$('#xQ').value, size: $('#xSize').value, long: +$('#xLong').value || 2048, naming: $('#xName').value, tpl: $('#xTpl').value, seqStart: +$('#xSeqS').value || 1, seqDigits: +$('#xSeqD').value || 3, wm: $('#xWm').value, wmPos: $('#xWmPos').value, wmOpacity: +$('#xWmO').value };
    if (!opt.dir) { const d = await api.pickExportDir(); if (!d) return; opt.dir = d; }
    S.settings.export = opt; saveSettings();
    const ids = opt.scope === 'sel' ? [...S.sel] : opt.scope === 'pick' ? S.photos.filter(p => p.flag === 1).map(p => p.id) : filtered().map(p => p.id);
    if (!ids.length) { toast('這個範圍沒有照片'); return; }
    runExport(ids, opt);
  };
}
async function runExport(ids, opt) {
  const m = $('#modal'); let cancel = false; const usedNames = new Set();
  m.innerHTML = `<div class="modal"><h3>匯出中…</h3><div id="xMsg" class="hint">準備中</div><div class="prog" style="width:100%;margin:14px 0"><b id="xBar"></b></div><div class="acts"><div class="btn" id="xStop">停止</div></div></div>`;
  $('#xStop').onclick = () => { cancel = true; $('#xStop').textContent = '停止中…'; };
  let done = 0, fail = 0; const t0 = performance.now();
  for (const id of ids) {
    if (cancel) break;
    const p = photoById(id); if (!p) continue;
    $('#xMsg').textContent = `${done + 1} / ${ids.length}　${p.name}`;
    try {
      const half = opt.size === 'long' && opt.long <= 3000;
      const edits = { ...DEFAULT_EDITS(), ...clone(p.edits || {}) };
      const fake = { ...p, edits }; // 一律走引擎（未修圖也套用相機原色）
      await renderPhotoOffscreen(fake, async (eng, ed) => {
        const c = ed.crop; const cw = Math.round(c.w * eng.srcW), ch = Math.round(c.h * eng.srcH);
        const img = eng.renderPixels(ed, cw, ch, { alpha: opt.fmt === 'pngA' });
        let oc = new OffscreenCanvas(cw, ch); oc.getContext('2d').putImageData(img, 0, 0);
        let W = cw, H = ch;
        if (opt.size === 'long') { const s = Math.min(1, opt.long / Math.max(cw, ch)); W = Math.round(cw * s); H = Math.round(ch * s); if (s < 1) { const bmp = await createImageBitmap(oc, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' }); oc = new OffscreenCanvas(W, H); oc.getContext('2d').drawImage(bmp, 0, 0); } }
        if (opt.wm) {
          const x = oc.getContext('2d'); const fs = Math.max(14, Math.round(Math.max(W, H) * 0.022));
          x.font = `600 ${fs}px "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif`; x.globalAlpha = opt.wmOpacity / 100; x.fillStyle = '#fff'; x.shadowColor = 'rgba(0,0,0,.5)'; x.shadowBlur = fs * 0.2;
          const tw = x.measureText(opt.wm).width, pad = fs;
          const pos = { br: [W - tw - pad, H - pad], bl: [pad, H - pad], tr: [W - tw - pad, pad + fs], tl: [pad, pad + fs], c: [(W - tw) / 2, H / 2] }[opt.wmPos];
          x.fillText(opt.wm, pos[0], pos[1]); x.globalAlpha = 1;
        }
        const png = opt.fmt === 'png' || opt.fmt === 'pngA';
        const blob = await oc.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: opt.quality / 100 });
        let base = exportName(opt, p, done).replace(/[\\/:*?"<>|]/g, '_').trim() || p.name.replace(/\.[^.]+$/, '');
        const ext = png ? '.png' : '.jpg'; let fn = base + ext, n = 2; while (usedNames.has(fn.toLowerCase())) fn = `${base}_${n++}${ext}`; usedNames.add(fn.toLowerCase());
        await api.writeExport(opt.dir, fn, await blob.arrayBuffer());
      }, half, { alpha: opt.fmt === 'pngA', onDeblur: (pp) => { $('#xMsg').textContent = `${done + 1} / ${ids.length}　${p.name}　AI 去模糊 ${Math.round(pp * 100)}%`; } });
    } catch (err) { console.error(err); fail++; }
    done++;
    $('#xBar').style.width = Math.round(done / ids.length * 100) + '%';
    const left = (performance.now() - t0) / done * (ids.length - done) / 1000;
    $('#xMsg').textContent = `${done} / ${ids.length} 完成，剩約 ${left > 60 ? Math.round(left / 60) + ' 分鐘' : Math.round(left) + ' 秒'}`;
  }
  m.innerHTML = `<div class="modal"><h3>${cancel ? '已停止匯出' : '匯出完成'}</h3><div class="hint">成功 ${done - fail} 張${fail ? `，失敗 ${fail} 張` : ''}。</div><div class="acts"><div class="btn" id="xClose">關閉</div><div class="btn p" id="xOpen">開啟資料夾</div></div></div>`;
  $('#xClose').onclick = () => m.classList.add('hidden');
  $('#xOpen').onclick = () => { api.openDir(opt.dir); m.classList.add('hidden'); };
}

// ─────────────────────────── 小工具：輸入框、選單 ───────────────────────────
function askText(title, label, def) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><div class="row"><label>${esc(label)}</label><input type="text" id="askIn" value="${esc(def || '')}"></div><div class="acts"><div class="btn" id="askNo">取消</div><div class="btn p" id="askOk">確定</div></div></div>`;
    m.classList.remove('hidden');
    const inp = $('#askIn'); inp.focus(); inp.select();
    const done = (v) => { m.classList.add('hidden'); resolve(v); };
    $('#askOk').onclick = () => done(inp.value.trim() || null);
    $('#askNo').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); e.stopPropagation(); };
  });
}
function showMenu(x, y, items) {
  // 項目格式：'-' 分隔線、{ head: '標題' } 群組標題、[名稱, 動作] 或 [名稱, null, 子選單項目]（滑鼠移上展開子選單）
  const m = $('#menu'); const acts = [];
  const build = (list) => list.map((it) => {
    if (it === '-') return '<hr>';
    if (it.head) return `<div class="mh">${esc(it.head)}</div>`;
    if (it[2]) return `<div class="msub">${esc(it[0])}<span class="arr">▸</span><div class="menu subm${it[2].some(x => Array.isArray(x) && x[2]) ? '' : ' leaf'}">${build(it[2])}</div></div>`;
    acts.push(it[1]); return `<div data-mi="${acts.length - 1}">${esc(it[0])}</div>`;
  }).join('');
  m.innerHTML = build(items);
  m.classList.remove('hidden');
  m.style.left = Math.min(x, innerWidth - 220) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 10)) + 'px';
  // 子選單位置：放不下右邊就開在左邊、超出底部就往上移
  m.querySelectorAll('.msub').forEach(el => el.onmouseenter = () => {
    const sm = el.querySelector(':scope > .subm'); sm.style.left = ''; sm.style.right = ''; sm.style.top = '-6px';
    const r = el.getBoundingClientRect();
    if (r.right + sm.offsetWidth > innerWidth - 4) { sm.style.left = 'auto'; sm.style.right = '100%'; }
    const over = r.top - 6 + sm.offsetHeight - (innerHeight - 6); if (over > 0) sm.style.top = (-6 - over) + 'px';
  });
  m.onclick = (e) => { const t = e.target.closest('[data-mi]'); if (t) { m.classList.add('hidden'); acts[+t.dataset.mi](); } };
}
function filmMenuItems(ids) {
  const groups = []; let brand = null, cur = null;
  for (const f of FILMS) {
    if (f.brand || !brand) { brand = { name: f.brand === 'kodak' ? '柯達 Kodak' : '富士 Fujifilm', items: [] }; groups.push(brand); if (f.brand) continue; }
    if (f.cat) { brand.items.push({ head: f.cat.replace(/^柯達｜/, '') }); continue; }
    brand.items.push([f.name, () => applyToPhotos(ids, (b) => ({ ...b, ...filmPatch(f.id, 100) }), '底片：' + f.name)]);
  }
  const off = ['取消底片色調', () => applyToPhotos(ids, (b) => { const d = DEFAULT_EDITS(); const o = { ...b }; FILM_LOOK_KEYS.forEach(k => o[k] = clone(d[k])); o.film = null; return o; }, '取消底片色調')];
  return [...groups.map(g => [g.name, null, g.items]), '-', off];
}
function presetMenu(x, y, ids) {
  const all = [...BUILTIN_PRESETS, ...S.presets];
  showMenu(x, y, all.map(pr => [pr.name, () => applyToPhotos(ids, (b) => ({ ...presetEdits(pr), crop: b.crop }), '套用預設')]));
}

// ─────────────────────────── 事件 ───────────────────────────
function bindGlobal() {
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').classList.add('hidden'); });
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
  $('#btnImport').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); showMenu(r.left, r.bottom + 4, [['匯入資料夾（含子資料夾）', () => doImport('dir')], ['選擇照片檔案', () => doImport('files')]]); };
  $('#btnExport').onclick = exportDialog;

  // 圖庫左側
  $('#libSide').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-proj],[data-folder],[data-smart],[data-rating],[data-flag],[data-edited],[data-cam],[data-color],#newProj,#aiPickAll,#aiRateAll,#fixBlur,#reAnalyze');
    if (!t) return;
    const f = S.filter;
    if (t.id === 'newProj') { const n = await askText('建立專案', '專案名稱', defaultProjectName()); if (n) await createProject(n); return; }
    if (t.id === 'aiPickAll') { aiPickAll(); return; }
    if (t.id === 'aiRateAll') { aiRateAll(); return; }
    if (t.id === 'reAnalyze') { for (const p of S.photos) if (p.ai) p.ai.analyzed = false; toast('重新分析中…'); runAI(S.cur.id); return; }
    if (t.id === 'fixBlur') { const ids = filtered().map(p => p.id); applyToPhotos(ids, (b) => ({ ...b, deblur: 70, defocus: b.defocus || 40 }), 'AI 救回模糊'); return; }
    if (t.dataset.proj) { if (t.dataset.proj !== S.cur?.id) await openProject(t.dataset.proj); return; }
    if (t.dataset.folder) f.folder = t.dataset.folder === '__all' ? null : t.dataset.folder;
    if (t.dataset.smart) f.smart = f.smart === t.dataset.smart ? null : t.dataset.smart;
    if (t.dataset.rating) f.minRating = f.minRating === +t.dataset.rating ? 0 : +t.dataset.rating;
    if (t.dataset.flag) f.flag = f.flag === t.dataset.flag ? null : t.dataset.flag;
    if (t.dataset.edited) { const v = t.dataset.edited === '1'; f.edited = f.edited === v ? null : v; }
    if (t.dataset.cam) f.camera = f.camera === t.dataset.cam ? null : t.dataset.cam;
    if (t.dataset.color) f.color = f.color === t.dataset.color ? null : t.dataset.color;
    renderLibSide(); renderLibBar(); renderGrid();
  });
  $('#libSide').addEventListener('contextmenu', (e) => {
    const t = e.target.closest('[data-proj]'); if (!t) return; e.preventDefault();
    const id = t.dataset.proj;
    showMenu(e.clientX, e.clientY, [['重新命名', async () => { const pr = S.projects.find(p => p.id === id); const n = await askText('重新命名專案', '專案名稱', pr.name); if (n) { pr.name = n; await api.renameProject(id, n); renderLibSide(); renderLibBar(); } }],
      ['刪除專案（不刪原始檔）', async () => { if (await api.deleteProject(id)) { S.projects = S.projects.filter(p => p.id !== id); if (S.cur?.id === id) { S.cur = null; S.photos = []; if (S.projects[0]) await openProject(S.projects[0].id); else renderLibrary(); } else renderLibSide(); } }]]);
  });
  $('#libSide').addEventListener('dblclick', async (e) => { const t = e.target.closest('[data-proj]'); if (!t) return; const pr = S.projects.find(p => p.id === t.dataset.proj); const n = await askText('重新命名專案', '專案名稱', pr.name); if (n) { pr.name = n; await api.renameProject(pr.id, n); renderLibSide(); renderLibBar(); } });

  $('#libBar').addEventListener('change', (e) => { if (e.target.id === 'sort') { S.sort = e.target.value; renderGrid(); } });
  $('#libBar').addEventListener('input', (e) => { if (e.target.id === 'tsize') { S.settings.thumbSize = +e.target.value; document.documentElement.style.setProperty('--ts', e.target.value + 'px'); clearTimeout(saveSettings.t); saveSettings.t = setTimeout(saveSettings, 500); } });
  $('#libBar').addEventListener('click', (e) => { const m = e.target.closest('[data-mode]'); if (m) { S.libMode = m.dataset.mode; renderLibBar(); renderGrid(); } });

  $('#gridWrap').addEventListener('click', async (e) => {
    const imp = e.target.closest('[data-imp]'); if (imp) { doImport(imp.dataset.imp); return; }
    if (e.target.id === 'emptyNew') { const n = await askText('建立專案', '專案名稱', defaultProjectName()); if (n) await createProject(n); return; }
    const t = e.target.closest('.th'); if (t) select(t.dataset.id, e);
    const pane = e.target.closest('.pane'); if (pane) select(pane.dataset.id);
  });
  $('#gridWrap').addEventListener('dblclick', (e) => { const t = e.target.closest('.th,.pane'); if (t) { S.focus = t.dataset.id; switchView('edit'); } });
  $('#gridWrap').addEventListener('contextmenu', (e) => {
    const t = e.target.closest('.th'); if (!t) return; e.preventDefault();
    if (!S.sel.has(t.dataset.id)) select(t.dataset.id);
    const ids = targets();
    showMenu(e.clientX, e.clientY, [
      [`✦ AI 最佳化修圖（${ids.length} 張）`, () => aiOptimizeDialog(ids)],
      ['編輯', () => switchView('edit')],
      ['複製修圖設定', () => copySettings()], ['貼上修圖設定', () => pasteSettings(ids)],
      ['套用預設…', () => presetMenu(e.clientX, e.clientY, ids)],
      ['軟片模擬', null, filmMenuItems(ids)], ['一鍵人像美化', () => applyToPhotos(ids, (b) => ({ ...b, ...beautyPatch() }), '一鍵人像美化')],
      ['AI 去模糊（救回失焦）', () => applyToPhotos(ids, (b) => ({ ...b, deblur: 70 }), 'AI 去模糊')],
      ['重設修圖', () => applyToPhotos(ids, (b) => ({ ...DEFAULT_EDITS(), crop: b.crop }), '重設修圖')],
      '-', ['在檔案總管中顯示', () => api.reveal(photoById(ids[0]).path)],
      ['從專案移除（不刪原始檔）', async () => { if (!(await api.confirm(`從專案移除 ${ids.length} 張照片？`, '原始檔案不會被刪除。'))) return; await api.removePhotos(S.cur.id, ids); S.photos = S.photos.filter(p => !ids.includes(p.id)); S.sel.clear(); renderLibrary(); }]
    ]);
  });
  $('#libInfo').addEventListener('click', (e) => {
    const t = e.target.closest('[data-setrate],[data-setflag],[data-setcolor],[data-quick]'); if (!t) return;
    const ids = targets(); const p = photoById(S.focus);
    if (t.dataset.setrate) patchPhotos(ids, { rating: p.rating === +t.dataset.setrate ? 0 : +t.dataset.setrate });
    if (t.dataset.setflag) patchPhotos(ids, { flag: p.flag === +t.dataset.setflag ? 0 : +t.dataset.setflag });
    if (t.dataset.setcolor) patchPhotos(ids, { color: p.color === t.dataset.setcolor ? '' : t.dataset.setcolor });
    const q = t.dataset.quick;
    if (q === 'edit') switchView('edit');
    if (q === 'copy') copySettings();
    if (q === 'paste') pasteSettings(ids);
    if (q === 'reset') applyToPhotos(ids, (b) => ({ ...DEFAULT_EDITS(), crop: b.crop }), '重設修圖');
    if (q === 'optimize') aiOptimizeDialog(ids);
    if (q === 'deblur') applyToPhotos(ids, (b) => ({ ...b, deblur: 70 }), 'AI 去模糊');
    if (q === 'beauty') applyToPhotos(ids, (b) => ({ ...b, ...beautyPatch() }), '一鍵人像美化');
    if (q === 'auto') { S.focus && switchView('edit'); setTimeout(() => engine?.srcTex && autoAdjust(), 1500); }
    if (q === 'preset') { const r = t.getBoundingClientRect(); e.stopPropagation(); presetMenu(r.left, r.bottom, ids); }
    if (q === 'film') { const r = t.getBoundingClientRect(); e.stopPropagation(); showMenu(r.left, r.bottom, filmMenuItems(ids)); }
  });

  // 拖放匯入
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); const paths = [...e.dataTransfer.files].map(f => api.pathOf(f)).filter(Boolean);
    if (!paths.length) return;
    if (!S.cur) { const name = await askText('建立專案', '專案名稱', defaultProjectName()); if (!name) return; await createProject(name); }
    const r = await api.scanPaths(paths); if (!r.files.length) { toast('沒有找到支援的照片'); return; }
    if (S.view !== 'lib') switchView('lib');
    await importFiles(r.files, r.roots);
  });

  // 編輯畫面
  $('#tools').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.k === 'enhance' && !E.edits.enhanceVec && engine?.srcTex) E.edits.enhanceVec = enhanceVector(engine, E.edits, E.masks);
    if (t.dataset.k) { const k = t.dataset.k; let v = parseFloat(t.value); setEdit({ [k]: v }, { label: t.closest('.sl').querySelector('label').textContent }); const s = Object.values(GROUPS).flat().flatMap(g => g.items || []).find(x => x.key === k); const em = t.parentElement.querySelector('em'); em.textContent = s?.fmt ? s.fmt(v) : (v > 0 && (s ? s.min < 0 : false) ? '+' : '') + Math.round(v); t.classList.toggle('ch', v !== DEFAULT_EDITS()[k]); t.parentElement.querySelector('.rsk')?.classList.toggle('off', v === DEFAULT_EDITS()[k]); }
    if (t.dataset.hk) { const arr = [...E.edits[t.dataset.hk]]; arr[+t.dataset.i] = +t.value; setEdit({ [t.dataset.hk]: arr }, { label: 'HSL' }); t.parentElement.querySelector('em').textContent = (t.value > 0 ? '+' : '') + t.value; }
    if (t.id === 'brSize') { E.brush.size = +t.value / 1000; t.nextElementSibling.textContent = t.value; updBrushCursor(); return; }
    if (t.id === 'brFeather') { E.brush.f = +t.value / 100; t.nextElementSibling.textContent = t.value; return; }
    if (t.id === 'brFlow') { E.brush.flow = +t.value / 100; t.nextElementSibling.textContent = t.value; return; }
    if (t.dataset.lk) { const L = clone(E.edits.local); L[+t.dataset.li][t.dataset.lk] = +t.value; setEdit({ local: L }, { label: '局部調整' }); t.parentElement.querySelector('em').textContent = (t.value > 0 ? '+' : '') + t.value; }
    if (t.id === 'healR') { E.healR = +t.value; $('#healRv').textContent = Math.round(E.healR * 1000); }
    if (t.id === 'bgColor') { setEdit({ bgType: 'custom', bgColor: t.value, bgRep: E.edits.bgRep || 100 }, { label: '背景顏色' }); }
    if (t.id === 'angle') {
      const c0 = E.rotBase || (E.rotBase = clone(E.edits.crop)); const ang = 90 * quarterOf(c0.angle) + +t.value;
      if (!E.crop) { E.crop = true; layoutCanvas(); }
      E.rotating = true; clearTimeout(E.rotT); E.rotT = setTimeout(() => { E.rotating = false; E.rotBase = null; positionCrop(); }, 900);
      setEdit({ crop: cropForAngle(c0, ang) }, { label: '拉直' }); $('#angleV').textContent = (+t.value).toFixed(1) + '°'; positionCrop();
    }
  });
  $('#tools').addEventListener('change', (e) => {
    if (e.target.id === 'layerAddAI' && e.target.value) { addLayer(e.target.value); return; }
    if (e.target.id === 'layerBase') { const L = clone(E.edits.local); L[E.layerSel].mask = e.target.value; setEdit({ local: L }, { label: '圖層範圍' }); renderTools(); return; }
  });
  $('#tools').addEventListener('change', (e) => { if (e.target.id === 'filmSel') { const v = e.target.value; if (v) applyFilm(v, E.edits.film?.amt || 100); else { const d = DEFAULT_EDITS(); const patch = {}; FILM_LOOK_KEYS.forEach(k => patch[k] = d[k]); patch.film = null; setEdit(patch, { label: '取消底片色調' }); renderEditSide(); } renderTools(); } });
  $('#tools').addEventListener('input', (e) => { if (e.target.id === 'filmAmt2' && E.edits.film) { const v = +e.target.value; $('#filmAmt2V').textContent = v; setEdit(filmPatch(E.edits.film.id, v), { label: '底片強度' }); const o = $('#filmAmt'); if (o) { o.value = v; $('#filmAmtV').textContent = v; } } });
  // 放開滑桿後，若區塊標題還沒有「重設」按鈕就重畫一次讓它出現（或在全部歸零時消失）
  $('#tools').addEventListener('change', (e) => {
    const t = e.target; if (!t.matches('input[type=range]')) return; const sec = t.closest('.sec'); if (!sec) return;
    const has = !!sec.querySelector('.t .rst'); const g = GROUPS[E.tab]?.find(gg => (gg.items || []).some(i => i.key === t.dataset.k) || (gg.hsl && t.dataset.hk) || (gg.refocusUI && ['deblur', 'defocus', 'defocusR', 'focusAmt', 'focusRange'].includes(t.dataset.k)));
    if (g && has !== groupChanged(g)) { const st = $('#tools').scrollTop; renderTools(); $('#tools').scrollTop = st; }
  });
  $('#tools').addEventListener('dblclick', (e) => {
    const lb = e.target.closest('.sl > label, .sl > em'); if (lb) { const r = lb.parentElement.querySelector('input[data-k]'); if (r) { resetKeys([r.dataset.k], '重設 ' + lb.parentElement.querySelector('label').textContent); return; } }
    const t = e.target.closest('input[type=range]'); if (!t) return;
    if (t.dataset.k) { setEdit({ [t.dataset.k]: DEFAULT_EDITS()[t.dataset.k] }, { label: '重設' }); renderTools(); }
    if (t.dataset.hk) { const arr = [...E.edits[t.dataset.hk]]; arr[+t.dataset.i] = 0; setEdit({ [t.dataset.hk]: arr }); renderTools(); }
    if (t.id === 'angle') { setEdit({ crop: cropForAngle(E.edits.crop, 90 * quarterOf(E.edits.crop.angle)) }); renderTools(); }
  });
  $('#tools').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-leye],[data-lsel],[data-rstg],[data-rstk],[data-tab],[data-hsl],[data-act],[data-aspect],[data-skytype],[data-mist],[data-hair],[data-bgtype],[data-addlocal],[data-dellocal],[data-delheal]'); if (!t) return;
    if (t.dataset.tab) { E.tab = t.dataset.tab; if (E.tab !== 'crop' && E.crop) { E.crop = false; layoutCanvas(); draw(); } if (E.tab !== 'local' && E.brushMode) setBrushMode(false); renderTools(); draw(); }
    if (t.dataset.hsl) { E.hslTab = t.dataset.hsl; renderTools(); }
    if (t.dataset.aspect) { setEdit({ crop: fitAspect({ ...E.edits.crop, aspect: t.dataset.aspect }, t.dataset.aspect) }, { label: '裁切比例' }); if (!E.crop) { E.crop = true; layoutCanvas(); draw(); } renderTools(); }
    const a = t.dataset.act;
    if (t.dataset.hair) { setEdit({ hairColor: t.dataset.hair, hairAmt: E.edits.hairAmt || 60 }, { label: '髮色' }); renderTools(); }
    if (t.dataset.bgtype) { setEdit({ bgType: t.dataset.bgtype, bgRep: E.edits.bgRep || 100 }, { label: '換背景' }); renderTools(); }
    if (t.dataset.lsel != null && !e.target.closest('[data-leye],[data-dellocal]')) { E.layerSel = +t.dataset.lsel; renderTools(); draw(); return; }
    if (t.dataset.leye != null) { const L = clone(E.edits.local); const l = L[+t.dataset.leye]; l.on = l.on === false; setEdit({ local: L }, { label: '圖層顯示' }); renderTools(); return; }
    if (t.dataset.addlocal) { const L = [...(E.edits.local || [])]; if (L.length >= 4) { toast('最多 4 個局部調整'); return; } L.push({ mask: t.dataset.addlocal, exp: 0, con: 0, sat: 0, temp: 0 }); setEdit({ local: L }, { label: '新增局部調整' }); renderTools(); }
    if (t.dataset.dellocal) { const L = [...E.edits.local]; L.splice(+t.dataset.dellocal, 1); setEdit({ local: L }, { label: '刪除圖層' }); E.layerSel = Math.min(E.layerSel ?? 0, L.length - 1); if (!L.length) setBrushMode(false); renderTools(); draw(); return; }
    if (a === 'layerAddBrush') { addLayer('none'); return; }
    if (a === 'dodge' || a === 'burn') { addLayer('none'); const L = clone(E.edits.local); const l = L[L.length - 1]; l.name = a === 'dodge' ? '加亮（Dodge）' : '加深（Burn）'; l.exp = a === 'dodge' ? 35 : -35; setEdit({ local: L }, { label: l.name }); renderTools(); return; }
    if (a === 'sunPick') { E.sunMode = true; toast('在照片上點一下太陽（或光源）的位置'); if (!E.edits.rays) setEdit({ rays: 50 }, { label: '陽光光束' }); renderTools(); return; }
    if (a === 'lutPick') { const f = await api.pickSky('lut'); if (!f) return; setEdit({ lutPath: fileURL(f), lutAmt: E.edits.lutAmt || 100 }, { label: '載入 LUT' }); renderTools(); return; }
    if (a === 'lutOff') { setEdit({ lutPath: null }, { label: '移除 LUT' }); renderTools(); return; }
    if (a === 'brushPaint' || a === 'brushErase') { const er = a === 'brushErase'; if (E.brushMode && E.brush.erase === er) setBrushMode(false); else { E.brush.erase = er; setBrushMode(true); } renderTools(); return; }
    if (a === 'layerInv') { const L = clone(E.edits.local); L[E.layerSel].inv = !L[E.layerSel].inv; setEdit({ local: L }, { label: '反轉範圍' }); renderTools(); return; }
    if (a === 'layerShow') { E.showMask = !E.showMask; renderTools(); draw(); return; }
    if (a === 'layerClear') { const L = clone(E.edits.local); L[E.layerSel].strokes = []; setEdit({ local: L }, { label: '清除筆畫' }); renderTools(); return; }
    if (a === 'layerRename') { const L = clone(E.edits.local); const n = await askText('圖層名稱', '名稱', layerName(L[E.layerSel])); if (n) { L[E.layerSel].name = n; setEdit({ local: L }, { label: '圖層改名' }); renderTools(); } return; }
    if (t.dataset.delheal) { const H = [...E.edits.heal]; H.splice(+t.dataset.delheal, 1); setEdit({ heal: H }, { label: '刪除修補' }); refreshHeal(); renderTools(); }
    if (t.dataset.rstg != null) { resetGroup(GROUPS[E.tab][+t.dataset.rstg]); return; }
    if (t.dataset.rstk) { resetKeys([t.dataset.rstk], '重設 ' + (t.closest('.sl')?.querySelector('label')?.textContent || '')); return; }
    if (t.dataset.mist) { setEdit({ mist: +t.dataset.mist }, { label: '黑柔濾鏡 ' + t.textContent }); renderTools(); }
    if (a === 'mistWarm') { setEdit({ mistWarm: E.edits.mistWarm === false }, { label: '暖色光暈' }); renderTools(); }
    if (a === 'focusPick') { E.focusMode = !E.focusMode; E.healMode = false; layoutCanvas(); draw(); renderTools(); }
    if (a === 'focusClear') { setEdit({ focus: null }, { label: '取消焦點' }); renderTools(); }
    if (a === 'healToggle') { E.healMode = !E.healMode; layoutCanvas(); draw(); renderTools(); }
    if (a === 'autoLines') autoLines();
    if (t.dataset.skytype) {
      if (t.dataset.skytype === 'custom') { const f = await api.pickSky(); if (!f) return; setEdit({ skyType: 'custom', skyImg: fileURL(f), skyRep: E.edits.skyRep || 100 }, { label: '自訂天空' }); renderTools(); return; }
      setEdit({ skyType: t.dataset.skytype, skyRep: E.edits.skyRep || 100 }, { label: '天空替換' }); renderTools(); }
    if (a === 'cmPick') { const r = t.getBoundingClientRect(); e.stopPropagation(); pickColorRef(r.left, r.bottom); }
    if (a === 'cmClear') { setEdit({ cm: null, cmAmt: 0 }, { label: '清除色彩比對' }); renderTools(); }
    if (a === 'aiCrop') aiCrop();
    if (a === 'optimizeOne') optimizeCurrent();
    if (a === 'auto') autoAdjust();
    if (a === 'autowb') autoWB();
    if (a === 'beauty') { setEdit(beautyPatch(), { label: '一鍵人像美化' }); renderTools(); }
    if (a === 'bw') { setEdit({ bw: !E.edits.bw }, { label: '黑白' }); renderTools(); }
    if (a === 'curveReset') { setEdit({ curve: DEFAULT_EDITS().curve }, { label: '曲線重設' }); drawCurve(); }
    if (a === 'resetAll') { setEdit({ ...DEFAULT_EDITS() }, { label: '重設全部' }); engine.setPins([]); layoutCanvas(); renderTools(); }
    if (a === 'resetTab') { const d = DEFAULT_EDITS(); const keys = E.tab === 'crop' ? ['crop'] : GROUPS[E.tab].flatMap(g => (g.items || []).map(i => i.key).concat(g.hsl ? ['hslH', 'hslS', 'hslL'] : [], g.curve ? ['curve'] : [], g.bw ? ['bw'] : [], g.skyRep ? ['skyRep', 'skyType', 'skyImg', 'skyX', 'skyHorizon', 'skyBlend', 'skyBlur', 'skyExp', 'skyTemp', 'skyRelight', 'skyHaze', 'skyDetail', 'skyReflect'] : [], g.cm ? ['cm', 'cmAmt'] : [])); const patch = {}; keys.forEach(k => patch[k] = d[k]); setEdit(patch, { label: '重設分頁' }); engine.setPins(pinsFor(E.masks?.pins, E.edits)); renderTools(); }
    if (a === 'cropToggle') { E.crop = !E.crop; layoutCanvas(); draw(); renderTools(); }
    if (a === 'cropReset') { setEdit({ crop: DEFAULT_EDITS().crop }, { label: '重設裁切' }); renderTools(); }
    if (a === 'cropRotate') {
      const c = E.edits.crop; const fine = (c.angle || 0) - 90 * quarterOf(c.angle);
      let q = (quarterOf(c.angle) + 1) % 4; if (q > 2) q -= 4; const ang = q * 90 + fine;
      const asp = c.aspect && c.aspect !== 'free' && c.aspect !== 'orig' ? c.aspect.split(':').reverse().join(':') : c.aspect;
      const n = { ...c, angle: ang, aspect: asp || 'free' };
      setEdit({ crop: { ...rectToCrop(maxCropForAspect(ang, aspectValue(n.aspect) || (() => { const r = cropToRect(c); return r.h / r.w; })()), n) } }, { label: '旋轉 90°' }); layoutCanvas(); renderTools();
    }
  });
  $('#editSide').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delpreset]'); if (del) { e.stopPropagation(); S.presets = S.presets.filter(p => p.id !== del.dataset.delpreset); await api.savePresets(S.presets); renderEditSide(); return; }
    const fl = e.target.closest('[data-film]'); if (fl) { E.hover = null; applyFilm(fl.dataset.film, E.edits.film?.amt || 100); return; }
    if (e.target.closest('#filmOff')) { const d = DEFAULT_EDITS(); const patch = {}; FILM_LOOK_KEYS.forEach(k => patch[k] = d[k]); patch.film = null; setEdit(patch, { label: '取消底片色調' }); renderTools(); renderEditSide(); return; }
    const t = e.target.closest('[data-preset]'); if (t) { const pr = [...BUILTIN_PRESETS, ...S.presets].find(p => p.id === t.dataset.preset); E.hover = null; applyPresetToCurrent(pr); }
    if (e.target.closest('#savePreset')) savePresetFromCurrent();
  });
  $('#editSide').addEventListener('input', (e) => { if (e.target.id === 'filmAmt' && E.edits.film) { const v = +e.target.value; $('#filmAmtV').textContent = v; const p = filmPatch(E.edits.film.id, v); setEdit(p, { label: '底片強度' }); const o = $('#filmAmt2'); if (o) { o.value = v; $('#filmAmt2V').textContent = v; } } });
  $('#editSide').addEventListener('mouseover', (e) => { const fl = e.target.closest('[data-film]'); if (fl && engine?.srcTex) { applyFilm(fl.dataset.film, E.edits.film?.amt || 100, true); return; } const t = e.target.closest('[data-preset]'); if (!t || !engine?.srcTex) return; const pr = [...BUILTIN_PRESETS, ...S.presets].find(p => p.id === t.dataset.preset); E.hover = { ...presetEdits(pr), crop: E.edits.crop }; if (E.hover.slim || E.hover.eyeEnlarge) {} draw(); });
  $('#editSide').addEventListener('mouseout', (e) => { const t = e.target.closest('[data-preset],[data-film]'); if (!t) return; if (t.contains(e.relatedTarget)) return; E.hover = null; draw(); });
  $('#editBar').addEventListener('click', (e) => {
    const id = e.target.closest('[id]')?.id;
    if (id === 'tBefore') toggleSplit();
    if (id === 'tZoom') { E.zoom = E.zoom === 'fit' ? '100' : 'fit'; layoutCanvas(); draw(); renderEditBar(); }
    if (id === 'tUndo') undo(); if (id === 'tRedo') redoFn();
    if (id === 'tCopy') copySettings();
    if (id === 'tPaste') pasteSettings([E.photo.id]);
    if (id === 'tSync') { const ids = [...S.sel].filter(x => x !== E.photo.id); const ed = clone(E.edits); ed.enhanceVec = null; applyToPhotos(ids, (b) => ({ ...ed, crop: b.crop }), '同步修圖'); }
  });
  $('#film').addEventListener('click', (e) => {
    const t = e.target.closest('[data-fid]'); if (!t) return; const id = t.dataset.fid;
    if (e.ctrlKey || e.metaKey) { if (id !== E.photo.id) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.sel.add(E.photo.id); } renderFilm(); renderEditBar(); return; }
    if (e.shiftKey) { const list = filtered(); const a = list.findIndex(p => p.id === E.photo.id), b = list.findIndex(p => p.id === id); for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(list[i].id); renderFilm(); renderEditBar(); return; }
    S.sel.clear(); openEdit(id);
  });
  $('#film').addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $('#film').scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  // 畫面縮放 / 拖曳
  let pan = null;
  $('#cv').addEventListener('pointerdown', (e) => {
    if (E.crop) return;
    if (E.focusMode) { pickFocus(e); return; }
    if (E.sunMode) { const [x, y] = screenToSrc(e); E.sunMode = false; setEdit({ sun: { x: +x.toFixed(4), y: +y.toFixed(4) } }, { label: '太陽位置' }); return; }
    if (E.brushMode && !E.spaceDown && e.button === 0) { brushDown(e); return; }
    if (E.healMode) { healDown(e); return; }
    if (E.zoom === 'fit') {
      const r = $('#cv').getBoundingClientRect(); const c = E.edits.crop;
      E.pan = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; E.zoom = '100'; layoutCanvas(); draw(); renderEditBar(); return;
    }
    pan = { x: e.clientX, y: e.clientY, p: [...E.pan], moved: false }; e.currentTarget.setPointerCapture(e.pointerId);
  });
  $('#cv').addEventListener('pointermove', (e) => {
    if (E.brushMode && (brushSt || !pan)) { brushMove(e); return; }
    if (E.healMode) { healMove(e); return; }
    if (!pan) return; const cw = E.edits.crop.w * engine.srcW, ch = E.edits.crop.h * engine.srcH; const dpr = devicePixelRatio || 1;
    const dx = (e.clientX - pan.x) * dpr / cw, dy = (e.clientY - pan.y) * dpr / ch; if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3) pan.moved = true;
    E.pan = [pan.p[0] - dx, pan.p[1] - dy]; layoutCanvas(); draw();
  });
  $('#cv').addEventListener('pointerleave', () => { const c = $('#brushCur'); if (c && !brushSt) c.style.left = '-9999px'; });
  $('#cv').addEventListener('pointerup', (e) => { if (E.brushMode && brushSt) { brushUp(e); return; } if (E.healMode) { healUp(e); return; } if (pan && !pan.moved) { E.zoom = 'fit'; layoutCanvas(); draw(); renderEditBar(); } pan = null; });
  bindSplit(); bindCrop(); bindCurve();
  window.addEventListener('resize', () => { if (S.view === 'edit') { layoutCanvas(); draw(); } });

  // 鍵盤
  document.addEventListener('keyup', (e) => { if (e.key === 'Alt') { E.altErase = false; updBrushCursor(); } if (e.key === ' ') E.spaceDown = false; });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=text],input[type=number],select') || !$('#modal').classList.contains('hidden')) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (S.view === 'edit' && E.brushMode) {
      if (k === '[' || k === ']') { E.brush.size = Math.max(0.002, Math.min(0.3, E.brush.size * (k === ']' ? 1.15 : 0.87))); const b = $('#brSize'); if (b) { b.value = Math.round(E.brush.size * 1000); $('#brSizeV').textContent = b.value; } updBrushCursor(); return; }
      if (k === 'Alt') { E.altErase = true; updBrushCursor(); e.preventDefault(); return; }
      if (k === ' ') { E.spaceDown = true; e.preventDefault(); return; }
      if (k === 'Escape') { setBrushMode(false); renderTools(); return; }
    }
    if (ctrl && k.toLowerCase() === 'z') { if (S.view === 'edit') { e.preventDefault(); e.shiftKey ? redoFn() : undo(); } return; }
    if (ctrl && k.toLowerCase() === 'y') { if (S.view === 'edit') { e.preventDefault(); redoFn(); } return; }
    if (ctrl && k.toLowerCase() === 'c') { copySettings(); return; }
    if (ctrl && k.toLowerCase() === 'v') { pasteSettings(S.view === 'edit' ? [E.photo.id] : targets()); return; }
    if (ctrl && k.toLowerCase() === 'a' && S.view === 'lib') { e.preventDefault(); filtered().forEach(p => S.sel.add(p.id)); document.querySelectorAll('.th').forEach(el => el.classList.add('sel')); renderStatus(); return; }
    if (ctrl && k.toLowerCase() === 'e') { e.preventDefault(); exportDialog(); return; }
    if (e.target.matches('input[type=range]') && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
    if (k === 'ArrowRight') { e.preventDefault(); move(1, e.shiftKey); }
    else if (k === 'ArrowLeft') { e.preventDefault(); move(-1, e.shiftKey); }
    else if (k === 'ArrowDown' && S.view === 'lib') { e.preventDefault(); move(99, e.shiftKey); }
    else if (k === 'ArrowUp' && S.view === 'lib') { e.preventDefault(); move(-99, e.shiftKey); }
    else if (k >= '0' && k <= '5' && !ctrl) { const ids = S.view === 'edit' ? [E.photo.id] : targets(); patchPhotos(ids, { rating: +k }); toast(+k ? '★'.repeat(+k) : '清除評等', 800); }
    else if (k.toLowerCase() === 'p') { patchPhotos(S.view === 'edit' ? [E.photo.id] : targets(), { flag: 1 }); toast('⚑ 選取', 800); }
    else if (k.toLowerCase() === 'x') { patchPhotos(S.view === 'edit' ? [E.photo.id] : targets(), { flag: -1 }); toast('✕ 淘汰', 800); }
    else if (k.toLowerCase() === 'u') { patchPhotos(S.view === 'edit' ? [E.photo.id] : targets(), { flag: 0 }); }
    else if (k === ' ' && S.view === 'lib') { e.preventDefault(); S.libMode = S.libMode === 'grid' ? 'loupe' : 'grid'; renderLibBar(); renderGrid(); }
    else if ((k.toLowerCase() === 'e' || k === 'Enter') && S.view === 'lib') switchView('edit');
    else if (k.toLowerCase() === 'g' || (k === 'Escape' && S.view === 'edit' && !E.crop)) switchView('lib');
    else if (k === 'Escape' && E.crop) { E.crop = false; layoutCanvas(); draw(); renderTools(); }
    else if (k === '\\' && S.view === 'edit') toggleSplit();
    else if (k.toLowerCase() === 'c' && S.view === 'lib' && S.libMode !== 'grid') { S.libMode = 'compare'; renderLibBar(); renderGrid(); }
  });
}
function toggleSplit() { E.split = E.split == null ? 0.5 : null; positionSplit(); draw(); renderEditBar(); }
function copySettings() {
  const p = S.view === 'edit' ? null : photoById(S.focus);
  const e = S.view === 'edit' ? clone(E.edits) : { ...DEFAULT_EDITS(), ...clone(p?.edits || {}) };
  S.clipboard = e; toast('已複製修圖設定（不含裁切）'); if (S.view === 'lib') renderInfo();
}
function pasteSettings(ids) {
  if (!S.clipboard) { toast('還沒有複製設定'); return; }
  const c = clone(S.clipboard); c.enhanceVec = null;
  if (S.view === 'edit' && ids.length === 1 && ids[0] === E.photo.id) { setEdit({ ...c, crop: E.edits.crop }, { label: '貼上設定' }); engine.setPins(pinsFor(E.masks?.pins, E.edits)); renderTools(); return; }
  applyToPhotos(ids, (b) => ({ ...c, crop: b.crop }), '貼上設定');
}

window.addEventListener('beforeunload', () => { if (E.photo) persistEdits(); });
window.__capy = { films: FILMS, filmPatch, optDialog: (ids) => aiOptimizeDialog(ids), S, E, eng: () => engine, refreshHeal: () => { E.healKey = ""; refreshHeal(); }, setEdit, renderTools, openEdit, computeGroups, exportRun: (ids, o) => runExport(ids, o) };
boot();
