; Force the per-user install directory to %LOCALAPPDATA%\Programs\Dart, instead
; of electron-builder's appId-derived default (which produced a nested
; "singboxgui\Dart" path). This is electron-builder's documented preInit hook;
; allowToChangeInstallationDirectory still lets the user choose another folder.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Dart"
!macroend
