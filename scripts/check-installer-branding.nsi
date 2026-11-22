; Compile with /DOUTPUT_EXE=<isolated output/check.exe> and
; /DSOURCE_BITMAP=<installer-header.bmp>. Running this silent executable writes
; only two test bitmaps and a report alongside itself. It installs nothing.
!ifndef OUTPUT_EXE
  !error "Set OUTPUT_EXE to an isolated output directory"
!endif
!ifndef SOURCE_BITMAP
  !error "Set SOURCE_BITMAP to the generated installer header"
!endif
Name "Overkot installer bitmap check"
OutFile "${OUTPUT_EXE}"
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ManifestDPIAware true
!include "installer-branding.nsh"
!insertmacro OverkotBitmapFunctions ""
Var TestBitmap
Var TestControl
Var GdiBefore
Var GdiAfter
Var Iteration

; Push bitmap, width, height and output path. Export with GetDIBits/WriteFile.
Function SaveTestBitmap
  System::Store "S"
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  IntOp $7 $1 * $2
  IntOp $7 $7 * 4
  IntOp $6 $7 + 54
  System::Alloc $6
  Pop $4
  ${If} $4 P= 0
    Goto save_failed
  ${EndIf}
  System::Call '*$4(&i2 0x4d42)'
  IntOp $5 $4 + 2
  System::Call '*$5(i r6, i0, i54)'
  IntOp $5 $4 + 14
  System::Call '*$5(i40, i r1, i r2, i0x00200001, i0, i r7, i0, i0, i0, i0)'
  IntOp $8 $4 + 54
  System::Call 'user32::GetDC(p0) p.r9'
  System::Call 'gdi32::GetDIBits(p r9, p r0, i0, i r2, p r8, p r5, i0) i.R0'
  System::Call 'user32::ReleaseDC(p0, p r9)'
  ${If} $R0 != $2
    System::Free $4
    Goto save_failed
  ${EndIf}
  System::Call 'kernel32::CreateFile(t r3, i0x40000000, i0, p0, i2, i0x80, p0) p.r5'
  ${If} $5 P= -1
    System::Free $4
    Goto save_failed
  ${EndIf}
  System::Call 'kernel32::WriteFile(p r5, p r4, i r6, *i.R1, p0) i.R0'
  System::Call 'kernel32::CloseHandle(p r5)'
  System::Free $4
  ${If} $R0 = 0
  ${OrIf} $R1 != $6
    Goto save_failed
  ${EndIf}
  Push 1
  System::Store "L"
  Return
save_failed:
  Push 0
  System::Store "L"
FunctionEnd

