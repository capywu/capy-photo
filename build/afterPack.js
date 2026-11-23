// Mac：打包後做「臨時簽章」（ad-hoc），沒有簽章的 App 在 Apple 晶片 Mac 上下載後會被顯示「已損毀」
const { execSync } = require('child_process');
const path = require('path');
exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${app}"`, { stdio: 'inherit' });
};
