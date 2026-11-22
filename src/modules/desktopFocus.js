'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const focusShell = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OverkotDesktop {
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
"@
$desktop = [OverkotDesktop]::GetShellWindow()
if ($desktop -eq [IntPtr]::Zero) { return }
if ([OverkotDesktop]::GetForegroundWindow() -ne $desktop) {
    [void][OverkotDesktop]::SetForegroundWindow($desktop)
}
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if ([OverkotDesktop]::GetForegroundWindow() -eq $desktop) { 'focused'; return }
    Start-Sleep -Milliseconds 20
}
`;

async function focusDesktop({ signal } = {}) {
  if (process.platform !== 'win32' || signal?.aborted) return false;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', focusShell],
      { windowsHide: true, timeout: 3000, signal });
    return !signal?.aborted && stdout.trim() === 'focused';
  } catch {
    // Windows can decline activation, and the Explorer shell can be restarting.
    return false;
  }
}

module.exports = { focusDesktop };
