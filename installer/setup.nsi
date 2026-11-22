Unicode true
!define APP "Capy Photo"
!define VER "1.6.0"
!define SRC "..\dist\win-unpacked"
Name "${APP} ${VER}"
OutFile "..\dist\CapyPhoto-${VER}-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Capy Photo"
InstallDirRegKey HKCU "Software\CapyPhoto" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "..\build\icon.ico"
UninstallIcon "..\build\icon.ico"
VIProductVersion "1.6.0.0"
VIAddVersionKey "ProductName" "Capy Photo"
VIAddVersionKey "FileDescription" "Capy Photo 安裝程式"
VIAddVersionKey "FileVersion" "${VER}"
VIAddVersionKey "CompanyName" "capywu"
!include "MUI2.nsh"
!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Capy Photo.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即開啟 Capy Photo"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "TradChinese"

Section "Install"
  nsExec::Exec 'taskkill /f /im "Capy Photo.exe"'
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Capy Photo.exe"
  CreateShortCut "$DESKTOP\Capy Photo.lnk" "$INSTDIR\Capy Photo.exe"
  CreateDirectory "$SMPROGRAMS\Capy Photo"
  CreateShortCut "$SMPROGRAMS\Capy Photo\Capy Photo.lnk" "$INSTDIR\Capy Photo.exe"
  CreateShortCut "$SMPROGRAMS\Capy Photo\解除安裝 Capy Photo.lnk" "$INSTDIR\Uninstall Capy Photo.exe"
  WriteRegStr HKCU "Software\CapyPhoto" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto" "DisplayName" "Capy Photo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto" "Publisher" "capywu"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto" "DisplayIcon" "$INSTDIR\Capy Photo.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto" "UninstallString" '"$INSTDIR\Uninstall Capy Photo.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto" "NoModify" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /f /im "Capy Photo.exe"'
  Delete "$DESKTOP\Capy Photo.lnk"
  RMDir /r "$SMPROGRAMS\Capy Photo"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CapyPhoto"
  DeleteRegKey HKCU "Software\CapyPhoto"
SectionEnd
