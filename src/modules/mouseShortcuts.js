'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

const mouseBinding = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Super\+)?(?:Mouse[1-5]|Wheel(?:Up|Down|Left|Right))$/;
const helperName = 'overkot-mouse-shortcuts.exe';

function startHelper() {
  const options = { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] };
  if (process.resourcesPath && !process.defaultApp) {
    const exe = path.join(process.resourcesPath, 'bin', helperName);
    fs.accessSync(exe);
    return spawn(exe, [String(process.pid)], options);
  }
  // A source checkout can run the same C# implementation before packaging.
  const source = path.resolve(__dirname, '../../native/mouse-shortcuts.cs');
  const powershell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; $wpf=Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) WPF; "
    + "$refs=@('System','System.Core','System.Windows.Forms')+@('UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll' | ForEach-Object {Join-Path $wpf $_}); "
    + "Add-Type -Path $env:OVERKOT_MOUSE_SOURCE -ReferencedAssemblies $refs; exit [OverkotMouseShortcuts]::Main(@([string]$env:OVERKOT_MOUSE_OWNER))";
  return spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { ...options, env: { ...process.env, OVERKOT_MOUSE_SOURCE: source, OVERKOT_MOUSE_OWNER: String(process.pid) } });
}

function createMouseShortcuts({ onPress, onCapture, onError, platform = process.platform, start = startHelper }) {
  let child = null, sent = null;

  function stop() {
    const previous = child;
    child = null;
    sent = null;
    previous?.kill();
  }

  function setState({ interactionHotkey, overlayVisibilityHotkey, capture = false, gamePid, settingsHwnd }) {
    const interact = mouseBinding.test(interactionHotkey) ? interactionHotkey : '';
    const visibility = mouseBinding.test(overlayVisibilityHotkey) ? overlayVisibilityHotkey : '';
    if (!capture && !interact && !visibility) { stop(); return true; }
    if (platform !== 'win32') return false;
    const state = [interact, visibility, capture ? 1 : 0,
      Number.isSafeInteger(gamePid) && gamePid > 0 ? gamePid : 0,
      /^[0-9]{1,18}$/.test(String(settingsHwnd)) ? settingsHwnd : 0].join('|');
    if (state === sent) return true;
    try {
      if (!child) {
        const helper = start();
        child = helper;
        const failed = error => {
          if (child !== helper) return;
          stop(); onError(error);
        };
        helper.once('error', failed);
        helper.once('exit', code => failed(new Error('Mouse shortcut helper stopped (' + code + ')')));
        helper.stdin.on('error', failed);
        createInterface({ input: helper.stdout }).on('line', line => {
          if (child !== helper) return;
          const [kind, binding, ticket] = line.split(':');
          if (!mouseBinding.test(binding)) return;
          if (kind === 'capture') onCapture(binding);
          else if (kind === 'press') {
            let available = /^[1-9]\d{0,15}$/.test(ticket);
            onPress(binding, hwnd => {
              if (!available || child !== helper || !/^[1-9]\d{0,17}$/.test(String(hwnd))) return false;
              available = false;
              helper.stdin.write('focus|' + ticket + '|' + hwnd + '\n');
              return true;
            });
          }
        });
      }
      child.stdin.write(state + '\n');
      sent = state;
      return true;
    } catch (error) {
      const interrupted = sent !== null;
      stop();
      if (interrupted) onError(error);
      return false;
    }
  }
  return { setState, stop };
}

module.exports = { createMouseShortcuts };
