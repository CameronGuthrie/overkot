/**
 * build-scanner.js — Pre-compiles the optimized C# memory scanner.
 *
 * Flow:
 *   1. Write the C# source (with constants baked in) to a temp file
 *   2. Compile to EXE via csc.exe (/optimize+, no debug)
 *   3. Copy the compiled EXE to the requested output directory
 *   4. Clean up intermediate files
 *
 * The resulting EXE is shipped via extraResources — no runtime compilation
 * and no C# source ever hits the user's disk.
 *
 * Usage:  node scripts/build-scanner.js [--output-dir .build/app/bin]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.build', 'scanner-temp');
const outputFlag = process.argv.indexOf('--output-dir');
if (outputFlag !== -1 && !process.argv[outputFlag + 1]) throw new Error('--output-dir requires a path');
const OUTPUT_DIR = outputFlag === -1 ? path.join(ROOT, 'assets', 'bin') : path.resolve(process.argv[outputFlag + 1]);
if (OUTPUT_DIR !== path.join(ROOT, 'assets', 'bin') && !OUTPUT_DIR.startsWith(path.join(ROOT, '.build') + path.sep)) {
  throw new Error('Scanner output must be assets/bin or inside App/.build');
}

// Scanner constants (must match memoryScanner.js)
const NONCE_MIN_LEN = 5;
const NONCE_MAX_LEN = 20;
const MAX_REPEATED_DIGITS = 5;

// ─── C# source (identical to _getScannerCSharp but with constants resolved) ───
function getScannerSource() {
  return `using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class HostService {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int sz, out int read);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, int len);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct MBI {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    struct Region {
        public long Address;
        public long Size;
    }

    const int NONCE_MIN = ${NONCE_MIN_LEN};
    const int NONCE_MAX = ${NONCE_MAX_LEN};
    const int MAX_REPEAT = ${MAX_REPEATED_DIGITS};

    static bool IsReadable(uint p) {
        return (p & 0x04) != 0 || (p & 0x02) != 0 ||
               (p & 0x20) != 0 || (p & 0x40) != 0 || (p & 0x08) != 0;
    }

    static bool ValidNonce(byte[] buf, int start, int len) {
        if (len < NONCE_MIN || len > NONCE_MAX) return false;
        int run = 1;
        for (int i = 1; i < len; i++) {
            if (buf[start + i] == buf[start + i - 1]) { if (++run >= MAX_REPEAT) return false; }
            else run = 1;
        }
        return true;
    }

    static bool IsNonceTag(byte[] b, int i) {
        return (b[i]   == 0x6E || b[i]   == 0x4E) &&
               (b[i+1] == 0x6F || b[i+1] == 0x4F) &&
               (b[i+2] == 0x6E || b[i+2] == 0x4E) &&
               (b[i+3] == 0x63 || b[i+3] == 0x43) &&
               (b[i+4] == 0x65 || b[i+4] == 0x45) &&
                b[i+5] == 0x3D;
    }

    static bool IsMSI(byte m, byte s, byte i2) {
        return (m  == 0x4D || m  == 0x6D) &&
               (s  == 0x53 || s  == 0x73) &&
               (i2 == 0x49 || i2 == 0x69);
    }

    static bool IsHex(byte b) {
        return (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46);
    }

    static bool IsAccountIdTag(byte[] b, int i) {
        return (b[i]   == 0x61 || b[i]   == 0x41) &&
               (b[i+1] == 0x63 || b[i+1] == 0x43) &&
               (b[i+2] == 0x63 || b[i+2] == 0x43) &&
               (b[i+3] == 0x6F || b[i+3] == 0x4F) &&
               (b[i+4] == 0x75 || b[i+4] == 0x55) &&
               (b[i+5] == 0x6E || b[i+5] == 0x4E) &&
               (b[i+6] == 0x74 || b[i+6] == 0x54) &&
               (b[i+7] == 0x69 || b[i+7] == 0x49) &&
               (b[i+8] == 0x64 || b[i+8] == 0x44) &&
                b[i+9] == 0x3D;
    }

    static bool IsAccountIdTagUTF16(byte[] b, int i) {
        return (b[i]    == 0x61 || b[i]    == 0x41) && b[i+1]  == 0x00 &&
               (b[i+2]  == 0x63 || b[i+2]  == 0x43) && b[i+3]  == 0x00 &&
               (b[i+4]  == 0x63 || b[i+4]  == 0x43) && b[i+5]  == 0x00 &&
               (b[i+6]  == 0x6F || b[i+6]  == 0x4F) && b[i+7]  == 0x00 &&
               (b[i+8]  == 0x75 || b[i+8]  == 0x55) && b[i+9]  == 0x00 &&
               (b[i+10] == 0x6E || b[i+10] == 0x4E) && b[i+11] == 0x00 &&
               (b[i+12] == 0x74 || b[i+12] == 0x54) && b[i+13] == 0x00 &&
               (b[i+14] == 0x69 || b[i+14] == 0x49) && b[i+15] == 0x00 &&
               (b[i+16] == 0x64 || b[i+16] == 0x44) && b[i+17] == 0x00 &&
                b[i+18] == 0x3D                       && b[i+19] == 0x00;
    }

    static void FindNonceASCII(byte[] buf, int length, HashSet<string> found, HashSet<string> foundAccounts) {
        int limit = length - 18;
        for (int i = 0; i <= limit; i++) {
            if (buf[i] != 0x6E && buf[i] != 0x4E) continue;
            if (i + 5 >= length) break;
            if (!IsNonceTag(buf, i)) continue;
            if (i > 0 && buf[i-1] != 0x26 && buf[i-1] != 0x3F) continue;

            int ds = i + 6, de = ds;
            while (de < length && de - ds <= NONCE_MAX && buf[de] >= 0x30 && buf[de] <= 0x39) de++;
            int nLen = de - ds;
            if (nLen < NONCE_MIN || nLen > NONCE_MAX) { i = de > i ? de - 1 : i; continue; }

            if (de + 7 > length) continue;
            if (buf[de] != 0x26) continue;
            if ((buf[de+1] != 0x63 && buf[de+1] != 0x43) ||
                (buf[de+2] != 0x74 && buf[de+2] != 0x54) ||
                 buf[de+3] != 0x3D) continue;
            if (!IsMSI(buf[de+4], buf[de+5], buf[de+6])) continue;

            if (ValidNonce(buf, ds, nLen)) {
                found.Add(Encoding.ASCII.GetString(buf, ds, nLen));
                if (i >= 35 && buf[i-1] == 0x26) {
                    int aOff = i - 35;
                    if (aOff >= 0 && IsAccountIdTag(buf, aOff)) {
                        bool hex = true;
                        for (int h = 0; h < 24; h++) {
                            if (!IsHex(buf[aOff + 10 + h])) { hex = false; break; }
                        }
                        if (hex) foundAccounts.Add(Encoding.ASCII.GetString(buf, aOff + 10, 24).ToLowerInvariant());
                    }
                }
            }
        }
    }

    static void FindNonceUTF16(byte[] buf, int length, HashSet<string> found, HashSet<string> foundAccounts) {
        int limit = length - 36;
        for (int i = 0; i <= limit; i += 2) {
            if (buf[i] != 0x6E && buf[i] != 0x4E) continue;
            if (buf[i+1] != 0x00) continue;
            if (buf[i+3]  != 0x00 || buf[i+5]  != 0x00 || buf[i+7]  != 0x00 ||
                buf[i+9]  != 0x00 || buf[i+11] != 0x00) continue;
            if ((buf[i+2]  != 0x6F && buf[i+2]  != 0x4F) ||
                (buf[i+4]  != 0x6E && buf[i+4]  != 0x4E) ||
                (buf[i+6]  != 0x63 && buf[i+6]  != 0x43) ||
                (buf[i+8]  != 0x65 && buf[i+8]  != 0x45) ||
                 buf[i+10] != 0x3D) continue;
            if (i >= 2 && !((buf[i-2] == 0x26 || buf[i-2] == 0x3F) && buf[i-1] == 0x00)) continue;

            int ds = i + 12, de = ds;
            while (de + 1 < length && (de - ds) / 2 <= NONCE_MAX &&
                   buf[de] >= 0x30 && buf[de] <= 0x39 && buf[de+1] == 0x00) de += 2;
            int nChars = (de - ds) / 2;
            if (nChars < NONCE_MIN || nChars > NONCE_MAX) continue;

            if (de + 14 > length) continue;
            if (buf[de]   != 0x26 || buf[de+1]  != 0x00 ||
                buf[de+3] != 0x00 || buf[de+5]  != 0x00 ||
                buf[de+7] != 0x00 || buf[de+9]  != 0x00 ||
                buf[de+11] != 0x00 || buf[de+13] != 0x00) continue;
            if ((buf[de+2] != 0x63 && buf[de+2] != 0x43) ||
                (buf[de+4] != 0x74 && buf[de+4] != 0x54) ||
                 buf[de+6] != 0x3D) continue;
            if (!IsMSI(buf[de+8], buf[de+10], buf[de+12])) continue;

            bool valid = true;
            int run = 1;
            for (int k = 1; k < nChars; k++) {
                if (buf[ds + k*2] == buf[ds + (k-1)*2]) { if (++run >= MAX_REPEAT) { valid = false; break; } }
                else run = 1;
            }
            if (!valid) continue;

            var sb = new StringBuilder(nChars);
            for (int k = 0; k < nChars; k++) sb.Append((char)buf[ds + k*2]);
            found.Add(sb.ToString());
            if (i >= 70 && buf[i-2] == 0x26 && buf[i-1] == 0x00) {
                int aOff = i - 70;
                if (aOff >= 0 && IsAccountIdTagUTF16(buf, aOff)) {
                    bool hex = true;
                    for (int h = 0; h < 24; h++) {
                        if (!IsHex(buf[aOff + 20 + h*2]) || buf[aOff + 21 + h*2] != 0x00) { hex = false; break; }
                    }
                    if (hex) {
                        var asb = new StringBuilder(24);
                        for (int h = 0; h < 24; h++) asb.Append((char)buf[aOff + 20 + h*2]);
                        foundAccounts.Add(asb.ToString().ToLowerInvariant());
                    }
                }
            }
        }
    }

    static void ScanRegions(IntPtr h, List<Region> regions, byte[] buffer, int chunkSize, ref int scanned, HashSet<string> found, HashSet<string> foundAccounts) {
        byte[] overBuf = new byte[128];
        byte[] bridge  = new byte[256];

        foreach (var region in regions) {
            scanned++;
            long off = 0;
            int overLen = 0;

            while (off < region.Size) {
                int toRead = (int)Math.Min(chunkSize, region.Size - off);
                int bytesRead;
                if (!ReadProcessMemory(h, (IntPtr)(region.Address + off), buffer, toRead, out bytesRead) || bytesRead == 0) {
                    off += 0x1000; overLen = 0; continue;
                }

                if (overLen > 0) {
                    int bLen = Math.Min(128, bytesRead);
                    Array.Copy(overBuf, 0, bridge, 0, overLen);
                    Array.Copy(buffer, 0, bridge, overLen, bLen);
                    int bridgeLen = overLen + bLen;
                    FindNonceASCII(bridge, bridgeLen, found, foundAccounts);
                    FindNonceUTF16(bridge, bridgeLen, found, foundAccounts);
                }

                FindNonceASCII(buffer, bytesRead, found, foundAccounts);
                FindNonceUTF16(buffer, bytesRead, found, foundAccounts);

                if (bytesRead > 128 && off + bytesRead < region.Size) {
                    Array.Copy(buffer, bytesRead - 128, overBuf, 0, 128);
                    overLen = 128;
                } else overLen = 0;

                off += bytesRead;
            }
        }
    }

    public static void Main(string[] args) {
        int pid = int.Parse(args[0]);
        int maxMB = args.Length > 1 ? int.Parse(args[1]) : 4;
        long maxRegion = maxMB * 1024L * 1024L;

        IntPtr h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("ERROR:OPEN"); return; }

        var heapRegions  = new List<Region>();
        var otherRegions = new List<Region>();

        long addr = 0x10000;
        long max  = 0x7FFFFFFFFFFF;
        MBI mbi;

        while (addr < max) {
            int r = VirtualQueryEx(h, (IntPtr)addr, out mbi, Marshal.SizeOf(typeof(MBI)));
            if (r == 0) { addr += 0x1000; continue; }
            long sz = (long)mbi.RegionSize;
            if (mbi.State == 0x1000 && sz > 4096 && sz <= maxRegion && IsReadable(mbi.Protect)) {
                var region = new Region { Address = (long)mbi.BaseAddress, Size = sz };
                if ((mbi.Protect & 0x04) != 0 && mbi.Type == 0x20000)
                    heapRegions.Add(region);
                else
                    otherRegions.Add(region);
            }
            addr = (long)mbi.BaseAddress + sz;
        }

        int total = heapRegions.Count + otherRegions.Count;

        int chunkSize = 1048576;
        byte[] buffer = new byte[chunkSize];
        int scanned = 0;
        var found = new HashSet<string>();
        var foundAccounts = new HashSet<string>();

        ScanRegions(h, heapRegions, buffer, chunkSize, ref scanned, found, foundAccounts);
        ScanRegions(h, otherRegions, buffer, chunkSize, ref scanned, found, foundAccounts);

        CloseHandle(h);

        foreach (var acct in foundAccounts) {
            Console.WriteLine("ACCOUNT:" + acct);
        }
        foreach (var nonce in found) {
            Console.WriteLine("NONCE:" + nonce);
        }
        Console.Error.WriteLine("STATS:heap=" + heapRegions.Count + ",other=" + otherRegions.Count + ",scanned=" + scanned + "/" + total + ",found=" + found.Count + ",accounts=" + foundAccounts.Count);
    }
}`;
}

// ─── Helpers ──────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findCsc() {
  const paths = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('csc.exe not found — .NET Framework 4.x is required to build the scanner');
}

// ─── Main ─────────────────────────────────────────────────

function main() {
  console.log('=== Building scanner EXE ===\n');

  const csc = findCsc();
  console.log(`  csc.exe: ${csc}`);

  // Prepare temp directory
  cleanDir(TEMP_DIR);
  ensureDir(TEMP_DIR);
  ensureDir(OUTPUT_DIR);

  const csPath = path.join(TEMP_DIR, 'hostservice.cs');
  const rawExe = path.join(TEMP_DIR, 'hostservice.exe');

  // Step 1: Write C# source
  console.log('  [1/3] Writing C# source...');
  fs.writeFileSync(csPath, getScannerSource(), 'utf-8');

  // Step 2: Compile
  console.log('  [2/3] Compiling...');
  try {
    execFileSync(csc, ['/nologo', '/optimize+', '/nowin32manifest', `/out:${rawExe}`, csPath], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 30000,
    });
  } catch (e) {
    throw new Error(`Compilation failed: ${e.message}`);
  }
  console.log(`    -> ${rawExe} (${(fs.statSync(rawExe).size / 1024).toFixed(1)} KB)`);

  // Step 3: Ship optimized compiler output directly.
  console.log('  [3/3] Finalizing...');
  const finalExe = path.join(OUTPUT_DIR, 'hostservice.exe');
  fs.copyFileSync(rawExe, finalExe);
  console.log(`    -> ${finalExe} (${(fs.statSync(finalExe).size / 1024).toFixed(1)} KB)`);

  // Clean up temp
  cleanDir(TEMP_DIR);

  // Also remove any leftover .cs files in the output
  const csInOutput = path.join(OUTPUT_DIR, 'hostservice.cs');
  if (fs.existsSync(csInOutput)) fs.unlinkSync(csInOutput);

  console.log('\n=== Scanner build complete ===');
}

try {
  main();
} catch (err) {
  console.error(`\n[FAIL] ${err.message}`);
  // Clean up on failure
  cleanDir(TEMP_DIR);
  process.exit(1);
}
