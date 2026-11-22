'use strict';

const { spawn } = require('node:child_process');

/** Observe layout keys and native foreground ownership without installing hooks. */
function startLayoutKeyMonitor({ onShift, onButtonUp = () => {}, onForeground = () => {}, onError = () => {}, parentPid = process.pid,
  spawnProcess = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return { stop() {} };
  const script = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OverlayLayoutKeys { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid); }'
$overlayParent = Get-Process -Id ${Number(parentPid)} -ErrorAction Stop
$previousShift = $false
$previousButton = $false
while (-not $overlayParent.HasExited) {
  $foregroundWindow = [OverlayLayoutKeys]::GetForegroundWindow()
  [uint32]$foregroundPid = 0
  if ($foregroundWindow -ne [IntPtr]::Zero) { [void][OverlayLayoutKeys]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundPid) }
  [Console]::WriteLine('foreground:' + $foregroundPid)
  $currentShift = [OverlayLayoutKeys]::GetAsyncKeyState(16) -lt 0
  $currentButton = [OverlayLayoutKeys]::GetAsyncKeyState(1) -lt 0
  if ($currentShift -ne $previousShift) { [Console]::WriteLine('shift:' + [int]$currentShift); $previousShift = $currentShift }
  if ($previousButton -and -not $currentButton) { [Console]::WriteLine('button:up') }
  $previousButton = $currentButton
  Start-Sleep -Milliseconds 30
  $overlayParent.Refresh()
}`;
  const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '', stopped = false, stderr = '';
  child.stdout.on('data', data => {
    if (stopped) return;
    pending += data.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) {
      if (line === 'shift:1') onShift(true);
      else if (line === 'shift:0') onShift(false);
      else if (line === 'button:up') onButtonUp();
      else if (/^foreground:\d+$/.test(line)) {
        const pid = Number(line.slice('foreground:'.length));
        if (Number.isSafeInteger(pid) && pid > 0) onForeground(pid);
      }
    }
  });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
  child.on('error', error => { if (!stopped) { onShift(false); onError(error); } });
  child.on('exit', code => {
    if (!stopped) { onShift(false); onError(new Error(`Layout key monitor stopped (${code}): ${stderr.trim()}`)); }
  });
  return { stop() { stopped = true; child.kill(); } };
}

module.exports = { startLayoutKeyMonitor };
