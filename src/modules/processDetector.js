/**
 * Process detector – finds Soulframe.x64.exe (including Wine/Proton on Linux)
 * Port of Rust memory.rs find_soulframe_process()
 *
 * Cross-platform:
 *   Windows: tasklist CLI for initial process discovery (findProcess)
 *            process.kill(pid, 0) for fast PID liveness checks (isProcessRunning)
 *   Linux:   reads /proc/PID/comm or uses ps
 */

const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const IS_WIN = os.platform() === 'win32';
const IS_LINUX = os.platform() === 'linux';

// Compatibility runtimes can expose either the full or shortened game name.
const GAME_EXE_WIN = 'soulframe.x64.exe';
const GAME_EXE_LINUX = 'soulframe';
const isGameProcessName = value => [GAME_EXE_LINUX, GAME_EXE_WIN, GAME_EXE_WIN.slice(0, 15)]
  .includes(value.trim().toLowerCase().split(/[\\/]/).pop());

class ProcessDetector {
  constructor(debug = false) {
    this.debug = debug;
  }

  _log(...args) {
    if (!this.debug) return;
    const d = new Date(); const ts = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    console.log(`[${ts}][PROCESS]`, ...args);
  }

  /**
   * Enumerate running processes and find the Soulframe game process.
   * @returns {Promise<number>} PID or 0 if not found
   */
  async findProcess() {
    if (IS_WIN) return this._findProcessWindows();
    if (IS_LINUX) return this._findProcessLinux();
    this._log(`Unsupported platform: ${os.platform()}`);
    return 0;
  }

