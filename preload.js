const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  getState: inv('state:get'),
  createProject: inv('project:create'),
  renameProject: inv('project:rename'),
  deleteProject: inv('project:delete'),
  openProject: inv('project:open'),
  pickImport: inv('import:pick'),
  addImport: inv('import:add'),
  embedded: inv('photo:embedded'),
  saveDerived: inv('photo:saveDerived'),
  writeCache: inv('cache:write'),
  scanPaths: inv('import:scan'),
  pathOf: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  updatePhotos: inv('photo:update'),
  removePhotos: inv('photo:remove'),
  reveal: inv('photo:reveal'),
  savePresets: inv('presets:save'),
  saveSettings: inv('settings:save'),
  pickExportDir: inv('export:pickDir'),
  writeExport: inv('export:write'),
  openDir: inv('export:open'),
  version: inv('app:version'),
  confirm: inv('dialog:confirm'),
  sep: process.platform === 'win32' ? '\\' : '/'
});