Section
  InitPluginsDir
  File /oname=$PLUGINSDIR\source.bmp "${SOURCE_BITMAP}"
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'user32::GetGuiResources(p r0, i0) i.r1'
  StrCpy $GdiBefore $1
  ; Sentinel values prove that the production helper preserves all registers.
  StrCpy $0 "sentinel0"
  StrCpy $1 "sentinel1"
  StrCpy $2 "sentinel2"
  StrCpy $3 "sentinel3"
  StrCpy $4 "sentinel4"
  StrCpy $5 "sentinel5"
  StrCpy $6 "sentinel6"
  StrCpy $7 "sentinel7"
  StrCpy $8 "sentinel8"
  StrCpy $9 "sentinel9"
  StrCpy $R0 "sentinelR0"
  StrCpy $R1 "sentinelR1"
  StrCpy $R2 "sentinelR2"
  StrCpy $R3 "sentinelR3"
  StrCpy $R4 "sentinelR4"
  StrCpy $R5 "sentinelR5"
  StrCpy $R6 "sentinelR6"
  StrCpy $R7 "sentinelR7"
  StrCpy $R8 "sentinelR8"
  StrCpy $R9 "sentinelR9"
  Push "$PLUGINSDIR\source.bmp"
  Push 150
  Push 57
  Call OverkotResizeBitmap
  Pop $TestBitmap
  ${If} $TestBitmap P= 0
    SetErrorLevel 1
    Quit
  ${EndIf}
  ${If} $0 != "sentinel0"
  ${OrIf} $1 != "sentinel1"
  ${OrIf} $2 != "sentinel2"
  ${OrIf} $3 != "sentinel3"
  ${OrIf} $4 != "sentinel4"
  ${OrIf} $5 != "sentinel5"
  ${OrIf} $6 != "sentinel6"
  ${OrIf} $7 != "sentinel7"
  ${OrIf} $8 != "sentinel8"
  ${OrIf} $9 != "sentinel9"
  ${OrIf} $R0 != "sentinelR0"
  ${OrIf} $R1 != "sentinelR1"
  ${OrIf} $R2 != "sentinelR2"
  ${OrIf} $R3 != "sentinelR3"
  ${OrIf} $R4 != "sentinelR4"
  ${OrIf} $R5 != "sentinelR5"
  ${OrIf} $R6 != "sentinelR6"
  ${OrIf} $R7 != "sentinelR7"
  ${OrIf} $R8 != "sentinelR8"
  ${OrIf} $R9 != "sentinelR9"
    SetErrorLevel 2
    Quit
  ${EndIf}
  Push $TestBitmap
  Push 150
  Push 57
  Push "$EXEDIR\nsis-halftone-1.bmp"
  Call SaveTestBitmap
  Pop $0
  System::Call 'gdi32::DeleteObject(p $TestBitmap)'
  ${If} $0 != 1
    SetErrorLevel 3
    Quit
  ${EndIf}
  Push "$PLUGINSDIR\source.bmp"
  Push 300
  Push 114
  Call OverkotResizeBitmap
  Pop $TestBitmap
  ${If} $TestBitmap P= 0
    SetErrorLevel 4
    Quit
  ${EndIf}
  Push $TestBitmap
  Push 300
  Push 114
  Push "$EXEDIR\nsis-halftone-2.bmp"
  Call SaveTestBitmap
  Pop $0
  System::Call 'gdi32::DeleteObject(p $TestBitmap)'
  ${If} $0 != 1
    SetErrorLevel 5
    Quit
  ${EndIf}
  ; A hidden bitmap control exercises physical-size lookup and replacement,
  ; including deletion of the old bitmap when the control is resized.
  System::Call 'user32::CreateWindowEx(i0, t"STATIC", t"", i0x8000000e, i0, i0, i150, i57, p0, p0, p0, p0) p.s'
  Pop $TestControl
  ${If} $TestControl P= 0
    SetErrorLevel 9
    Quit
  ${EndIf}
  Push "$PLUGINSDIR\source.bmp"
  Push $TestControl
  Call OverkotSetBrandingBitmap
  Pop $TestBitmap
  ${If} $TestBitmap P= 0
    SetErrorLevel 10
    Quit
  ${EndIf}
  Push $TestBitmap
  Push 150
  Push 57
  Push "$EXEDIR\nsis-control-halftone-1.bmp"
  Call SaveTestBitmap
  Pop $0
  ${If} $0 != 1
    SetErrorLevel 11
    Quit
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $TestControl, p0, i0, i0, i300, i114, i0x0016)'
  Push "$PLUGINSDIR\source.bmp"
  Push $TestControl
  Call OverkotSetBrandingBitmap
  Pop $TestBitmap
  ${If} $TestBitmap P= 0
    SetErrorLevel 12
    Quit
  ${EndIf}
  Push $TestBitmap
  Push 300
  Push 114
  Push "$EXEDIR\nsis-control-halftone-2.bmp"
  Call SaveTestBitmap
  Pop $0
  ${If} $0 != 1
    SetErrorLevel 13
    Quit
  ${EndIf}
  ; Exercise allocation/cleanup repeatedly, including failed-load paths.
  StrCpy $Iteration 0
  ${Do}
    Push "$PLUGINSDIR\source.bmp"
    Push 150
    Push 57
    Call OverkotResizeBitmap
    Pop $TestBitmap
    ${If} $TestBitmap P= 0
      SetErrorLevel 6
      Quit
    ${EndIf}
    System::Call 'gdi32::DeleteObject(p $TestBitmap)'
    Push "$PLUGINSDIR\missing.bmp"
    Push 150
    Push 57
    Call OverkotResizeBitmap
    Pop $TestBitmap
    ${If} $TestBitmap P<> 0
      SetErrorLevel 7
      Quit
    ${EndIf}
    IntOp $Iteration $Iteration + 1
  ${LoopWhile} $Iteration < 100
  SendMessage $TestControl 0x0172 0 0 $0
  ${If} $0 P<> 0
    System::Call 'gdi32::DeleteObject(p r0)'
  ${EndIf}
  System::Call 'user32::DestroyWindow(p $TestControl)'
  System::Call 'kernel32::GetCurrentProcess() p.r0'
  System::Call 'user32::GetGuiResources(p r0, i0) i.r1'
  StrCpy $GdiAfter $1
  ${If} $GdiAfter > $GdiBefore
    SetErrorLevel 8
    Quit
  ${EndIf}
  FileOpen $0 "$EXEDIR\nsis-branding-check.txt" w
  FileWrite $0 "ok=true$\r$\nregistersPreserved=true$\r$\ngdiBefore=$GdiBefore$\r$\ngdiAfter=$GdiAfter$\r$\n"
  FileClose $0
  SetErrorLevel 0
SectionEnd