  /**
   * Return focus to the running Soulframe game after an overlay interaction.
   * Windows can refuse a foreground request, so only report success after
   * verifying that the game owns the foreground window.
   * @returns {Promise<boolean>} false if unavailable, unsupported, or refused
   */
  async focusGameWindow({ signal } = {}) {
    if (!IS_WIN || signal?.aborted) return false;
    try {
      const gamePid = await this.findProcess();
      if (signal?.aborted) return false;
      if (!Number.isSafeInteger(gamePid) || gamePid <= 0 || gamePid > 0xffffffff) return false;

      const script = `
$ErrorActionPreference = 'Stop'
$game = Get-Process -Id ${gamePid} -ErrorAction Stop
# Check the name again in case the discovered process exited and its PID was reused.
if ($game.ProcessName -ine 'Soulframe.x64') { Write-Output '0'; exit }
$game.Refresh()
$window = $game.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { Write-Output '0'; exit }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class SoulframeFocus {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr window);

  public static bool Focus(IntPtr window, uint expectedPid) {
    uint owner;
    GetWindowThreadProcessId(window, out owner);
    if (owner != expectedPid) return false;
    if (IsIconic(window)) {
      ShowWindowAsync(window, 9); // SW_RESTORE
      Thread.Sleep(100);
    }
    SetForegroundWindow(window);
    for (int attempt = 0; attempt < 10; attempt++) {
      GetWindowThreadProcessId(GetForegroundWindow(), out owner);
      if (owner == expectedPid) return true;
      Thread.Sleep(20);
    }
    return false;
  }
}
"@
if ([SoulframeFocus]::Focus($window, ${gamePid})) { Write-Output '1' } else { Write-Output '0' }
`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { encoding: 'utf-8', windowsHide: true, timeout: 3000, signal }
      );
      return !signal?.aborted && (stdout || '').trim() === '1';
    } catch (error) {
      this._log('Could not return focus to the game:', error.message);
      return false;
    }
  }

  /** Windows: use tasklist with CSV output */
  async _findProcessWindows() {
    try {
      const { stdout: raw } = await execAsync(`tasklist /FI "IMAGENAME eq ${GAME_EXE_WIN}" /FO CSV /NH`, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 5000,
      });

      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('INFO:')) continue;
        const match = trimmed.match(/"Soulframe\.x64\.exe","(\d+)"/i);
        if (match) return parseInt(match[1], 10);
      }
    } catch { /* no matching process */ }
    return 0;
  }

  /** Linux: scan /proc/PID/comm for the game executable */
  async _findProcessLinux() {
    const callerUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!Number.isSafeInteger(callerUid) || callerUid < 0) return 0;
    try {
      const entries = fs.readdirSync('/proc').filter(e => /^\d+$/.test(e));
      for (const pidStr of entries) {
        try {
          const comm = fs.readFileSync(`/proc/${pidStr}/comm`, 'utf-8').trim().toLowerCase();
          // Linux comm is limited to 15 visible bytes, truncating the .exe name.
          if (isGameProcessName(comm)) {
            const status = fs.readFileSync(`/proc/${pidStr}/status`, 'utf-8');
            const uids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
            if (!uids || !uids.slice(1).every(uid => Number(uid) === callerUid)) continue;
            return parseInt(pidStr, 10);
          }
        } catch { /* permission denied or process gone */ }
      }
    } catch {
      // Fallback: use ps
      try {
        const { stdout: raw } = await execAsync('ps -eo pid,uid,comm --no-headers', { encoding: 'utf-8', timeout: 5000 });
        for (const line of raw.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3 && Number(parts[1]) === callerUid && isGameProcessName(parts[2])) {
            return parseInt(parts[0], 10);
          }
        }
      } catch { /* ignore */ }
    }
    return 0;
  }

  /**
   * Wait until the game process is found.
   * Polls every 2s — no urgency for game launch detection.
   * @returns {Promise<number>} PID, or 0 on an unsupported platform
   */
  async waitForProcess() {
    if (!IS_WIN && !IS_LINUX) return 0;
    this._log(`Waiting for game process (platform: ${os.platform()})...`);
    let attempts = 0;
    while (true) {
      const pid = await this.findProcess();
      attempts++;
      if (pid !== 0) {
        this._log(`Found after ${attempts} poll(s) -- PID ${pid}`);
        return pid;
      }
      if (attempts % 10 === 0) {
        this._log(`Still waiting... (${attempts} polls, ${attempts * 2}s elapsed)`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /**
   * Check if a specific PID is still running.
   * Uses process.kill(pid, 0) — a direct OS syscall, no child process spawned.
   * @param {number} pid
   * @returns {boolean}
   */
  isProcessRunning(pid) {
    try {
      process.kill(pid, 0); // signal 0 = existence check only
      return true;
    } catch (e) {
      // ESRCH = no such process, EPERM = exists but no permission (still alive)
      return e.code === 'EPERM';
    }
  }

  /**
   * Start the persistent foreground-PID monitor.
   * Spawns a single PowerShell process that compiles the P/Invoke type once
   * and then emits the foreground window's PID every ~250 ms.
   * Call this once when the focus-attach feature is enabled.
   */
  startForegroundMonitor() {
    if (this._fgProc) return;       // already running
    if (!IS_WIN) return;

    this._fgPid = 0;                // last-known foreground PID

    const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FG {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
while (\$true) {
  \$h = [FG]::GetForegroundWindow()
  \$p = 0
  if (\$h -ne [IntPtr]::Zero) { [void][FG]::GetWindowThreadProcessId(\$h, [ref]\$p) }
  [Console]::Out.WriteLine(\$p)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 250
}
`;

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

    let buf = '';
    ps.stdout.setEncoding('utf-8');
    ps.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();            // keep incomplete trailing fragment
      for (const ln of lines) {
        const n = parseInt(ln.trim(), 10);
        if (Number.isFinite(n)) this._fgPid = n;
      }
    });

    ps.on('error', () => { this._fgProc = null; });
    ps.on('exit', ()  => { this._fgProc = null; });
    ps.unref();                     // don't prevent Node from exiting

    this._fgProc = ps;
    this._log('Foreground monitor started');
  }

  /** Stop the persistent foreground monitor. */
  stopForegroundMonitor() {
    if (this._fgProc) {
      try { this._fgProc.kill(); } catch { /* already dead */ }
      this._fgProc = null;
    }
    this._fgPid = 0;
  }

  /**
   * Check whether a PID owns the current foreground window.
   * If the persistent monitor is running this is a synchronous in-memory
   * comparison.  Falls back to a one-shot PowerShell call otherwise.
   * Windows-only; returns true on unsupported platforms so the caller can fail open.
   * @param {number} pid
   * @returns {Promise<boolean>}
   */
  async isProcessForeground(pid) {
    if (!IS_WIN) return true;

    // Fast path — persistent monitor is running.
    if (this._fgProc) {
      if (this._fgPid === 0) return true;   // monitor hasn't emitted yet
      return this._fgPid === Number(pid);
    }

    // Slow fallback — spawn a one-shot PowerShell.
    try {
      const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ForegroundWin {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@ -ErrorAction SilentlyContinue | Out-Null

$h = [ForegroundWin]::GetForegroundWindow()
$p = 0
if ($h -ne [IntPtr]::Zero) {
  [void][ForegroundWin]::GetWindowThreadProcessId($h, [ref]$p)
}
Write-Output $p
`;

      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { encoding: 'utf-8', windowsHide: true, timeout: 2500 }
      );

      const fgPid = parseInt((stdout || '').trim(), 10);
      if (!Number.isFinite(fgPid)) return true;
      return fgPid === Number(pid);
    } catch {
      return true;
    }
  }

  // ═══════════════════════════════════════════════════════
  // Network-based online detection (experimental)
  // ═══════════════════════════════════════════════════════

  /**
   * Check if the game process has active (ESTABLISHED) TCP connections.
   * Can be used as a supplementary online/offline signal without reading EE.log.
   *
   * Caveats:
   *   - Connections may persist briefly after logout (TIME_WAIT / CLOSE_WAIT)
   *   - Temporary network hiccups don't mean the player logged out
   *   - Best used in combination with other signals, not as sole indicator
   *
   * @param {number} pid
   * @returns {Promise<boolean>} true if ESTABLISHED TCP connections found
   */
  async hasActiveConnections(pid) {
    if (IS_WIN) return this._checkConnectionsWindows(pid);
    if (IS_LINUX) return this._checkConnectionsLinux(pid);
    return true; // assume online on unsupported platforms
  }

  /** Windows: parse netstat output for ESTABLISHED connections by exact PID */
  async _checkConnectionsWindows(pid) {
    try {
      const { stdout } = await execAsync(
        'netstat -anop TCP',
        { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
      );
      const pidStr = String(pid);
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        // Format: Proto  LocalAddr  ForeignAddr  State  PID
        if (parts.length >= 5 && parts[3] === 'ESTABLISHED' && parts[4] === pidStr) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Linux: use ss to check for ESTABLISHED connections by PID */
  async _checkConnectionsLinux(pid) {
    try {
      const { stdout } = await execAsync(
        `ss -tnp state established | grep "pid=${pid},"`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}

module.exports = { ProcessDetector };
