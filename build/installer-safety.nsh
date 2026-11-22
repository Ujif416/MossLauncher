!macro MossCheckProject DIR
  ${If} ${FileExists} "${DIR}\package.json"
  ${OrIf} ${FileExists} "${DIR}\src\main\index.js"
  ${OrIf} ${FileExists} "${DIR}\.git\HEAD"
    MessageBox MB_OK|MB_ICONSTOP "MossLauncher: this folder contains a project. Installation or removal was stopped to protect your files." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
!macro customInit
  !insertmacro MossCheckProject "$INSTDIR"
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R8 != ""
    !insertmacro MossCheckProject "$R8"
  ${EndIf}
  ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R8 != ""
    !insertmacro MossCheckProject "$R8"
  ${EndIf}
!macroend
!macro customUnInit
  !insertmacro MossCheckProject "$INSTDIR"
!macroend

; Recheck the final user-selected directory before uninstalling or copying files.
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE MossInstFilesPre
    Function MossInstFilesPre
      Call instFilesPre
      !insertmacro MossCheckProject "$INSTDIR"
    FunctionEnd
  !endif
!macroend
