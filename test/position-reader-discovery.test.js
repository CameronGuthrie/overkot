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

internal static partial class PlayerPositionReader {
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    public static void TestDiscovery() {
        var regions = new List<Region> {
            new Region { Address = 1000, Size = 24 }, new Region { Address = 2000, Size = 40 }
        };
        var pass = new DiscoveryPass(regions);
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
                Status("scan-incomplete", "", pass.Count, pass.BytesRead, false, pass.Progress);
            }
        }
        Check(pass.Complete && pass.BytesRead == 59 && pass.Count == 2, "final coverage");
        Check(pass.SelectPlayer(p => true) == 0, "ambiguous across slices");
        Check(pass.SelectPlayer(p => p == 2038) == 2038, "revalidate stale early candidate");
        Check(pass.SelectPlayer(p => false) == 0 && pass.Count == 0, "all candidates expired");

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
    assert.ok(statuses.every(s => s.type === 'status' && s.status === 'scan-incomplete' && s.scanCompleted === false));
  });
