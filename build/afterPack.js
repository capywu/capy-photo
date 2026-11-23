// 打包後處理：
//  Windows：不用 wine，用 resedit 寫入 exe 圖示與版本資訊
//  Mac：做「臨時簽章」（ad-hoc），沒有簽章的 App 在 Apple 晶片 Mac 上下載後會被顯示「已損毀」
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName === 'darwin') {
    const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
    execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
    execSync(`codesign --verify --deep --strict "${app}"`, { stdio: 'inherit' });
    return;
  }
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const data = fs.readFileSync(exe);
  const pe = R.NtExecutable.from(data, { ignoreCert: true });
  const res = R.NtExecutableResource.from(pe);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map(i => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  const v = ctx.packager.appInfo.version.split('.').map(Number);
  vi.setFileVersion(v[0], v[1], v[2], 0, 1033); vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Capy Photo', FileDescription: 'Capy Photo', CompanyName: 'capywu', OriginalFilename: 'Capy Photo.exe', InternalName: 'Capy Photo' });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log('  • 已寫入圖示與版本資訊', exe);
};
