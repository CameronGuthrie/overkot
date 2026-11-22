'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// Drive the same pass used by the helper with synthetic work and a tiny
// budget. No game process, process memory, or wall-clock timeout is needed.
const harness = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;

internal static partial class PlayerPositionReader {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protection);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool VirtualFree(IntPtr address, UIntPtr size, uint type);
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void TestDeviceMemory() {
        foreach (uint kind in new uint[]{ 0x20000, 0x40000 })
        foreach (uint writable in new uint[]{ 4, 8, 0x40, 0x80 }) {
            var region = new MemoryRegion { State = 0x1000, Type = kind, Protection = writable };
            Check(ClassifyHeap(region) == HeapRegionKind.Eligible, "ordinary private or mapped heap");
            foreach (uint modifier in new uint[]{ 0x200, 0x400 }) {
                region.Protection = writable | modifier; region.AllocationProtection = writable;
                Check(ClassifyHeap(region) == HeapRegionKind.Device, "current cache policy");
                region.Protection = writable; region.AllocationProtection = writable | modifier;
                Check(ClassifyHeap(region) == HeapRegionKind.Device, "initial cache policy");
            }
        }
        var guarded = new MemoryRegion { State = 0x1000, Type = 0x20000, Protection = 0x304 };
        Check(ClassifyHeap(guarded) == HeapRegionKind.Other, "guarded pages are not counted as skipped device bytes");
        using (var process = Process.GetCurrentProcess())
        using (var reader = new Reader(process)) {
            MethodInfo inspect = typeof(Reader).GetMethod("InspectChunk", BindingFlags.Instance | BindingFlags.NonPublic);
            MethodInfo readable = typeof(Reader).GetMethod("DynamicReadable", BindingFlags.Instance | BindingFlags.NonPublic);
            var pass = new DiscoveryPass(new List<Region>());
            for (int i = 0; i < 17; i++) pass.Add(i + 1); // InspectChunk still reads eligible pages but skips object decoding.
            foreach (uint protection in new uint[]{ 4, 0x204, 0x404 }) {
                const int length = 65536;
                IntPtr memory = VirtualAlloc(IntPtr.Zero, new UIntPtr(length), 0x3000, protection);
                if (memory == IntPtr.Zero) {
                    int error = Marshal.GetLastWin32Error();
                    if (protection != 4 && (error == 50 || error == 87)) {
                        Console.Error.WriteLine("Host does not support the cache-modified allocation: " + protection);
                        continue;
                    }
                    throw new Exception("fixture allocation failed: " + error);
                }
                try {
                    long address = memory.ToInt64();
                    var plan = (DiscoveryPass)typeof(Reader).GetMethod("PlanDiscovery", BindingFlags.Instance | BindingFlags.NonPublic)
                        .Invoke(reader, null);
                    var regions = (List<Region>)typeof(DiscoveryPass).GetField("regions", BindingFlags.Instance | BindingFlags.NonPublic)
                        .GetValue(plan);
                    Check(regions.Exists(r => address >= r.Address && address < r.Address + r.Size) == (protection == 4),
                        "enumeration cache eligibility: " + protection);
                    if (protection != 4) Check(plan.SkippedDeviceBytes >= length, "device pages counted in the plan");
                    int read = (int)inspect.Invoke(reader, new object[]{ address, length, pass });
                    Check(read == (protection == 4 ? length : 0), "read cache-modified pages: " + protection);
                    Check((bool)readable.Invoke(reader, new object[]{ address, 0x150 }) == (protection == 4),
                        "header cache eligibility: " + protection);
                } finally { VirtualFree(memory, UIntPtr.Zero, 0x8000); }
            }
        }
    }
    public static void TestDiscovery() {
        TestDeviceMemory();
        var regions = new List<Region> {
            new Region { Address = 1000, Size = 24 }, new Region { Address = 2000, Size = 40 }
        };
        var pass = new DiscoveryPass(regions, 65536);
        var visited = new HashSet<long>();
        Func<long, int, int> inspect = delegate(long start, int count) {
            for (int i = 0; i < count; i++) {
                long at = start + i;
                Check(visited.Add(at), "visited a prefix twice");
                if (at == 1004 || at == 2038) pass.Add(at);
            }
            // Model a short OS read too: progress uses traversed work while
            // bytesScanned only reports bytes actually read.
            return count - 1;
        };
        pass.RunSlice(16, () => true, inspect);
        Check(visited.Count == 0 && pass.Progress == 0, "paused before reading");
        for (int slice = 1; slice <= 4; slice++) {
            pass.RunSlice(16, () => false, inspect);
            Check(visited.Count == slice * 16, "slice budget or resume cursor");
            if (slice < 4) {
                Check(!pass.Complete && pass.Progress == slice * 25, "progress");
                Check(pass.SelectPlayer(p => { throw new Exception("validated partial pass"); }) == 0, "partial player");
                Status("searching", "", pass.Count, pass.BytesRead, false, pass.Progress, pass);
            }
        }
        Check(pass.Complete && pass.BytesRead == 59 && pass.Count == 2, "final coverage");
        Check(pass.SelectPlayer(p => true) == 0, "ambiguous across slices");
        Check(pass.SelectPlayer(p => p == 2038) == 2038, "revalidate stale early candidate");
        Check(pass.SelectPlayer(p => false) == 0 && pass.Count == 0, "all candidates expired");

        var loading = new DiscoveryPass(regions);
        loading.RunSlice(24, () => false, delegate(long start, int count) {
            loading.Defer(1016); loading.Defer(1016);
            return count;
        });
        Check(loading.Count == 0 && loading.Contains(1016), "unready header is retained without counting as a pose");
        Check(loading.SelectPlayer(p => { throw new Exception("validated pending header too early"); }) == 0, "partial pass");
        loading.RunSlice(40, () => false, delegate(long start, int count) {
            loading.Add(2032); return count;
        });
        Check(loading.SelectPlayer(p => true) == 0 && loading.Count == 2, "newly ready player competes with existing candidate");
        Check(loading.SelectPlayer(p => p == 1016) == 1016, "only the fresh unique player survives");

        var crowded = new DiscoveryPass(new List<Region>());
        for (int i = 1; i <= 2000; i++) crowded.Defer(i);
        Check(crowded.Complete && crowded.AmbiguousOverflow && crowded.Count == 0 && !crowded.Contains(2000), "bounded pending evidence");
        Check(crowded.SelectPlayer(p => p == 1) == 0, "untracked pending headers cannot grant a player");

        var overflow = new DiscoveryPass(new List<Region> { new Region { Address = 1, Size = 1 } });
        overflow.RunSlice(1, () => false, delegate(long start, int count) {
            for (int i = 1; i <= 100; i++) overflow.Add(i);
            return count;
        });
        Check(overflow.Complete && overflow.Count == 17 && overflow.AmbiguousOverflow, "bounded candidate evidence");
        Check(overflow.SelectPlayer(p => p == 1) == 0, "overflow cannot grant a player");
        var empty = new DiscoveryPass(new List<Region>());
        Check(empty.Complete && !empty.Progress.HasValue && empty.SelectPlayer(p => true) == 0, "empty pass");
    }
}
internal static class DiscoveryTests {
    static void Main() { PlayerPositionReader.TestDiscovery(); }
}`;

test('native discovery resumes bounded slices and only selects a fresh unique player after full coverage',
  { skip: process.platform !== 'win32' }, () => {
    const dir = path.join(root, '.build', 'position-discovery-tests');
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(dir, 'discovery.cs'), executable = path.join(dir, 'discovery.exe');
    fs.writeFileSync(source, harness);
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:DiscoveryTests', `/out:${executable}`,
      path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), source],
    { windowsHide: true, stdio: 'pipe' });
    const output = execFileSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const statuses = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(statuses.map(s => s.scanProgress), [25, 50, 75]);
    assert.ok(statuses.every(s => s.type === 'status' && s.status === 'searching' && s.scanCompleted === false));
    assert.ok(statuses.every(s => s.plannedScanBytes === 64 && s.skippedDeviceBytes === 65536));
  });
