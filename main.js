// Capy Photo — 主程式（Electron main process）
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./lib/store');
const rawmeta = require('./lib/rawmeta');

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const RAW_EXT = ['.arw', '.srf', '.sr2', '.nef', '.nrw', '.dng', '.pef', '.cr2', '.cr3', '.raf', '.orf', '.rw2', '.raw', '.rwl', '.3fr', '.iiq', '.x3f', '.srw', '.erf', '.mef', '.mos'];
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.map': 'application/json' };

let win, store;

function headers(ext) {
  return {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache'
  };
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    let file;
    if (u.host === 'bundle') {
      file = path.join(__dirname, decodeURIComponent(u.pathname));
      if (!file.startsWith(__dirname)) return new Response('forbidden', { status: 403 });
    } else if (u.host === 'file') {
      // app://file/<encodeURIComponent(絕對路徑)>
      file = decodeURIComponent(u.pathname.slice(1));
      if (!store.isAllowedPath(file)) return new Response('forbidden', { status: 403 });
    } else return new Response('not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: headers(path.extname(file).toLowerCase()) });
    } catch {
      return new Response('not found', { status: 404, headers: headers('.txt') });
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#141518',
    title: `Capy Photo V${app.getVersion().replace(/\.0$/, '')}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://bundle/renderer/index.html');
  if (process.env.CAPY_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  win.on('close', () => store.flush());
}

function walkDir(dir, out, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 6) walkDir(p, out, depth + 1); }
    else {
      const ext = path.extname(e.name).toLowerCase();
      if (RAW_EXT.includes(ext) || IMG_EXT.includes(ext)) out.push(p);
    }
  }
}

// RAW + JPG 同名時只匯入 RAW
function dedupePairs(files) {
  const rawBase = new Set(files.filter(f => RAW_EXT.includes(path.extname(f).toLowerCase())).map(f => f.slice(0, -path.extname(f).length).toLowerCase()));
  return files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    if (RAW_EXT.includes(ext)) return true;
    return !rawBase.has(f.slice(0, -ext.length).toLowerCase());
  });
}

function setupIpc() {
  ipcMain.handle('state:get', () => store.snapshot());
  ipcMain.handle('project:create', (_e, name) => store.createProject(name));
  ipcMain.handle('project:rename', (_e, id, name) => store.renameProject(id, name));
  ipcMain.handle('project:delete', async (_e, id) => {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['刪除專案', '取消'], defaultId: 1, cancelId: 1, message: '確定要刪除這個專案嗎？', detail: '只會刪除 Capy Photo 裡的專案紀錄與修圖設定，不會刪除你的原始照片檔。' });
    if (r.response !== 0) return false;
    store.deleteProject(id); return true;
  });
  ipcMain.handle('project:open', (_e, id) => {
    store.loadProject(id);
    // 舊版匯入的一般照片（JPG 等）沒有讀 EXIF，開啟專案時補讀一次
    const raw = store.projects.get(id); let changed = false;
    for (const ph of raw?.photos || []) { if (ph.isRaw || ph.infoV >= 2) continue; const inf = rawmeta.readImageInfo(ph.path); if (inf) ph.info = { ...inf, ...Object.fromEntries(Object.entries(ph.info || {}).filter(([, v]) => v)) }; ph.infoV = 2; changed = true; }
    if (changed) store.save(id);
    return store.loadProject(id);
  });

  ipcMain.handle('sky:pick', async (_e, kind) => {
    const r = kind === 'lut' ? await dialog.showOpenDialog(win, { title: '選擇 LUT 檔（.cube）', properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] })
      : await dialog.showOpenDialog(win, { title: kind === 'logo' ? '選擇浮水印圖片' : '選擇天空照片', properties: ['openFile'], filters: [{ name: '照片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'] }] });
    if (r.canceled) return null; store.allowAsset(r.filePaths[0]); return r.filePaths[0];
  });
  ipcMain.handle('import:pick', async (_e, mode) => {
    const r = await dialog.showOpenDialog(win, {
      title: '匯入照片',
      properties: mode === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections'],
      filters: mode === 'files' ? [{ name: 'RAW / 照片', extensions: [...RAW_EXT, ...IMG_EXT].map(e => e.slice(1)) }] : undefined
    });
    if (r.canceled) return null;
    let files = [];
    if (mode === 'files') files = r.filePaths; else for (const d of r.filePaths) walkDir(d, files);
    return { files: dedupePairs(files), roots: r.filePaths };
  });
  ipcMain.handle('import:add', (_e, projectId, files, roots) => {
    const added = [];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      const isRaw = RAW_EXT.includes(ext);
      let st; try { st = fs.statSync(f); } catch { continue; }
      const info = isRaw ? (rawmeta.readInfo(f) || {}) : (rawmeta.readImageInfo(f) || {});
      const root = (roots || []).find(r => f.startsWith(r));
      const folder = root ? (path.relative(root, path.dirname(f)) || path.basename(root)) : path.basename(path.dirname(f));
      const p = store.addPhoto(projectId, { path: f, name: path.basename(f), ext: ext.slice(1).toUpperCase(), isRaw, size: st.size, mtime: st.mtimeMs, folder, info });
      if (p) added.push(p);
    }
    store.save(projectId);
    return added;
  });
  // 取出內嵌 JPEG（給縮圖與挑片用）
  ipcMain.handle('photo:embedded', (_e, file) => {
    const ext = path.extname(file).toLowerCase();
    try {
      if (IMG_EXT.includes(ext)) return { buf: fs.readFileSync(file), type: MIME[ext] || 'image/jpeg' };
      const r = rawmeta.extractPreview(file);
      if (!r) return null;
      return { buf: r.buf, type: 'image/jpeg', dims: r.dims };
    } catch (err) { return null; }
  });
  ipcMain.handle('photo:saveDerived', (_e, projectId, photoId, thumb, preview) => {
    const dir = store.cacheDir(projectId);
    if (thumb) fs.writeFileSync(path.join(dir, `${photoId}_t.jpg`), Buffer.from(thumb));
    if (preview) fs.writeFileSync(path.join(dir, `${photoId}_p.jpg`), Buffer.from(preview));
    return true;
  });
  ipcMain.handle('cache:write', (_e, projectId, name, data) => {
    if (!/^[\w.-]+$/.test(name)) return false;
    fs.writeFileSync(path.join(store.cacheDir(projectId), name), Buffer.from(data)); return true;
  });
  ipcMain.handle('import:scan', (_e, paths) => {
    let files = []; const roots = [];
    for (const p of paths) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { walkDir(p, files); roots.push(p); }
      else { const ext = path.extname(p).toLowerCase(); if (RAW_EXT.includes(ext) || IMG_EXT.includes(ext)) files.push(p); }
    }
    return { files: dedupePairs(files), roots };
  });
  ipcMain.handle('photo:update', (_e, projectId, ids, patch) => store.updatePhotos(projectId, ids, patch));
  ipcMain.handle('photo:duplicate', (_e, projectId, ids) => store.duplicatePhotos(projectId, ids));
  ipcMain.handle('photo:remove', (_e, projectId, ids) => store.removePhotos(projectId, ids));
  ipcMain.handle('photo:reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('presets:save', (_e, presets) => store.savePresets(presets));
  ipcMain.handle('settings:save', (_e, s) => store.saveSettings(s));

  ipcMain.handle('export:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: '選擇匯出資料夾', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('export:write', (_e, dir, name, data) => {
    fs.mkdirSync(dir, { recursive: true });
    let out = path.join(dir, name);
    const ext = path.extname(name), base = name.slice(0, -ext.length);
    let i = 1;
    while (fs.existsSync(out)) out = path.join(dir, `${base}-${i++}${ext}`);
    fs.writeFileSync(out, Buffer.from(data));
    return out;
  });
  ipcMain.handle('export:open', (_e, dir) => shell.openPath(dir));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('dialog:confirm', async (_e, msg, detail) => {
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['確定', '取消'], defaultId: 0, cancelId: 1, message: msg, detail: detail || '' });
    return r.response === 0;
  });
}

// ── 語音指令：離線中文語音辨識（sherpa-onnx + Paraformer，不需要網路）──
let asrRec = null;
function asrPath(f) { return path.join(__dirname, 'models', 'asr', f).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep); }
ipcMain.handle('asr:recognize', (_e, samples) => {
  try {
    if (!asrRec) { const sherpa = require('sherpa-onnx'); asrRec = sherpa.createOfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { paraformer: { model: asrPath('model.int8.onnx') }, tokens: asrPath('tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 } }); }
    const st = asrRec.createStream(); st.acceptWaveform(16000, Float32Array.from(samples)); asrRec.decode(st); const r = asrRec.getResult(st); st.free && st.free(); return { text: r.text || '' };
  } catch (err) { return { error: String(err && err.message || err) }; }
});
app.whenReady().then(() => {
  try { require('electron').session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media')); } catch {}
  store = new Store(app.getPath('userData'));
  registerProtocol();
  setupIpc();
  createWindow();
});
app.on('window-all-closed', () => { store && store.flush(); app.quit(); });
