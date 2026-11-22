; Compile and run only the product's page flow. No installation, registry,
; shortcuts or application launches occur; the section writes a fixture report.
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
Name "Overkot update flow check"
OutFile "${OUTPUT_EXE}"
RequestExecutionLevel user
ShowInstDetails nevershow
Var Updating
!define VERSION "9.8.7"
!define isUpdated '$Updating == 1'
!define HIDE_RUN_AFTER_FINISH
!define MUI_ICON "${PROJECT_DIR}\assets\overkot.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${PROJECT_DIR}\assets\installer-header.bmp"
!macro StartApp
  FileOpen $8 "$EXEDIR\update-flow.txt" a
  FileSeek $8 0 END
  FileWrite $8 "reopened=true$\r$\n"
  FileClose $8
!macroend
!include "${PROJECT_DIR}\scripts\installer.nsh"
!undef MUI_CUSTOMFUNCTION_GUIINIT
!define MUI_CUSTOMFUNCTION_GUIINIT ProbeGuiInit
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro customHeader
Function .onInit
  StrCpy $Updating 1
FunctionEnd
Function ProbeGuiInit
  Call OverkotGuiInit
  ; Keep this component-only harness away from the user's desktop.
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i -30000, i -30000, i 0, i 0, i 0x15)'
  ShowWindow $HWNDPARENT 0
FunctionEnd
Section
  FileOpen $8 "$EXEDIR\update-flow.txt" w
  FileWrite $8 "installed=true$\r$\n"
  GetDlgItem $0 $HWNDPARENT 1037
  ${NSD_GetText} $0 $1
  FileWrite $8 "header=$1$\r$\n"
  ${NSD_GetText} $mui.InstFilesPage.Text $1
  FileWrite $8 "status=$1$\r$\n"
  System::Call 'user32::GetClassNameW(p $mui.InstFilesPage.ProgressBar, w .r1, i ${NSIS_MAX_STRLEN})'
  FileWrite $8 "progress=$1$\r$\n"
  FileClose $8
  Sleep 50
SectionEnd
