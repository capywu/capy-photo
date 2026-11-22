// 專案、照片紀錄、預設集與設定的儲存（JSON 檔，位於使用者資料夾）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uid = () => crypto.randomBytes(6).toString('hex');

class Store {
  constructor(userData) {
    this.root = path.join(userData, 'library');
    this.projDir = path.join(this.root, 'projects');
    this.cacheRoot = path.join(this.root, 'cache');
    fs.mkdirSync(this.projDir, { recursive: true });
    fs.mkdirSync(this.cacheRoot, { recursive: true });
    this.indexFile = path.join(this.root, 'index.json');
    this.index = { projects: [], presets: null, settings: {} };
    try { this.index = { ...this.index, ...JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) }; } catch {}
    this.projects = new Map();   // id -> project data (已載入)
    this.allowed = new Set();
    for (const a of this.index.assets || []) this.allowed.add(path.normalize(a));   // 使用者選的天空照片、LUT、浮水印圖
    this.timers = new Map();
  }
  allowAsset(f) {
    const n = path.normalize(f); this.allowed.add(n);
    const a = this.index.assets || (this.index.assets = []); if (!a.includes(n)) { a.push(n); if (a.length > 300) a.shift(); try { fs.writeFileSync(this.indexFile, JSON.stringify(this.index)); } catch {} }
  }
  snapshot() {
    return { projects: this.index.projects.map(p => this.summary(p.id)), presets: this.index.presets, settings: this.index.settings, cacheRoot: this.cacheRoot };
  }
  summary(id) {
    const meta = this.index.projects.find(p => p.id === id);
    const loaded = this.projects.get(id);
    return { ...meta, count: loaded ? loaded.photos.length : (meta.count || 0) };
  }
  saveIndex() {
    for (const m of this.index.projects) { const l = this.projects.get(m.id); if (l) m.count = l.photos.length; }
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index));
  }
  createProject(name) {
    const id = uid();
    const meta = { id, name: name || '未命名專案', created: Date.now(), count: 0 };
    this.index.projects.unshift(meta);
    this.projects.set(id, { id, photos: [] });
    this.save(id); this.saveIndex();
    return meta;
  }
  renameProject(id, name) { const m = this.index.projects.find(p => p.id === id); if (m) { m.name = name; this.saveIndex(); } return true; }
  deleteProject(id) {
    this.index.projects = this.index.projects.filter(p => p.id !== id);
    this.projects.delete(id);
    try { fs.rmSync(path.join(this.projDir, id + '.json'), { force: true }); } catch {}
    try { fs.rmSync(path.join(this.cacheRoot, id), { recursive: true, force: true }); } catch {}
    this.saveIndex();
  }
  loadProject(id) {
    let p = this.projects.get(id);
    if (!p) {
      try { p = JSON.parse(fs.readFileSync(path.join(this.projDir, id + '.json'), 'utf8')); }
      catch { p = { id, photos: [] }; }
      this.projects.set(id, p);
    }
    for (const ph of p.photos) this.allowed.add(path.normalize(ph.path));
    return { ...p, cacheDir: this.cacheDir(id) };
  }
  cacheDir(id) { const d = path.join(this.cacheRoot, id); fs.mkdirSync(d, { recursive: true }); return d; }
  isAllowedPath(f) {
    const n = path.normalize(f);
    return n.startsWith(this.cacheRoot) || this.allowed.has(n);
  }
  addPhoto(projectId, data) {
    const p = this.projects.get(projectId) || this.loadProject(projectId) && this.projects.get(projectId);
    if (p.photos.some(x => x.path === data.path)) return null;
    const ph = { id: uid(), ...data, rating: 0, flag: 0, color: '', edits: null, ai: null, added: Date.now() };
    p.photos.push(ph);
    this.allowed.add(path.normalize(data.path));
    return ph;
  }
  updatePhotos(projectId, ids, patch) {
    const p = this.projects.get(projectId); if (!p) return false;
    const set = new Set(ids);
    for (const ph of p.photos) if (set.has(ph.id)) {
      for (const k of Object.keys(patch)) ph[k] = patch[k];
    }
    this.save(projectId);
    return true;
  }
  // 建立虛擬副本：同一個原始檔、獨立的修圖設定
  duplicatePhotos(projectId, ids) {
    const p = this.projects.get(projectId); if (!p) return [];
    const out = [];
    for (const id of ids) {
      const i = p.photos.findIndex(x => x.id === id); if (i < 0) continue; const o = p.photos[i];
      const n = JSON.parse(JSON.stringify(o)); n.id = uid(); n.copyOf = o.copyOf || o.id; n.added = Date.now();
      const base = o.name.replace(/( 副本( \d+)?)?(\.[^.]+)$/, ''); const cnt = p.photos.filter(x => (x.copyOf || x.id) === n.copyOf).length;
      n.name = `${base} 副本${cnt > 1 ? ' ' + cnt : ''}${(o.name.match(/\.[^.]+$/) || [''])[0]}`;
      const dir = this.cacheDir(projectId);
      for (const suf of ['_t.jpg', '_p.jpg', '_e.jpg', '_e_t.jpg']) { try { fs.copyFileSync(path.join(dir, o.id + suf), path.join(dir, n.id + suf)); } catch {} }
      p.photos.splice(i + 1, 0, n); out.push(n);
    }
    this.save(projectId); this.saveIndex(); return out;
  }
  removePhotos(projectId, ids) {
    const p = this.projects.get(projectId); if (!p) return false;
    const set = new Set(ids);
    p.photos = p.photos.filter(x => !set.has(x.id));
    this.save(projectId); this.saveIndex();
    return true;
  }
  savePresets(presets) { this.index.presets = presets; this.saveIndex(); return true; }
  saveSettings(s) { this.index.settings = s; this.saveIndex(); return true; }
  save(id) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this.writeNow(id), 400));
  }
  writeNow(id) {
    const p = this.projects.get(id); if (!p) return;
    const f = path.join(this.projDir, id + '.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(p));
    fs.renameSync(f + '.tmp', f);
    this.timers.delete(id);
  }
  flush() { for (const id of [...this.timers.keys()]) { clearTimeout(this.timers.get(id)); this.writeNow(id); } this.saveIndex(); }
}

module.exports = { Store };
