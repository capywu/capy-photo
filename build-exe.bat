@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== Capy Photo 打包（Windows 安裝版 + 免安裝版）====
where node >nul 2>nul || (echo 請先安裝 Node.js LTS：https://nodejs.org & pause & exit /b 1)
call npm install || (echo npm install 失敗 & pause & exit /b 1)
call npx electron-builder --win nsis portable --x64 || (echo 打包失敗 & pause & exit /b 1)
echo.
echo 完成！檔案在 dist 資料夾：
dir /b dist\*.exe
explorer dist
pause
