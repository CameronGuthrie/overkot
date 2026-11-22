; Use a standard assisted, per-user NSIS installer. Show the bundled release
; notes before a manual install. User-requested in-app updates show progress
; directly, then reopen Overkot without repeating the first-install wizard.
; Let Windows lay out the wizard at native DPI instead of enlarging a bitmap
; of the whole dialog. Header/sidebar artwork is supplied at 4x resolution.
ManifestDPIAware true
!include "${PROJECT_DIR}\scripts\installer-branding.nsh"
Var OverkotHeaderBitmap
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.OverkotGuiInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT OverkotGuiInit
!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; MUI's default bitmap loader uses coarse reduction. Replace its result after
; each image control exists, keeping MUI's own bitmap cleanup ownership intact.
!macro customFinishPage
  Function OverkotUpdateFinish
    ${If} ${isUpdated}
      !ifndef HIDE_RUN_AFTER_FINISH
        Call StartApp
      !else
        !insertmacro StartApp
      !endif
      Quit
    ${EndIf}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE OverkotUpdateFinish
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OverkotFinishImage
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define OVERKOT_UNWELCOME_IMAGE
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.OverkotWelcomeImage
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  ; The builder inserts MUI_UNPAGE_FINISH immediately after this hook.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.OverkotFinishImage
!macroend

; The builder expands customHeader after MUI has declared its page variables.
!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !insertmacro OverkotBitmapFunctions "un."
    Function un.OverkotGuiInit
      System::Store "S"
      GetDlgItem $0 $HWNDPARENT 1046
      Push "$PLUGINSDIR\modern-header.bmp"
      Push $0
      Call un.OverkotSetBrandingBitmap
      Pop $OverkotHeaderBitmap
      System::Store "L"
    FunctionEnd
    !ifdef OVERKOT_UNWELCOME_IMAGE
      Function un.OverkotWelcomeImage
        System::Store "S"
        Push "$PLUGINSDIR\modern-wizard.bmp"
        Push $mui.WelcomePage.Image
        Call un.OverkotSetBrandingBitmap
        Pop $0
        ${If} $0 P<> 0
          StrCpy $mui.WelcomePage.Image.Bitmap $0
        ${EndIf}
        System::Store "L"
      FunctionEnd
    !endif
    Function un.OverkotFinishImage
      System::Store "S"
      Push "$PLUGINSDIR\modern-wizard.bmp"
      Push $mui.FinishPage.Image
      Call un.OverkotSetBrandingBitmap
      Pop $0
      ${If} $0 P<> 0
        StrCpy $mui.FinishPage.Image.Bitmap $0
      ${EndIf}
      System::Store "L"
    FunctionEnd
    Function un.onGUIEnd
      ${If} $OverkotHeaderBitmap P<> 0
        System::Call 'gdi32::DeleteObject(p $OverkotHeaderBitmap)'
      ${EndIf}
    FunctionEnd
  !else
    !insertmacro OverkotBitmapFunctions ""
    Function OverkotGuiInit
      System::Store "S"
      GetDlgItem $0 $HWNDPARENT 1046
      Push "$PLUGINSDIR\modern-header.bmp"
      Push $0
      Call OverkotSetBrandingBitmap
      Pop $OverkotHeaderBitmap
      System::Store "L"
    FunctionEnd
    Function OverkotFinishImage
      System::Store "S"
      Push "$PLUGINSDIR\modern-wizard.bmp"
      Push $mui.FinishPage.Image
      Call OverkotSetBrandingBitmap
      Pop $0
      ${If} $0 P<> 0
        StrCpy $mui.FinishPage.Image.Bitmap $0
      ${EndIf}
      System::Store "L"
    FunctionEnd
    Function OverkotInstallProgress
      ${If} ${isUpdated}
        !insertmacro MUI_HEADER_TEXT "Updating to Overkot ${VERSION}" "Installing your update. Overkot will reopen when it is ready."
        SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:Installing Overkot ${VERSION}..."
      ${EndIf}
    FunctionEnd
    Function .onGUIEnd
      ${If} $OverkotHeaderBitmap P<> 0
        System::Call 'gdi32::DeleteObject(p $OverkotHeaderBitmap)'
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include WinMessages.nsh
  Var OverkotNotesDialog
  Var OverkotNotesText

  !macro customPageAfterChangeDir
    Page custom OverkotReleaseNotes

  Function OverkotReleaseNotes
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Overkot ${VERSION}" "Review what's new, then choose Install."
    nsDialogs::Create 1018
    Pop $OverkotNotesDialog
    ${If} $OverkotNotesDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Installs or updates Overkot for your Windows account. Your settings are kept."
    Pop $0
    nsDialogs::CreateControl EDIT ${WS_VISIBLE}|${WS_CHILD}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 28u 100% 108u ""
    Pop $OverkotNotesText
    File /oname=$PLUGINSDIR\overkot-release-notes.txt "${PROJECT_DIR}\.build\release-notes.txt"
    FileOpen $0 "$PLUGINSDIR\overkot-release-notes.txt" r
    StrCpy $1 ""
    ${Do}
      ClearErrors
      FileRead $0 $2
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      StrCpy $1 "$1$2"
    ${Loop}
    FileClose $0
    ${NSD_SetText} $OverkotNotesText $1
    nsDialogs::Show
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OverkotInstallProgress
  !macroend
!endif
