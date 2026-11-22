Unicode true
!define VER "1.5.0"
!define SRC "..\dist\win-unpacked"
Name "Capy Photo ${VER}"
OutFile "..\dist\CapyPhoto-${VER}-Portable.exe"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "..\build\icon.ico"
SilentInstall silent
VIProductVersion "1.5.0.0"
VIAddVersionKey "ProductName" "Capy Photo（免安裝版）"
VIAddVersionKey "FileDescription" "Capy Photo 免安裝版"
VIAddVersionKey "FileVersion" "${VER}"
VIAddVersionKey "CompanyName" "capywu"
Section
  ; 解壓到暫存資料夾（同版本只解壓一次），照片資料與設定仍存在使用者資料夾
  StrCpy $0 "$TEMP\CapyPhoto-${VER}"
  IfFileExists "$0\Capy Photo.exe" run
  SetOutPath "$0"
  File /r "${SRC}\*.*"
  run:
  Exec '"$0\Capy Photo.exe"'
SectionEnd
