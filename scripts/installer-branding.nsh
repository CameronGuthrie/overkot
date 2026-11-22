; Shared by the installer and its native quality check. Load the original
; bitmap, then downsample into physical pixels with GDI's antialiasing mode.
!ifndef OVERKOT_INSTALLER_BRANDING
!define OVERKOT_INSTALLER_BRANDING
!include LogicLib.nsh

!macro OverkotBitmapFunctions PREFIX
; Push bitmap path, width and height. Returns an owned HBITMAP, or zero.
; System::Store preserves every NSIS user register while leaving the result
; on the caller's stack, following the same convention as MUI's image helpers.
Function ${PREFIX}OverkotResizeBitmap
  System::Store "S"
  Pop $2
  Pop $1
  Pop $0
  StrCpy $R0 0
  StrCpy $3 0
  StrCpy $4 0
  StrCpy $5 0
  StrCpy $6 0
  StrCpy $7 0
  StrCpy $8 0
  StrCpy $9 0
  StrCpy $R1 0
  ${If} $1 <= 0
  ${OrIf} $2 <= 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  ; LR_LOADFROMFILE | LR_CREATEDIBSECTION, with no LoadImage scaling.
  System::Call 'user32::LoadImage(p0, t r0, i0, i0, i0, i0x2010) p.r3'
  ${If} $3 P= 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Alloc 24
  Pop $R1
  ${If} $R1 P= 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call 'gdi32::GetObject(p r3, i24, p R1) i.R2'
  ${If} $R2 != 24
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call '*$R1(i, i.R3, i.R4)'
  ${If} $R3 <= 0
  ${OrIf} $R4 <= 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call 'user32::GetDC(p0) p.r4'
  ${If} $4 P= 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call 'gdi32::CreateCompatibleDC(p r4) p.r5'
  System::Call 'gdi32::CreateCompatibleDC(p r4) p.r6'
  System::Call 'gdi32::CreateCompatibleBitmap(p r4, i r1, i r2) p.r7'
  ${If} $5 P= 0
  ${OrIf} $6 P= 0
  ${OrIf} $7 P= 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call 'gdi32::SelectObject(p r5, p r3) p.r8'
  System::Call 'gdi32::SelectObject(p r6, p r7) p.r9'
  System::Call 'gdi32::SetStretchBltMode(p r6, i4) i.R2'
  ${If} $R2 = 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call 'gdi32::SetBrushOrgEx(p r6, i0, i0, p0) i.R2'
  ${If} $R2 = 0
    Goto overkot_bitmap_cleanup
  ${EndIf}
  System::Call 'gdi32::StretchBlt(p r6, i0, i0, i r1, i r2, p r5, i0, i0, i R3, i R4, i0x00cc0020) i.R2'
  ${If} $R2 != 0
    StrCpy $R0 $7
    StrCpy $7 0
  ${EndIf}
overkot_bitmap_cleanup:
  ${If} $8 P<> 0
    System::Call 'gdi32::SelectObject(p r5, p r8)'
  ${EndIf}
  ${If} $9 P<> 0
    System::Call 'gdi32::SelectObject(p r6, p r9)'
  ${EndIf}
  ${If} $5 P<> 0
    System::Call 'gdi32::DeleteDC(p r5)'
  ${EndIf}
  ${If} $6 P<> 0
    System::Call 'gdi32::DeleteDC(p r6)'
  ${EndIf}
  ${If} $3 P<> 0
    System::Call 'gdi32::DeleteObject(p r3)'
  ${EndIf}
  ${If} $7 P<> 0
    System::Call 'gdi32::DeleteObject(p r7)'
  ${EndIf}
  ${If} $4 P<> 0
    System::Call 'user32::ReleaseDC(p0, p r4)'
  ${EndIf}
  ${If} $R1 P<> 0
    System::Free $R1
  ${EndIf}
  Push $R0
  System::Store "L"
FunctionEnd

; Push the source path and target control HWND. Returns the new bitmap or zero.
; The caller must update any MUI-owned bitmap variable to this returned handle.
Function ${PREFIX}OverkotSetBrandingBitmap
  System::Store "S"
  Pop $0
  Pop $1
  StrCpy $R0 0
  System::Alloc 16
  Pop $2
  ${If} $2 P<> 0
    System::Call 'user32::GetClientRect(p r0, p r2) i.r5'
    ${If} $5 != 0
      System::Call '*$2(i, i, i.r3, i.r4)'
      Push $1
      Push $3
      Push $4
      Call ${PREFIX}OverkotResizeBitmap
      Pop $R0
      ${If} $R0 P<> 0
        SendMessage $0 0x0172 0 $R0 $5 ; STM_SETIMAGE / IMAGE_BITMAP
        ${If} $5 P<> 0
          System::Call 'gdi32::DeleteObject(p r5)'
        ${EndIf}
      ${EndIf}
    ${EndIf}
    System::Free $2
  ${EndIf}
  Push $R0
  System::Store "L"
FunctionEnd
!macroend
!endif
