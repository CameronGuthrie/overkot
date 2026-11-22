#if LINUX
// Linux transport for the shared Windows-image decoder. Wine loads the same PE
// and engine objects; only process discovery, memory reads and mappings differ.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class PlayerPositionReader
{
    static LinuxTarget linuxTarget;

    sealed class LinuxTargetException : Exception
    {
        public readonly string Status;
        public LinuxTargetException(string status) { Status = status; }
    }

    [DllImport("libc", SetLastError = true, EntryPoint = "openat")]
    static extern int ProcOpenAt(int directory, string path, int flags);
    [DllImport("libc", SetLastError = true, EntryPoint = "close")]
    static extern int ProcClose(int descriptor);
    [DllImport("libc", SetLastError = true, EntryPoint = "pread")]
    static extern long ProcRead(int descriptor, [Out] byte[] buffer, UIntPtr count, long offset);
    [DllImport("libc", SetLastError = true, EntryPoint = "fstatfs")]
    static extern int ProcStatFs(int descriptor, [Out] byte[] info);
    [DllImport("libc", EntryPoint = "getuid")]
    static extern uint CallerUid();
    [DllImport("libc", EntryPoint = "geteuid")]
    static extern uint EffectiveUid();

    sealed class LinuxMapping
    {
        public long Start, End, Offset;
        public bool Readable, Writable, Executable;
        public string Name;
    }

    sealed class LinuxTarget : IDisposable
    {
        const int NoFollow = 0x20000, CloseExec = 0x80000;
        const int MaxMapsBytes = 16 * 1024 * 1024;
        int directory = -1, memory = -1, maps = -1;
        public IntPtr Memory { get { return new IntPtr(memory); } }
        public long ImageBase;
        public int ImageSize;
        public string Hash;
        List<LinuxMapping> mappings = new List<LinuxMapping>();
        long mappingsAt;

        static LinuxTargetException AccessError()
        {
            int error = Marshal.GetLastWin32Error();
            return new LinuxTargetException(error == 1 || error == 13 ? "permission-denied" :
                error == 2 || error == 3 ? "process-gone" : "scan-failed");
        }

        int OpenAt(string name)
        {
            int descriptor = ProcOpenAt(directory, name, NoFollow | CloseExec);
            if (descriptor < 0) throw AccessError();
            return descriptor;
        }

        static string Text(int descriptor, int maximum)
        {
            byte[] bytes = new byte[8192];
            var result = new StringBuilder();
            long offset = 0;
            while (true)
            {
                long count = ProcRead(descriptor, bytes, new UIntPtr((uint)bytes.Length), offset);
                if (count < 0) throw AccessError();
                if (count == 0) return result.ToString();
                offset += count;
                if (offset > maximum) throw new LinuxTargetException("scan-failed");
                result.Append(Encoding.UTF8.GetString(bytes, 0, (int)count));
            }
        }

        void ValidateTarget(int expectedPid)
        {
            uint uid = CallerUid();
            if (uid == 0 || uid != EffectiveUid()) throw new LinuxTargetException("wrong-process");
            int descriptor = OpenAt("status");
            string status;
            try { status = Text(descriptor, 65536); } finally { ProcClose(descriptor); }
            Match owner = Regex.Match(status, @"(?m)^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", RegexOptions.CultureInvariant);
            if (!owner.Success) throw new LinuxTargetException("wrong-process");
            for (int i = 1; i <= 4; i++)
                if (owner.Groups[i].Value != uid.ToString(Invariant)) throw new LinuxTargetException("wrong-process");
            Match identity = Regex.Match(status, @"(?m)^Pid:\s+(\d+)\s*$", RegexOptions.CultureInvariant);
            if (!identity.Success || identity.Groups[1].Value != expectedPid.ToString(Invariant))
                throw new LinuxTargetException("wrong-process");
            descriptor = OpenAt("comm");
            string name;
            try { name = Text(descriptor, 256).TrimEnd('\r', '\n'); } finally { ProcClose(descriptor); }
            if (!string.Equals(name, "Soulframe.x64.e", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(name, "Soulframe.x64.exe", StringComparison.OrdinalIgnoreCase))
                throw new LinuxTargetException("wrong-process");
        }

        public static LinuxTarget Open(int pid)
        {
            var target = new LinuxTarget();
            try
            {
                // The single-threaded C launcher opens these game descriptors,
                // drops every capability, then execs this unprivileged core.
                // NativeAOT runtime threads therefore never inherit capabilities.
                string inherited = Environment.GetEnvironmentVariable("OVERKOT_POSITION_READER_FDS");
                Environment.SetEnvironmentVariable("OVERKOT_POSITION_READER_FDS", null);
                if (inherited != "3,4,5") throw new LinuxTargetException("invalid-arguments");
                target.directory = 3; target.maps = 4; target.memory = 5;
                // fstatfs writes a platform struct; its first native word is f_type.
                // This helper is published for linux-x64 only.
                foreach (int descriptor in new int[] { target.directory, target.maps, target.memory })
                {
                    byte[] filesystem = new byte[256];
                    if (ProcStatFs(descriptor, filesystem) != 0) throw AccessError();
                    if (BitConverter.ToInt64(filesystem, 0) != 0x9fa0) throw new LinuxTargetException("wrong-process");
                }
                target.ValidateTarget(pid);
                target.RefreshMappings(true);
                target.FindImage();
                return target;
            }
            catch { target.Dispose(); throw; }
        }

        public void RefreshMappings(bool force = false)
        {
            long now = Environment.TickCount64;
            if (!force && mappings.Count > 0 && now - mappingsAt < 250) return;
            var next = new List<LinuxMapping>();
            foreach (string line in Text(maps, MaxMapsBytes).Split('\n'))
            {
                if (line.Length == 0) continue;
                Match match = Regex.Match(line, @"^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]{4})\s+([0-9a-f]+)\s+\S+\s+\d+\s*(.*)$",
                    RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
                long start, end, offset;
                if (!match.Success || !long.TryParse(match.Groups[1].Value, NumberStyles.HexNumber, Invariant, out start) ||
                    !long.TryParse(match.Groups[2].Value, NumberStyles.HexNumber, Invariant, out end) ||
                    !long.TryParse(match.Groups[4].Value, NumberStyles.HexNumber, Invariant, out offset) || start < 0 || end <= start) continue;
                string permissions = match.Groups[3].Value;
                next.Add(new LinuxMapping { Start = start, End = end, Offset = offset,
                    Readable = permissions[0] == 'r', Writable = permissions[1] == 'w', Executable = permissions[2] == 'x', Name = match.Groups[5].Value });
                if (next.Count > 65536) throw new LinuxTargetException("scan-failed");
            }
            mappings = next; mappingsAt = now;
        }

        bool Read(long address, byte[] bytes)
        {
            return ProcRead(memory, bytes, new UIntPtr((uint)bytes.Length), address) == bytes.Length;
        }

        void FindImage()
        {
            ImageProfile found = null;
            foreach (LinuxMapping map in mappings)
            {
                // Wine's Linux main executable is wine/preloader, not the game.
                // Locate its actual mapped Windows image instead.
                if (!map.Readable || map.Offset != 0 || !Regex.IsMatch(map.Name,
                    @"(?:^|/)Soulframe\.x64\.exe(?: \(deleted\))?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)) continue;
                byte[] headers = new byte[4096];
                if (!Read(map.Start, headers)) continue;
                int pe = BitConverter.ToInt32(headers, 0x3c);
                if (pe < 64 || pe > headers.Length - 264) continue;
                int size = BitConverter.ToInt32(headers, pe + 80);
                ImageProfile candidate = ImageProfile.Headers(headers, map.Start, size);
                if (candidate == null) continue;
                if (found != null) throw new LinuxTargetException("ambiguous");
                found = candidate;
            }
            if (found == null) throw new LinuxTargetException("unsupported-build");
            ImageBase = found.Base; ImageSize = found.Size;
            // Hash only verified, readable PE sections. No filesystem path from
            // the target is opened, and unmapped PE padding is never read.
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                hash.AppendData(found.Bytes, 0, 4096);
                foreach (Region section in new Region[] {
                    new Region { Address = found.Code, Size = found.CodeSize },
                    new Region { Address = found.Data, Size = found.DataSize } })
                {
                    for (long offset = 0; offset < section.Size; offset += ChunkBytes)
                    {
                        byte[] bytes = new byte[(int)Math.Min(ChunkBytes, section.Size - offset)];
                        if (!Read(ImageBase + section.Address + offset, bytes)) throw new LinuxTargetException("profile-mismatch");
                        hash.AppendData(bytes);
                    }
                }
                Hash = BitConverter.ToString(hash.GetHashAndReset()).Replace("-", "").ToLowerInvariant();
            }
        }

        public bool Query(long address, out MemoryRegion info)
        {
            RefreshMappings();
            info = new MemoryRegion();
            // Binary search also returns the next mapping across a free range,
            // matching VirtualQueryEx enumeration without scanning Wine gaps.
            int low = 0, high = mappings.Count;
            while (low < high) { int middle = low + (high - low) / 2; if (mappings[middle].End <= address) low = middle + 1; else high = middle; }
            if (low == mappings.Count) return false;
            LinuxMapping map = mappings[low];
            if (address < map.Start)
            {
                info.Address = new IntPtr(address); info.Size = new UIntPtr((ulong)(map.Start - address));
                return true;
            }
            info.Address = new IntPtr(map.Start); info.AllocationAddress = info.Address;
            info.Size = new UIntPtr((ulong)(map.End - map.Start)); info.State = 0x1000;
            info.Protection = !map.Readable ? 1u : map.Writable ? 4u : 2u;
            info.Type = map.Start >= ImageBase && map.End <= ImageBase + ImageSize ? 0x1000000u : 0x20000u;
            return true;
        }

        public void Dispose()
        {
            if (memory >= 0) ProcClose(memory);
            if (maps >= 0) ProcClose(maps);
            if (directory >= 0) ProcClose(directory);
            memory = maps = directory = -1;
        }
    }

    static bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read)
    {
        long count = ProcRead(process.ToInt32(), buffer, size, address.ToInt64());
        read = new UIntPtr((ulong)Math.Max(0, count));
        if (count < 0)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 1 || error == 13) throw new LinuxTargetException("permission-denied");
            if (error == 3) throw new LinuxTargetException("process-gone");
        }
        return count == (long)size.ToUInt64();
    }

    static UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryRegion info, UIntPtr size)
    {
        return linuxTarget.Query(address.ToInt64(), out info) ? size : UIntPtr.Zero;
    }
}
#endif
