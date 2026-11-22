'use strict';

const { spawn } = require('node:child_process');
const { screen } = require('electron');

// Send real Windows mouse input, including HWND hit-testing and draggable
// regions. WebContents.sendInputEvent() bypasses that routing and can mask a
// dead native toolbar. Keep one hidden helper alive and restore the cursor.
async function createNativeMouse() {
  if (process.platform !== 'win32') throw new Error('Native mouse fixture requires Windows');
  const previous = screen.dipToScreenPoint(screen.getCursorScreenPoint());
  const script = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WikiNativeMouse { [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; } [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'
[Console]::WriteLine('ready')
while (($line = [Console]::ReadLine()) -ne $null) {
  $parts = $line.Split(',')
  if ($parts[0] -eq 'foreground') {
    [uint32]$owner = 0
    [void][WikiNativeMouse]::GetWindowThreadProcessId([WikiNativeMouse]::GetForegroundWindow(), [ref]$owner)
    [Console]::WriteLine('foreground:' + $owner)
    continue
  }
  if ($parts[0] -eq 'chord' -or $parts[0] -eq 'desktop') {
    $key = if ($parts[0] -eq 'desktop') { 134 } else { 135 }
    foreach ($pressed in @(17, 16, $key)) { [WikiNativeMouse]::keybd_event($pressed, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 40
    foreach ($pressed in @($key, 16, 17)) { [WikiNativeMouse]::keybd_event($pressed, 0, 2, [UIntPtr]::Zero) }
  } else {
    [void][WikiNativeMouse]::SetCursorPos([int]$parts[1], [int]$parts[2])
  }
  if ($parts[0] -eq 'click') {
    Start-Sleep -Milliseconds 50
    $point = New-Object WikiNativeMouse+Point
    $point.X = [int]$parts[1]; $point.Y = [int]$parts[2]
    $window = [WikiNativeMouse]::GetAncestor([WikiNativeMouse]::WindowFromPoint($point), 2)
    [uint32]$owner = 0
    [void][WikiNativeMouse]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -ne ${process.pid} -or $window.ToInt64() -ne [int64]$parts[3]) {
      [Console]::WriteLine('blocked:' + $owner + ':' + $window.ToInt64())
      continue
    }
    [WikiNativeMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [WikiNativeMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  }
  [Console]::WriteLine('done')
}`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', errorText = '', next;
  child.stdout.on('data', chunk => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) if (line === 'ready' || line === 'done' || line.startsWith('blocked:') || line.startsWith('foreground:')) {
      const callback = next; next = null;
      if (line.startsWith('blocked:')) callback?.reject(new Error('Native mouse target is not the intended fixture window: ' + line));
      else callback?.resolve(line.startsWith('foreground:') ? Number(line.slice('foreground:'.length)) : undefined);
    }
  });
  child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-2000); });
  child.on('error', error => { next?.reject(error); next = null; });
  child.on('exit', code => { next?.reject(new Error(`Native mouse helper exited (${code}): ${errorText}`)); next = null; });
  function response() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native mouse helper timed out: ' + errorText)), 8000);
      next = { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
    });
  }
  await response();
  async function send(command, point, window = '') {
    const received = response();
    child.stdin.write(`${command},${Math.round(point.x)},${Math.round(point.y)},${window}\n`);
    return received;
  }
  async function clickPoint(win, local) {
    const bounds = win.getContentBounds();
    const handle = win.getNativeWindowHandle();
    const window = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
    await send('click', screen.dipToScreenPoint({ x: Math.round(bounds.x + local.x), y: Math.round(bounds.y + local.y) }), window);
  }
  let closed = false;
  return {
    async click(win, id) {
      const local = await win.webContents.executeJavaScript(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        if (!element || element.disabled) throw new Error('Unavailable control: ' + ${JSON.stringify(id)});
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      })()`);
      await clickPoint(win, local);
    },
    clickPoint,
    // Reserved fixture chord: Control+Shift+F24. A real registered hotkey gives
    // Electron Windows foreground permission; calling its callback does not.
    async pressFocusChord() { await send('chord', previous); },
    async pressDesktopChord() { await send('desktop', previous); },
    async foregroundPid() { return send('foreground', previous); },
    async close() { if (closed) return; closed = true; await send('move', previous); child.stdin.end(); },
  };
}

module.exports = { createNativeMouse };
