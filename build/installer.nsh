; Force the per-user install directory to %LOCALAPPDATA%\Programs\Dart, instead
; of electron-builder's appId-derived default. This is electron-builder's
; documented preInit hook;
; allowToChangeInstallationDirectory still lets the user choose another folder.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
!macroend

; electron-builder invokes customInstall after the new application files have
; landed. Remove core files that an in-place upgrade from a dual-core build may
; otherwise leave under resources/bin.
!macro customInstall
  RMDir /r "$INSTDIR\resources\bin\singbox"
  RMDir /r "$INSTDIR\resources\bin\sing-box"
  Delete "$INSTDIR\resources\bin\sing-box.exe"
  Delete "$INSTDIR\resources\bin\*.srs"
!macroend
