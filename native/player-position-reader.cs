// Read-only local player telemetry. Resolve each running image before reading objects.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;

internal static partial class PlayerPositionReader
{
    const int MaximumImageBytes = 96 * 1024 * 1024;
    const int ChunkBytes = 1024 * 1024;
    const long MaximumScanBytes = 32L * 1024 * 1024 * 1024;
    const int MaximumScanSeconds = 45;
    const uint ReadAccess = 0x0400 | 0x0010;
    static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    static string activeHash;

#if !LINUX
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryRegion info, UIntPtr size);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
#endif

    [StructLayout(LayoutKind.Sequential)]
    struct MemoryRegion
    {
        public IntPtr Address;
        public IntPtr AllocationAddress;
        public uint AllocationProtection;
        public UIntPtr Size;
        public uint State;
        public uint Protection;
        public uint Type;
    }

    struct Region
    {
        public long Address;
        public long Size;
    }

    // One pass belongs to one verified game process. Keep its work position
    // between budget slices; only a finished pass can select a player.
    sealed class DiscoveryPass
    {
        const int MaximumCandidates = 16;
        readonly List<Region> regions;
        readonly HashSet<long> candidates = new HashSet<long>();
        readonly long total;
        int index;
        long offset, visited;
        public long BytesRead { get; private set; }
        public int Count { get { return candidates.Count; } }
        public bool AmbiguousOverflow { get { return Count > MaximumCandidates; } }
        public bool Complete { get { return index == regions.Count; } }
        public int? Progress { get { return total == 0 ? (int?)null : (int)Math.Min(99, visited * 100 / total); } }

        public DiscoveryPass(List<Region> regions)
        {
            this.regions = regions;
            foreach (Region region in regions) total += region.Size;
        }
        public bool Contains(long player) { return candidates.Contains(player); }
        public void Add(long player) { if (!AmbiguousOverflow) candidates.Add(player); }

        public void RunSlice(long byteBudget, Func<bool> pause, Func<long, int, int> inspect)
        {
            long start = visited;
            while (!Complete && visited - start < byteBudget && !pause())
            {
                Region region = regions[index];
                int length = (int)Math.Min(Math.Min(ChunkBytes, byteBudget - (visited - start)), region.Size - offset);
                BytesRead += inspect(region.Address + offset, length);
                visited += length;
                offset += length;
                if (offset == region.Size) { index++; offset = 0; }
            }
        }

        public long SelectPlayer(Predicate<long> stillValid)
        {
            if (!Complete || AmbiguousOverflow) return 0;
            candidates.RemoveWhere(candidate => !stillValid(candidate));
            if (Count == 1) foreach (long candidate in candidates) return candidate;
            return 0;
        }
    }

    sealed class Pose
    {
        public float[] Position;
        public float[] Quaternion;
        public float[] Forward;
        public float[] CameraForward;
        public long AvatarVtableRva;
        public float[] LocalPosition;
        public double Heading;
        public List<DungeonRoot> DungeonRoots;
        public List<float[]> DungeonFrames;
        public long DungeonFramesTimestamp;
    }

    sealed class DungeonRoot
    {
        public string LevelPath;
        public float[] Matrix;
    }

    sealed class WorldDrop
    {
        public long Entity;
        public string Id, ItemType;
        public float[] Position;
        public double DistanceSquared;
        public bool? Shiny;
    }

    sealed class WorldDrops
    {
        public bool Available;
        public long Timestamp;
        public List<WorldDrop> Items = new List<WorldDrop>();
    }

    // Registration names and instruction semantics survive linker reordering and
    // ASLR. No addresses, executable hashes or recovered profiles are persisted.
    sealed class ImageProfile
    {
        public byte[] Bytes;
        public long Base;
        public int Size, Code, CodeSize, Data, DataSize, Metadata, MetadataSize;
        public long PlayerType, PlayerVtable, ContextType, ContextVtable, RegionType, RegionVtable, LevelInfoType;
        public long DropType, DropVtable, StoreItemType, StoreItemVtable, WeaponType, AtomTable;
        public long ResourceManager;
        public WorldDropShiny ShinyProfile;
        public int StoreReferenceOffset, StoreWeaponOffset;
        public bool DropsSupported;

        public static ImageProfile Headers(byte[] headers, long moduleBase, int size)
        {
            if (size < 4096 || size > MaximumImageBytes || moduleBase < 0x10000 || moduleBase > long.MaxValue - size || headers.Length < 4096 ||
                BitConverter.ToUInt16(headers, 0) != 0x5a4d) return null;
            int pe = BitConverter.ToInt32(headers, 0x3c);
            if (pe < 64 || pe > headers.Length - 264 || BitConverter.ToUInt32(headers, pe) != 0x4550 ||
                BitConverter.ToUInt16(headers, pe + 4) != 0x8664 || BitConverter.ToUInt16(headers, pe + 24) != 0x20b ||
                BitConverter.ToInt32(headers, pe + 80) != size) return null;
            int count = BitConverter.ToUInt16(headers, pe + 6), section = pe + 24 + BitConverter.ToUInt16(headers, pe + 20);
            if (count < 1 || count > 32 || section < pe + 264 || section > headers.Length - count * 40) return null;
            var profile = new ImageProfile { Base = moduleBase, Size = size };
            var ranges = new List<Region>();
            for (int i = 0; i < count; i++)
            {
                int offset = section + i * 40, length = BitConverter.ToInt32(headers, offset + 8), start = BitConverter.ToInt32(headers, offset + 12);
                if (start < 4096 || length < 1 || length > size || start > size - length) return null;
                foreach (Region range in ranges) if (start < range.Address + range.Size && start + length > range.Address) return null;
                ranges.Add(new Region { Address = start, Size = length });
                string name = System.Text.Encoding.ASCII.GetString(headers, offset, 8).TrimEnd('\0');
                uint flags = BitConverter.ToUInt32(headers, offset + 36);
                if (name == ".text" && (flags & 0xe0000000) == 0x60000000) { if (profile.Code != 0) return null; profile.Code = start; profile.CodeSize = length; }
                if (name == ".rdata" && (flags & 0xe0000000) == 0x40000000) { if (profile.Data != 0) return null; profile.Data = start; profile.DataSize = length; }
                if (name == ".data" && (flags & 0xe0000000) == 0xc0000000) { if (profile.Metadata != 0) return null; profile.Metadata = start; profile.MetadataSize = length; }
            }
            if (profile.Code == 0 || profile.Data == 0 || profile.Metadata == 0) return null;
            profile.Bytes = new byte[size];
            Buffer.BlockCopy(headers, 0, profile.Bytes, 0, 4096);
            return profile;
        }

        bool In(long address, int start, int size) { return address >= Base + start && address < Base + start + size; }
        public bool IsCode(long address) { return In(address, Code, CodeSize); }
        public bool IsData(long address) { return In(address, Data, DataSize); }
        public bool IsMetadata(long address) { return In(address, Metadata, MetadataSize); }
        long Pointer(long address) { return address >= Base && address <= Base + Bytes.Length - 8 ? BitConverter.ToInt64(Bytes, (int)(address - Base)) : 0; }
        long Relative(int instruction) { return Base + instruction + 7 + BitConverter.ToInt32(Bytes, instruction + 3); }
        bool Match(int offset, params byte[] expected)
        {
            if (offset < 0 || offset > Bytes.Length - expected.Length) return false;
            for (int i = 0; i < expected.Length; i++) if (Bytes[offset + i] != expected[i]) return false;
            return true;
        }
        long UniqueCode(params byte[] expected)
        {
            long result = 0;
            for (int i = Code; i <= Code + CodeSize - expected.Length; i++) if (Bytes[i] == expected[0] && Match(i, expected))
            {
                if (result != 0) return 0;
                result = Base + i;
            }
            return result;
        }
        bool Vtable(long address)
        {
            if (!IsData(address) || !IsData(address + 0x260) || (address & 7) != 0) return false;
            for (int i = 0; i < 12; i++) if (!IsCode(Pointer(address + i * 8))) return false;
            return true;
        }

        sealed class Registration { public long Type, Parent, Factory, Constructor, NameFunction; }
        Registration NamedType(string name)
        {
            byte[] literal = System.Text.Encoding.ASCII.GetBytes(name + "\0");
            var strings = new HashSet<long>();
            for (int i = Data; i <= Data + DataSize - literal.Length; i++)
                if (Bytes[i] == literal[0] && Bytes[i - 1] == 0 && Match(i, literal)) strings.Add(Base + i);
            Registration found = null;
            for (int i = Code; i + 0x5c < Code + CodeSize; i++)
            {
                if (Bytes[i] != 0x48 || Bytes[i + 1] != 0x8d || Bytes[i + 2] != 0x15 || !strings.Contains(Relative(i)) ||
                    !Match(i + 7, 0x48, 0x8d, 0x4c, 0x24, 0x50, 0xe8) ||
                    !Match(i + 0x2c, 0x48, 0x8d, 0x0d) || !Match(i + 0x3b, 0x4c, 0x8d, 0x0d) ||
                    !Match(i + 0x4c, 0x48, 0x8d, 0x0d) || !Match(i + 0x53, 0xc6, 0x44, 0x24, 0x20, 0x00, 0xe8)) continue;
                var entry = new Registration { Type = Relative(i + 0x4c), Parent = Relative(i + 0x3b), Factory = Relative(i + 0x2c),
                    Constructor = Base + i + 0x5d + BitConverter.ToInt32(Bytes, i + 0x59),
                    NameFunction = Base + i + 17 + BitConverter.ToInt32(Bytes, i + 13) };
                if (!IsMetadata(entry.Type) || !IsMetadata(entry.Type + 0x20) || (entry.Type & 7) != 0 ||
                    !IsMetadata(entry.Parent) || Pointer(entry.Type + 0x18) != entry.Parent ||
                    !IsData(Pointer(entry.Type)) || !IsCode(Pointer(Pointer(entry.Type))) ||
                    !IsCode(entry.Factory) || !IsCode(entry.Constructor)) continue;
                if (found != null && (found.Type != entry.Type || found.Parent != entry.Parent || found.Factory != entry.Factory || found.Constructor != entry.Constructor)) return null;
                found = entry;
            }
            return found;
        }
        long FactoryVtable(Registration entry)
        {
            long function = entry.Factory;
            // Factories may be linker tail-jump thunks. Follow only bounded code.
            for (int i = 0; i < 4 && IsCode(function) && Bytes[(int)(function - Base)] == 0xe9; i++)
            {
                if (!IsCode(function + 4)) return 0;
                function = function + 5 + BitConverter.ToInt32(Bytes, (int)(function - Base) + 1);
            }
            if (!IsCode(function) || !IsCode(function + 128) || Bytes[(int)(function - Base)] == 0xe9) return 0;
            int start = (int)(function - Base);
            long found = 0;
            for (int i = start; i < start + 112; i++)
            {
                if (!Match(i, 0x48, 0x8d, 0x05) || !Vtable(Relative(i))) continue;
                for (int j = i + 7; j <= i + 12; j++)
                    if (Match(j, 0x48, 0x89, 0x03) || Match(j, 0x48, 0x89, 0x06) || Match(j, 0x48, 0x89, 0x07))
                    {
                        long value = Relative(i);
                        if (found != 0 && found != value) return 0;
                        found = value;
                    }
            }
            return found;
        }
        public bool Resolve()
        {
            Registration human = NamedType("HumanPlayer"), player = NamedType("SFHumanPlayer"), context = NamedType("ContextImpl"),
                region = NamedType("RegionMgrImpl"), level = NamedType("LevelInfo");
            if (human == null || player == null || context == null || region == null || level == null || player.Parent != human.Type) return false;
            foreach (Registration entry in new Registration[] { player, context, region, level })
                if (entry.Constructor != human.Constructor || Pointer(entry.Type) != Pointer(human.Type)) return false;
            PlayerType = player.Type; ContextType = context.Type; RegionType = region.Type; LevelInfoType = level.Type;
            PlayerVtable = FactoryVtable(player); ContextVtable = FactoryVtable(context); RegionVtable = FactoryVtable(region);
            if (PlayerVtable == 0 || ContextVtable == 0 || RegionVtable == 0) return false;
            // The object offsets remain supported only while their getter bodies
            // agree. Relocations are decoded separately, never wildcarded broadly.
            long avatar = UniqueCode(0x48, 0x8b, 0x81, 0x48, 0x01, 0x00, 0x00, 0x48, 0x8b, 0x00, 0xc3);
            long camera = UniqueCode(0x48, 0x8b, 0x81, 0xd0, 0x00, 0x00, 0x00, 0x48, 0x8b, 0x00, 0x48, 0x85, 0xc0, 0x75, 0x02, 0xcd, 0x2c, 0xc3);
            long local = UniqueCode(0x48, 0x8d, 0x41, 0x70, 0xc3);
            long count = UniqueCode(0x8b, 0x81, 0x08, 0x02, 0x00, 0x00, 0x48, 0xc1, 0xe8, 0x03, 0xc3);
            long worldPosition = UniqueCode(0x48, 0x8d, 0x81, 0xd0, 0x00, 0x00, 0x00, 0xc3);
            long worldMatrix = UniqueCode(0xcc, 0x48, 0x8d, 0x81, 0xa0, 0x00, 0x00, 0x00, 0xc3);
            bool supported = avatar != 0 && camera != 0 && local != 0 && count != 0 && worldPosition != 0 && worldMatrix != 0 &&
                Pointer(RegionVtable + 0x258) == count;
            // Ground-item support is independently optional. Its registration or
            // getter changing must never disable the established player profile.
            if (supported) ResolveDrops();
            return supported;
        }

        void ResolveDrops()
        {
            Registration drop = NamedType("StoreItemPickUp"), pickup = NamedType("PickUp"),
                store = NamedType("SFWeaponStoreItem"), weapon = NamedType("SFWeapon");
            if (drop == null || pickup == null || store == null || weapon == null || drop.Parent != pickup.Type) return;
            long dropVtable = FactoryVtable(drop), storeVtable = FactoryVtable(store);
            if (dropVtable == 0 || storeVtable == 0 || !IsData(dropVtable + 0x5b0)) return;
            long generator = Pointer(dropVtable + 0x5b0);
            if (!IsCode(generator) || !IsCode(generator + 0x140)) return;
            int referenceOffset = 0, weaponOffset = 0, start = (int)(generator - Base);
            // The pickup's own item-info generator dereferences its StoreItem
            // reference and reads that instance's weapon type. Recover the field
            // displacements from those instructions, rather than asset names.
            for (int i = start; i < start + 0x50; i++)
                if (Match(i, 0x48, 0x8b, 0x81) && Match(i + 7, 0x48, 0x8b, 0x10, 0x48, 0x85, 0xd2, 0x0f, 0x84) &&
                    Match(i + 19, 0x48, 0x8b, 0x52))
                {
                    if (referenceOffset != 0) return;
                    referenceOffset = BitConverter.ToInt32(Bytes, i + 3); weaponOffset = Bytes[i + 22];
                }
            if (referenceOffset < 0x300 || referenceOffset > 0x2000 || (referenceOffset & 7) != 0 || weaponOffset < 0x10 || (weaponOffset & 7) != 0) return;
            long nameFunction = drop.NameFunction;
            if (!IsCode(nameFunction) || !IsCode(nameFunction + 0x24)) return;
            int atom = (int)(nameFunction - Base);
            if (!Match(atom, 0x48, 0x89, 0x5c, 0x24, 0x08, 0x57, 0x48, 0x83, 0xec, 0x20) || Bytes[atom + 0x1e] != 0xe8) return;
            long intern = Base + atom + 0x23 + BitConverter.ToInt32(Bytes, atom + 0x1f);
            if (!IsCode(intern) || !IsCode(intern + 0x260)) return;
            long table = 0;
            for (int i = (int)(intern - Base); i < intern - Base + 0x260; i++)
                if (Match(i, 0x48, 0x8b, 0x05) && Match(i + 7, 0x0f, 0xb7, 0xd1, 0x48, 0xc1, 0xe2, 0x04,
                    0x48, 0xc1, 0xe9, 0x10, 0x48, 0x03, 0x0c, 0x02))
                {
                    long candidate = Relative(i);
                    if (!IsMetadata(candidate) || (table != 0 && table != candidate)) return;
                    table = candidate;
                }
            if (table == 0) return;
            DropType = drop.Type; DropVtable = dropVtable; StoreItemType = store.Type;
            StoreItemVtable = storeVtable; WeaponType = weapon.Type; AtomTable = table;
            StoreReferenceOffset = referenceOffset; StoreWeaponOffset = weaponOffset;
            DropsSupported = true;
            if (WorldDropShiny.TryCreate(Bytes, Base, RegionVtable, DropVtable, out ShinyProfile))
                ResourceManager = ShinyProfile.ResourceManager;
        }
    }

    sealed class RootRefreshGate
    {
        readonly object sync = new object();
        bool pending, running;
        long nextAllowed;
        public void Request() { lock (sync) pending = true; }
        public bool TryStart(long milliseconds)
        {
            lock (sync)
            {
                if (!pending || running || milliseconds < nextAllowed) return false;
                pending = false; running = true; nextAllowed = milliseconds + 30000;
                return true;
            }
        }
        public void Complete() { lock (sync) running = false; }
    }

    sealed class Reader : IDisposable
    {
        public readonly IntPtr Handle;
        public readonly long ModuleBase;
        readonly int moduleImageSize;
        public readonly Process Process;
        public readonly string StartTicks;
        readonly byte[] smallBuffer = new byte[256];
        readonly byte[] scanBuffer = new byte[ChunkBytes];
        DiscoveryPass discovery;
        readonly HashSet<long> playerTypes = new HashSet<long>();
        ImageProfile profile;
        readonly Stopwatch frameClock = Stopwatch.StartNew();
        long frameContext, frameRegion, frameTable, nextFramesAt, framesTimestamp;
        List<float[]> frames = new List<float[]>();
        Dictionary<long, string> dropIds = new Dictionary<long, string>();
        sealed class ResourceReference { public long Handle, Instance, Row; }
        sealed class ResourceSnapshot
        {
            public uint Bytes;
            public List<ResourceReference> References = new List<ResourceReference>();
        }
        readonly Dictionary<long, ResourceSnapshot> resourceCache = new Dictionary<long, ResourceSnapshot>();
        readonly Dictionary<long, long> resourceRetryAt = new Dictionary<long, long>();
        long nextDropId;
        public WorldDrops DroppedItems = new WorldDrops();
        public int TypeMatches;
        public int VtableMatches;
        public int ValidPlayerHeaders;
        public int DynamicAvatarHandles;
        public int DynamicAvatars;
        public int ValidCameraMatrices;
        public bool Probe;
        public bool ReportDiscoveryProgress = true;

        public Reader(Process process, long moduleBase)
        {
            Process = process;
            ModuleBase = moduleBase;
            StartTicks = process.StartTime.ToUniversalTime().Ticks.ToString(Invariant);
#if LINUX
            Handle = linuxTarget.Memory;
            moduleImageSize = linuxTarget.ImageSize;
#else
            Handle = OpenProcess(ReadAccess, false, process.Id);
            moduleImageSize = process.MainModule.ModuleMemorySize;
#endif
            if (Handle == IntPtr.Zero) throw new UnauthorizedAccessException();
        }

        public void Dispose() {
#if !LINUX
            if (Handle != IntPtr.Zero) CloseHandle(Handle);
#endif
        }

        public bool Read(long address, byte[] buffer, int size)
        {
            if (address < 0x10000 || size < 1 || size > buffer.Length) return false;
            UIntPtr got;
            ReadProcessMemory(Handle, new IntPtr(address), buffer, new UIntPtr((uint)size), out got);
            return got.ToUInt64() == (ulong)size;
        }

        long Pointer(long address)
        {
            return Read(address, smallBuffer, 8) ? BitConverter.ToInt64(smallBuffer, 0) : 0;
        }

        bool WithinImage(long address) { return profile != null && address >= ModuleBase && address < ModuleBase + profile.Size; }
        bool WithinCode(long address) { return profile != null && profile.IsCode(address); }

        bool DynamicReadable(long address, int size)
        {
            return Readable(address, size, true);
        }

        bool Readable(long address, int size, bool dynamic)
        {
            if (address < 0x10000 || size < 1 || address > long.MaxValue - size) return false;
            MemoryRegion region;
            if (VirtualQueryEx(Handle, new IntPtr(address), out region, new UIntPtr((uint)Marshal.SizeOf<MemoryRegion>())) == UIntPtr.Zero) return false;
            bool permitted = region.State == 0x1000 && (region.Protection & 0x101) == 0 && (region.Protection & 0xee) != 0;
            if (dynamic) permitted = permitted && (region.Type == 0x20000 || region.Type == 0x40000);
            return permitted && address + size <= region.Address.ToInt64() + (long)region.Size.ToUInt64();
        }

        bool ObjectVtable(long address)
        {
            long vtable = Pointer(address);
            return profile != null && profile.IsData(vtable) && WithinCode(Pointer(vtable));
        }

        bool IsPlayerType(long type)
        {
            return profile != null && IsNativeType(type, profile.PlayerType);
        }

        bool IsNativeType(long type, long expected)
        {
            // Resource-defined subclasses have dynamic type records. Their bounded
            // parent chain eventually reaches the pinned native class record.
            for (int i = 0; i < 24 && (type & 7) == 0 && Readable(type, 0x20, false); i++)
            {
                if (type == expected) return true;
                long parent = Pointer(type + 0x18);
                if (parent == type) break;
                type = parent;
            }
            return false;
        }

        public bool ValidateProfile()
        {
            profile = null; playerTypes.Clear();
            byte[] headers = new byte[4096];
            if (!Read(ModuleBase, headers, headers.Length)) return false;
            ImageProfile candidate = ImageProfile.Headers(headers, ModuleBase, moduleImageSize);
            if (candidate == null) return false;
            foreach (Region section in new Region[] {
                new Region { Address = candidate.Code, Size = candidate.CodeSize },
                new Region { Address = candidate.Data, Size = candidate.DataSize },
                new Region { Address = candidate.Metadata, Size = candidate.MetadataSize } })
            {
                byte[] bytes = new byte[(int)section.Size];
                if (!Read(ModuleBase + section.Address, bytes, bytes.Length)) return false;
                Buffer.BlockCopy(bytes, 0, candidate.Bytes, (int)section.Address, bytes.Length);
            }
            if (!candidate.Resolve()) return false;
            profile = candidate;
            // These exact native resource names independently verify the atom
            // decoder and resource path fields before accepting dynamic assets.
            if (profile.DropsSupported &&
                (ResourcePath(profile.DropType) != "/SF/Types/Game/StoreItemPickUp" ||
                ResourcePath(profile.StoreItemType) != "/SF/Types/Game/StoreItemSpecializations/SFWeaponStoreItem" ||
                ResourcePath(profile.WeaponType) != "/SF/Types/Game/SFWeapon")) profile.DropsSupported = false;
            playerTypes.Add(profile.PlayerType);
            // Static derived registrations live in the current writable section.
            // Dynamic subclasses still require the recovered class vtable and a
            // bounded native ancestry check when a candidate is inspected.
            for (int offset = profile.Metadata; offset <= profile.Metadata + profile.MetadataSize - 0x20; offset += 8)
            {
                long type = ModuleBase + offset;
                if (BitConverter.ToInt64(profile.Bytes, offset + 0x18) == profile.PlayerType && IsPlayerType(type)) playerTypes.Add(type);
            }
            // The snapshot is only needed for profile recovery. Retain the bounds
            // and discard its raw bytes before scanning or emitting telemetry.
            profile.Bytes = null;
            return true;
        }

        float[] Floats(long address, int count)
        {
            if (!Read(address, smallBuffer, count * 4)) return null;
            float[] values = new float[count];
            for (int i = 0; i < count; i++)
            {
                values[i] = BitConverter.ToSingle(smallBuffer, i * 4);
                if (float.IsNaN(values[i]) || float.IsInfinity(values[i])) return null;
            }
            return values;
        }

        public bool TryPose(long player, out Pose pose)
        {
            pose = null;
            if (!DynamicReadable(player, 0x150) || !ObjectVtable(player) || !IsPlayerType(Pointer(player + 8))) return false;
            ValidPlayerHeaders++;
            long avatarHandle = Pointer(player + 0x148);
            if (!Readable(avatarHandle, 8, false)) return false;
            DynamicAvatarHandles++;
            long avatar = Pointer(avatarHandle);
            if (!DynamicReadable(avatar, 0xf0) || !ObjectVtable(avatar)) return false;
            DynamicAvatars++;
            // The native teleport path uses the world matrix at +A0 and compares
            // world positions at +D0. The +70 vector belongs to local placement.
            float[] world = Floats(avatar + 0xa0, 16);
            float[] position;
            float[] forward;
            double heading;
            if (!TryWorldPose(world, out position, out forward, out heading)) return false;
            long cameraHandle = Pointer(player + 0xd0);
            if (!Readable(cameraHandle, 8, false)) return false;
            long camera = Pointer(cameraHandle);
            if (!DynamicReadable(camera, 0x70) || !ObjectVtable(camera)) return false;
            float[] view = Floats(camera + 0x30, 16);
            if (!Orthonormal(view)) return false;
            ValidCameraMatrices++;
            float[] quaternion = Floats(avatar + 0xe0, 4);
            if (quaternion != null)
            {
                double norm = Dot(quaternion, 0, quaternion, 0, 4);
                if (norm < 0.98 || norm > 1.02) quaternion = null;
            }
            ReadDungeonFrames(avatar);
            pose = new Pose { Position = position, Quaternion = quaternion, Forward = forward,
                CameraForward = new float[] { view[2], view[6], view[10] }, AvatarVtableRva = Pointer(avatar) - ModuleBase,
                Heading = heading,
                LocalPosition = Probe ? Floats(avatar + 0x70, 3) : null,
                // A streaming request's input placement is not the final generated
                // layout frame. Only the loaded LevelInfo frames anchor the map.
                DungeonRoots = new List<DungeonRoot>(), DungeonFrames = frames,
                DungeonFramesTimestamp = framesTimestamp };
            return true;
        }

        void ClearDungeonFrames()
        {
            frames = new List<float[]>(); framesTimestamp = 0;
            frameContext = frameRegion = frameTable = 0; nextFramesAt = 0;
            ClearWorldDrops();
        }

        public void ClearWorldDrops()
        {
            dropIds.Clear();
            resourceCache.Clear(); resourceRetryAt.Clear();
            DroppedItems = new WorldDrops { Timestamp = (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000 };
        }

        string Atom(uint id)
        {
            if (id == 0 || profile.AtomTable == 0) return null;
            long table = Pointer(profile.AtomTable), block = Pointer(table + (id & 65535) * 16L);
            if (block < 0x10000) return null;
            long text = block + (id >> 16);
            byte[] bytes = new byte[64];
            var result = new System.Text.StringBuilder();
            for (int offset = 0; offset < 512; offset += bytes.Length)
            {
                if (!Read(text + offset, bytes, bytes.Length)) return null;
                foreach (byte value in bytes)
                {
                    if (value == 0) return result.Length > 0 ? result.ToString() : null;
                    if (value < 32 || value > 126) return null;
                    result.Append((char)value);
                }
            }
            return null;
        }

        string ResourcePath(long type)
        {
            if (!Readable(type, 0x38, false)) return null;
            string directory = Atom(UInt32(Pointer(type + 0x10))), leaf = Atom(UInt32(type + 0x2c));
            if (directory == null || leaf == null || directory.Length + leaf.Length > 256 || !directory.StartsWith("/", StringComparison.Ordinal)) return null;
            string path = directory + leaf;
            if (path.IndexOf("..", StringComparison.Ordinal) >= 0) return null;
            foreach (char value in path) if (!(char.IsLetterOrDigit(value) || value == '/' || value == '_' || value == '-' || value == '.')) return null;
            return path;
        }

        WorldDrop ReadWorldDrop(long entity, float[] playerPosition, long region)
        {
            if (!DynamicReadable(entity, profile.StoreReferenceOffset + 16) || Pointer(entity) != profile.DropVtable) return null;
            // Pickups legitimately scale their world matrix (the live Stultin
            // is 1.3x). Use the already verified Entity world-position getter;
            // a unit-length avatar orientation check would reject real loot.
            float[] position = Floats(entity + 0xd0, 3);
            if (position == null) return null;
            foreach (float coordinate in position) if (Math.Abs(coordinate) > 1000000) return null;
            double distance = 0;
            for (int axis = 0; axis < 3; axis++) distance += Math.Pow(position[axis] - playerPosition[axis], 2);
            if (distance > 80 * 80) return null;
            long handle = Pointer(entity + profile.StoreReferenceOffset), store = Pointer(handle);
            if (!DynamicReadable(store, profile.StoreWeaponOffset + 8) || Pointer(store) != profile.StoreItemVtable ||
                !IsNativeType(Pointer(store + 8), profile.StoreItemType)) return null;
            long weapon = Pointer(store + profile.StoreWeaponOffset);
            if (!IsNativeType(weapon, profile.WeaponType)) return null;
            string path = ResourcePath(weapon);
            if (path == null || !path.StartsWith("/SF/Weapons/", StringComparison.Ordinal)) return null;
            if (Pointer(entity + profile.StoreReferenceOffset) != handle || Pointer(handle) != store ||
                Pointer(store + profile.StoreWeaponOffset) != weapon) return null;
            bool value;
            bool? shiny = profile.ShinyProfile != null && profile.ShinyProfile.TryRead(Read, region, entity, store, ResolveLoadedResource, out value)
                ? (bool?)value : null;
            if (Pointer(entity + profile.StoreReferenceOffset) != handle || Pointer(handle) != store) return null;
            return new WorldDrop { Entity = entity, ItemType = path, Position = position, DistanceSquared = distance, Shiny = shiny };
        }

        long ResolveLoadedResource(long type)
        {
            if (profile.ResourceManager == 0 || !Readable(type, 0x38, false)) return 0;
            long now = frameClock.ElapsedMilliseconds, retry;
            if (resourceRetryAt.TryGetValue(type, out retry) && now < retry) return 0;
            // The resource manager's native creation path records weak handles
            // alongside their exact type in a 16-byte owned vector. Resolve only
            // already loaded objects; never invoke its loader or scan the heap.
            long table = Pointer(profile.ResourceManager + 0x80);
            uint bytes = UInt32(profile.ResourceManager + 0x88), capacity = UInt32(profile.ResourceManager + 0x8c);
            if (table < 0x10000 || (table & 7) != 0 || bytes == 0 || bytes % 16 != 0 ||
                bytes > 32 * 1024 * 1024 || capacity < bytes) return 0;
            ResourceSnapshot cached;
            if (!resourceCache.TryGetValue(type, out cached))
            {
                if (resourceCache.Count >= 256) resourceCache.Clear();
                resourceCache[type] = cached = new ResourceSnapshot();
            }
            if (bytes < cached.Bytes) { cached.Bytes = 0; cached.References.Clear(); }
            for (int index = cached.References.Count - 1; index >= 0; index--)
            {
                ResourceReference reference = cached.References[index];
                if (reference.Row + 16 > bytes || Pointer(table + reference.Row) != reference.Handle ||
                    Pointer(table + reference.Row + 8) != type || Pointer(reference.Handle) != reference.Instance ||
                    !DynamicReadable(reference.Instance, 0x30) || !ObjectVtable(reference.Instance) || Pointer(reference.Instance + 8) != type)
                { cached.References.RemoveAt(index); cached.Bytes = 0; }
            }
            var seen = new HashSet<long>();
            var instances = new HashSet<long>();
            var handlePages = new Dictionary<long, byte[]>();
            foreach (ResourceReference reference in cached.References) { seen.Add(reference.Handle); instances.Add(reference.Instance); }
            byte[] chunk = new byte[64 * 1024];
            for (long offset = cached.Bytes; offset < bytes; offset += chunk.Length)
            {
                int count = (int)Math.Min(chunk.Length, bytes - offset);
                if (!Read(table + offset, chunk, count) || Pointer(profile.ResourceManager + 0x80) != table) return 0;
                for (int index = 0; index < count; index += 16)
                {
                    if (BitConverter.ToInt64(chunk, index + 8) != type) continue;
                    long handle = BitConverter.ToInt64(chunk, index);
                    if (!seen.Add(handle)) continue;
                    if (handle < 0x10000) continue;
                    // Weak records accumulate expired handles. Group only these
                    // exact matching references by page, avoiding tens of
                    // thousands of individual RPM calls for one weapon type.
                    long page = handle & ~4095L;
                    byte[] handlePage;
                    if (!handlePages.TryGetValue(page, out handlePage))
                    {
                        if (handlePages.Count >= 4096) return 0;
                        handlePage = new byte[4096];
                        if (!Read(page, handlePage, handlePage.Length)) handlePage = null;
                        handlePages[page] = handlePage;
                    }
                    long candidate = handlePage != null && (handle & 4095) <= 4088
                        ? BitConverter.ToInt64(handlePage, (int)(handle & 4095)) : Pointer(handle);
                    if (!DynamicReadable(candidate, 0x30) || !ObjectVtable(candidate) || Pointer(candidate + 8) != type) continue;
                    if (Pointer(handle) != candidate || Pointer(profile.ResourceManager + 0x80) != table) return 0;
                    if (instances.Add(candidate)) cached.References.Add(new ResourceReference { Handle = handle, Instance = candidate, Row = offset + index });
                    if (cached.References.Count > 128) { resourceCache.Remove(type); return 0; }
                }
            }
            if (Pointer(profile.ResourceManager + 0x80) != table || UInt32(profile.ResourceManager + 0x88) < bytes) return 0;
            cached.Bytes = bytes;
            if (cached.References.Count > 0)
            {
                long first = cached.References[0].Instance, vtable = Pointer(first);
                bool weapon = IsNativeType(type, profile.WeaponType);
                byte[] properties = weapon ? new byte[0x1d00] : null;
                if (weapon && !Read(first, properties, properties.Length)) return 0;
                foreach (ResourceReference reference in cached.References)
                {
                    if (Pointer(reference.Handle) != reference.Instance || Pointer(reference.Instance) != vtable || Pointer(reference.Instance + 8) != type) return 0;
                    // Multiple copies of one type are normal. Admit them only
                    // when eligibility and the post-generator manifest agree.
                    if (weapon && (((UInt32(reference.Instance + 0x51c) >> 16) & 255) != properties[0x51e] ||
                        ((UInt32(reference.Instance + 0x4b8) >> 8) & 255) != properties[0x4b9] ||
                        Pointer(reference.Instance + 0x1cf8) != BitConverter.ToInt64(properties, 0x1cf8))) return 0;
                }
                resourceRetryAt.Remove(type); return first;
            }
            if (resourceRetryAt.Count >= 256) resourceRetryAt.Clear();
            resourceRetryAt[type] = now + 2000;
            return 0;
        }

        public void RefreshDungeonFrames() { nextFramesAt = 0; }

        void ReadDungeonFrames(long avatar)
        {
            long context = Pointer(avatar + 0x1e0);
            if (!DynamicReadable(context, 0x98) || Pointer(context) != profile.ContextVtable ||
                !IsNativeType(Pointer(context + 8), profile.ContextType)) { ClearDungeonFrames(); return; }
            long region = Pointer(Pointer(context + 0x90));
            if (!DynamicReadable(region, 0x210) || Pointer(region) != profile.RegionVtable ||
                !IsNativeType(Pointer(region + 8), profile.RegionType)) { ClearDungeonFrames(); return; }
            long table = Pointer(region + 0x200);
            uint bytes = UInt32(region + 0x208);
            if (!ValidFrameTable(table, bytes)) { ClearDungeonFrames(); return; }
            long now = frameClock.ElapsedMilliseconds;
            // Transient particles constantly change the entity count. Treating
            // that count as a cache invalidation forced a full walk on every
            // pose sample in the live scene. Ownership/table changes invalidate
            // immediately; ordinary additions/removals refresh at the 1 s bound.
            if (context == frameContext && region == frameRegion && table == frameTable && now < nextFramesAt) return;
            // This is the Region's bounded owned-entity handle array, not a heap scan.
            // Read its snapshot once, then discard it if the owner changed mid-read.
            byte[] entries = new byte[bytes];
            if (!Read(table, entries, entries.Length)) { ClearDungeonFrames(); return; }
            if (Pointer(avatar + 0x1e0) != context || Pointer(Pointer(context + 0x90)) != region ||
                Pointer(region + 0x200) != table || UInt32(region + 0x208) != bytes) { ClearDungeonFrames(); return; }
            var types = new Dictionary<long, int>();
            var candidates = new List<float[]>();
            var drops = new List<WorldDrop>();
            float[] playerPosition = profile.DropsSupported ? Floats(avatar + 0xd0, 3) : null;
            byte[] header = new byte[0x24];
            for (int offset = 0; offset < entries.Length; offset += 8)
            {
                long entityHandle = BitConverter.ToInt64(entries, offset);
                long entity = Pointer(entityHandle);
                if (!Read(entity, header, header.Length) || (header[0x20] & 1) != 0) continue;
                long type = BitConverter.ToInt64(header, 8);
                int kind;
                if (!types.TryGetValue(type, out kind))
                {
                    kind = IsNativeType(type, profile.LevelInfoType) ? 1 :
                        profile.DropsSupported && IsNativeType(type, profile.DropType) ? 2 : 0;
                    types[type] = kind;
                }
                if (kind == 2 && playerPosition != null)
                {
                    WorldDrop drop = ReadWorldDrop(entity, playerPosition, region);
                    if (drop != null && Pointer(entityHandle) == entity && Pointer(entity + 8) == type &&
                        Pointer(entity + 0x1e0) == context && (UInt32(entity + 0x20) & 1) == 0) drops.Add(drop);
                    continue;
                }
                if (kind != 1 || !ObjectVtable(entity)) continue;
                float[] matrix = Floats(entity + 0xa0, 16);
                if (ValidDungeonMatrix(matrix) && Pointer(entityHandle) == entity && Pointer(entity + 8) == type
                    && Pointer(entity + 0x1e0) == context && (UInt32(entity + 0x20) & 1) == 0) candidates.Add(matrix);
            }
            // Particle entities can enter or leave the Region during this walk.
            // The array snapshot was checked before traversal; every admitted
            // room still has its handle, type and current owning context.
            if (Pointer(avatar + 0x1e0) != context || Pointer(Pointer(context + 0x90)) != region) { ClearDungeonFrames(); return; }
            frames = ConsensusFrames(candidates);
            framesTimestamp = (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000;
            drops.Sort(delegate(WorldDrop left, WorldDrop right) { return left.DistanceSquared.CompareTo(right.DistanceSquared); });
            if (drops.Count > 64) drops.RemoveRange(64, drops.Count - 64);
            var active = new Dictionary<long, string>();
            foreach (WorldDrop drop in drops)
            {
                string id;
                if (!dropIds.TryGetValue(drop.Entity, out id)) id = "drop-" + (++nextDropId).ToString(Invariant);
                drop.Id = id; active[drop.Entity] = id;
            }
            dropIds = active;
            DroppedItems = new WorldDrops { Available = profile.DropsSupported, Timestamp = framesTimestamp, Items = drops };
            frameContext = context; frameRegion = region; frameTable = table;
            nextFramesAt = now + 1000;
        }

        uint UInt32(long address)
        {
            return Read(address, smallBuffer, 4) ? BitConverter.ToUInt32(smallBuffer, 0) : 0;
        }

        List<Region> DiscoveryRegions()
        {
            TypeMatches = VtableMatches = ValidPlayerHeaders = DynamicAvatarHandles = DynamicAvatars = ValidCameraMatrices = 0;
            var regions = new List<Region>();
            long address = 0x10000;
            int size = Marshal.SizeOf<MemoryRegion>();
            while (address < 0x7fffffffffff)
            {
                MemoryRegion info;
                if (VirtualQueryEx(Handle, new IntPtr(address), out info, new UIntPtr((uint)size)) == UIntPtr.Zero) break;
                long start = info.Address.ToInt64();
                ulong length = info.Size.ToUInt64();
                if (length == 0 || length > long.MaxValue || start > long.MaxValue - (long)length) break;
                address = start + (long)length;
                if (IsHeap(info)) regions.Add(new Region { Address = start, Size = (long)length });
            }
            regions.Sort(delegate(Region left, Region right) {
                int leftGroup = left.Size >= 0x10000 && left.Size <= 8L * 1024 * 1024 ? 0 : left.Size < 0x10000 ? 2 : 1;
                int rightGroup = right.Size >= 0x10000 && right.Size <= 8L * 1024 * 1024 ? 0 : right.Size < 0x10000 ? 2 : 1;
                return leftGroup == rightGroup ? left.Size.CompareTo(right.Size) : leftGroup.CompareTo(rightGroup);
            });
            return regions;
        }

        int InspectChunk(long address, int length, DiscoveryPass pass)
        {
            // A region can split or change protection while the pass is paused.
            // Check its current boundaries and eligibility before each read.
            long end = address + length;
            int totalRead = 0;
            while (address < end)
            {
                MemoryRegion info;
                if (VirtualQueryEx(Handle, new IntPtr(address), out info, new UIntPtr((uint)Marshal.SizeOf<MemoryRegion>())) == UIntPtr.Zero) break;
                long start = info.Address.ToInt64();
                ulong size = info.Size.ToUInt64();
                if (start < 0 || start > address || size > (ulong)(long.MaxValue - start) || start + (long)size <= address) break;
                int span = (int)(Math.Min(end, start + (long)size) - address);
                if (IsHeap(info))
                {
                    UIntPtr got;
                    ReadProcessMemory(Handle, new IntPtr(address), scanBuffer, new UIntPtr((uint)span), out got);
                    int read = (int)Math.Min((ulong)span, got.ToUInt64());
                    totalRead += read;
                    Inspect(scanBuffer, read, address, pass);
                }
                address += span;
            }
            Thread.Yield();
            return totalRead;
        }

        public DiscoveryPass Discover(out long player)
        {
            if (discovery == null) discovery = new DiscoveryPass(DiscoveryRegions());
            DiscoveryPass pass = discovery;
            Status("searching", StartTicks, pass.Count, pass.BytesRead, false, pass.Progress);
            Stopwatch elapsed = Stopwatch.StartNew();
            long nextStatus = 1000;
            pass.RunSlice(MaximumScanBytes, delegate {
                if (Process.HasExited || elapsed.Elapsed.TotalSeconds >= MaximumScanSeconds) return true;
                if (ReportDiscoveryProgress && elapsed.ElapsedMilliseconds >= nextStatus)
                {
                    Status("searching", StartTicks, pass.Count, pass.BytesRead, false, pass.Progress);
                    nextStatus = elapsed.ElapsedMilliseconds + 1000;
                }
                return false;
            }, (address, length) => InspectChunk(address, length, pass));
            player = 0;
            if (pass.Complete)
            {
                if (!Process.HasExited) player = pass.SelectPlayer(delegate(long address) { Pose pose; return TryPose(address, out pose); });
                discovery = null;
            }
            return pass;
        }

        unsafe void Inspect(byte[] bytes, int length, long start, DiscoveryPass candidates)
        {
            if (candidates.AmbiguousOverflow) return;
            fixed (byte* data = bytes)
            {
                int initial = (int)((8 - (start & 7)) & 7);
                for (int offset = initial; offset + 8 <= length; offset += 8)
                {
                    long value = *(long*)(data + offset);
                    long player;
                    if (value == profile.PlayerVtable) {
                        VtableMatches++; player = start + offset;
                        if (Probe) Console.WriteLine("{\"type\":\"diagnostic\",\"kind\":\"player-vtable\",\"playerType\":" +
                            (IsPlayerType(Pointer(player + 8)) ? "true" : "false") + ",\"avatarHandle\":\"" +
                            Location(Pointer(player + 0x148)) + "\",\"cameraHandle\":\"" + Location(Pointer(player + 0xd0)) + "\"}");
                    }
                    else if (profile.IsMetadata(value) && playerTypes.Contains(value)) { TypeMatches++; player = start + offset - 8; }
                    else continue;
                    if (candidates.Contains(player)) continue;
                    Pose pose;
                    if (TryPose(player, out pose)) candidates.Add(player);
                    if (candidates.AmbiguousOverflow) return;
                }
            }
        }

        string Location(long address)
        {
            if (address == 0) return "null";
            if (WithinImage(address)) return "module";
            return DynamicReadable(address, 8) ? "dynamic" : "unreadable";
        }
    }

    static bool IsHeap(MemoryRegion info)
    {
        return info.State == 0x1000 && (info.Type == 0x20000 || info.Type == 0x40000) &&
            (info.Protection & 0x101) == 0 && (info.Protection & 0xcc) != 0;
    }

    static double Dot(float[] left, int lo, float[] right, int ro, int length)
    {
        double result = 0;
        for (int i = 0; i < length; i++) result += (double)left[lo + i] * right[ro + i];
        return result;
    }

    static bool Orthonormal(float[] matrix)
    {
        if (matrix == null || matrix.Length != 16) return false;
        foreach (float value in matrix) if (float.IsNaN(value) || float.IsInfinity(value)) return false;
        if (Math.Abs(matrix[15] - 1) > 0.02 ||
            Math.Abs(matrix[3]) > 0.02 || Math.Abs(matrix[7]) > 0.02 || Math.Abs(matrix[11]) > 0.02) return false;
        for (int axis = 0; axis < 3; axis++)
        {
            double norm = Dot(matrix, axis * 4, matrix, axis * 4, 3);
            if (norm < 0.98 || norm > 1.02) return false;
            for (int other = axis + 1; other < 3; other++)
                if (Math.Abs(Dot(matrix, axis * 4, matrix, other * 4, 3)) > 0.02) return false;
        }
        double determinant = (double)matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
            (double)matrix[1] * (matrix[4] * matrix[10] - matrix[6] * matrix[8]) +
            (double)matrix[2] * (matrix[4] * matrix[9] - matrix[5] * matrix[8]);
        return determinant > 0.98 && determinant < 1.02;
    }

    static bool TryWorldPose(float[] world, out float[] position, out float[] forward, out double heading)
    {
        position = null;
        forward = null;
        heading = 0;
        if (!Orthonormal(world)) return false;
        for (int i = 12; i < 15; i++) if (Math.Abs(world[i]) > 1000000) return false;
        if ((double)world[8] * world[8] + (double)world[10] * world[10] < 0.01) return false;
        position = new float[] { world[12], world[13], world[14] };
        forward = new float[] { world[8], world[9], world[10] };
        heading = Math.Atan2(forward[0], forward[2]) * 180.0 / Math.PI;
        return true;
    }

    static bool ValidGeneratorPath(string value)
    {
        if (value == null || value.Length > 512 || !value.StartsWith("/SF/Levels/Procs/", StringComparison.Ordinal) ||
            value.EndsWith(".lp", StringComparison.Ordinal) || value.Contains("//") || value.Contains("..")) return false;
        foreach (char c in value)
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                c == '/' || c == '_' || c == '-' || c == '.')) return false;
        return value.Length > "/SF/Levels/Procs/".Length;
    }

    static bool ValidDungeonMatrix(float[] matrix)
    {
        if (!Orthonormal(matrix) || Math.Abs(matrix[12]) > 1000000 || Math.Abs(matrix[13]) > 1000000 || Math.Abs(matrix[14]) > 1000000) return false;
        return Math.Abs(matrix[1]) < .001 && Math.Abs(matrix[4]) < .001 && Math.Abs(matrix[5] - 1) < .001 &&
            Math.Abs(matrix[6]) < .001 && Math.Abs(matrix[9]) < .001;
    }

    static bool ValidFrameTable(long address, uint bytes)
    {
        return address >= 0x10000 && (address & 7) == 0 && bytes > 0 && bytes <= 65536 * 8 && (bytes & 7) == 0
            && address <= long.MaxValue - bytes;
    }

    static List<float[]> ConsensusFrames(List<float[]> candidates)
    {
        var result = new List<float[]>();
        foreach (float[] matrix in candidates)
        {
            if (!ValidDungeonMatrix(matrix)) continue;
            bool duplicate = false;
            foreach (float[] previous in result)
            {
                bool same = true;
                for (int i = 0; i < 16; i++) if (Math.Abs((double)previous[i] - matrix[i]) > (i >= 12 ? .001 : .00001)) { same = false; break; }
                if (same) { duplicate = true; break; }
            }
            if (duplicate) continue;
            // A partial cloud could conceal another valid match. Fail closed
            // when this bounded protocol cannot represent every loaded frame.
            if (result.Count == 64) return new List<float[]>();
            result.Add(matrix);
        }
        return result;
    }

    static List<DungeonRoot> ConsensusRoots(List<DungeonRoot> candidates)
    {
        var unique = new Dictionary<string, DungeonRoot>(StringComparer.Ordinal);
        var conflicting = new HashSet<string>(StringComparer.Ordinal);
        foreach (DungeonRoot candidate in candidates)
        {
            if (candidate == null || !ValidGeneratorPath(candidate.LevelPath) || !ValidDungeonMatrix(candidate.Matrix) || conflicting.Contains(candidate.LevelPath)) continue;
            DungeonRoot previous;
            if (unique.TryGetValue(candidate.LevelPath, out previous))
            {
                bool same = true;
                for (int i = 0; i < 16; i++) if (Math.Abs((double)previous.Matrix[i] - candidate.Matrix[i]) > (i >= 12 ? .001 : .00001)) same = false;
                if (!same) { unique.Remove(candidate.LevelPath); conflicting.Add(candidate.LevelPath); }
            }
            else unique[candidate.LevelPath] = candidate;
        }
        var names = new List<string>(unique.Keys); names.Sort(StringComparer.Ordinal);
        var result = new List<DungeonRoot>();
        foreach (string name in names) { if (result.Count == 32) break; result.Add(unique[name]); }
        return result;
    }

    static string Number(float number) { return number.ToString("R", Invariant); }
    static string Vector(float[] vector)
    {
        if (vector == null) return "null";
        string result = "{\"x\":" + Number(vector[0]) + ",\"y\":" + Number(vector[1]) + ",\"z\":" + Number(vector[2]);
        if (vector.Length == 4) result += ",\"w\":" + Number(vector[3]);
        return result + "}";
    }

    static void Status(string status, string ticks, int candidates, long scanned, bool completed, int? progress = null)
    {
        Console.WriteLine("{\"type\":\"status\",\"status\":\"" + status + "\",\"processStartUtcTicks\":\"" + ticks +
            "\",\"moduleHash\":" + (activeHash == null ? "null" : "\"" + activeHash + "\"") + ",\"candidateCount\":" + candidates.ToString(Invariant) +
            ",\"bytesScanned\":" + scanned.ToString(Invariant) + ",\"scanCompleted\":" + (completed ? "true" : "false") +
            (progress.HasValue ? ",\"scanProgress\":" + progress.Value.ToString(Invariant) : "") + "}");
        Console.Out.Flush();
    }

    static void OutputPose(Pose pose)
    {
        long timestamp = (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000;
        Console.WriteLine("{\"type\":\"pose\",\"source\":\"memory\",\"timestamp\":" + timestamp.ToString(Invariant) +
            ",\"position\":" + Vector(pose.Position) + ",\"heading\":" + pose.Heading.ToString("R", Invariant) + ",\"quaternion\":" + Vector(pose.Quaternion) +
            ",\"forward\":" + Vector(pose.Forward) + ",\"cameraForward\":" + Vector(pose.CameraForward) +
            ",\"dungeonRoots\":" + RootsJson(pose.DungeonRoots) + ",\"dungeonFrames\":" + FramesJson(pose.DungeonFrames) +
            ",\"dungeonFramesTimestamp\":" + pose.DungeonFramesTimestamp.ToString(Invariant) + "}");
        Console.Out.Flush();
    }

    static void OutputWorldDrops(WorldDrops snapshot)
    {
        var output = new System.Text.StringBuilder("{\"type\":\"world-drops\",\"source\":\"memory\",\"timestamp\":");
        output.Append(snapshot.Timestamp.ToString(Invariant)).Append(",\"status\":\"")
            .Append(snapshot.Available ? "available" : "unavailable").Append("\",\"items\":[");
        if (snapshot.Available) foreach (WorldDrop drop in snapshot.Items)
        {
            if (output[output.Length - 1] != '[') output.Append(',');
            output.Append("{\"id\":\"").Append(drop.Id).Append("\",\"itemType\":\"").Append(drop.ItemType)
                .Append("\",\"position\":{\"x\":").Append(Number(drop.Position[0]))
                .Append(",\"y\":").Append(Number(drop.Position[1])).Append(",\"z\":").Append(Number(drop.Position[2]))
                .Append("},\"shiny\":").Append(drop.Shiny.HasValue ? (drop.Shiny.Value ? "true" : "false") : "null").Append('}');
        }
        Console.WriteLine(output.Append("]}").ToString());
        Console.Out.Flush();
    }

    static string RootsJson(List<DungeonRoot> roots)
    {
        var output = new System.Text.StringBuilder("[");
        if (roots != null) foreach (DungeonRoot root in roots)
        {
            if (output.Length > 1) output.Append(',');
            output.Append("{\"source\":\"stream-region\",\"levelPath\":\"").Append(root.LevelPath).Append("\",\"matrix\":[");
            for (int i = 0; i < 16; i++) { if (i > 0) output.Append(','); output.Append(Number(root.Matrix[i])); }
            output.Append("]}");
        }
        return output.Append(']').ToString();
    }

    static string FramesJson(List<float[]> frames)
    {
        var output = new System.Text.StringBuilder("[");
        if (frames != null) foreach (float[] matrix in frames)
        {
            if (output.Length > 1) output.Append(',');
            output.Append("{\"source\":\"level-info\",\"matrix\":[");
            for (int i = 0; i < 16; i++) { if (i > 0) output.Append(','); output.Append(Number(matrix[i])); }
            output.Append("]}");
        }
        return output.Append(']').ToString();
    }

    static void ListenForRootRefresh(RootRefreshGate gate)
    {
        var input = new Thread(delegate() {
            try
            {
                var line = new System.Text.StringBuilder();
                bool oversized = false;
                int next;
                while ((next = Console.In.Read()) >= 0)
                {
                    if (next == '\n')
                    {
                        if (!oversized && line.ToString() == "refresh-roots") gate.Request();
                        line.Length = 0; oversized = false;
                    }
                    else if (next != '\r')
                    {
                        if (line.Length < 128) line.Append((char)next);
                        else oversized = true;
                    }
                }
            }
            catch (IOException) { /* A closed command pipe does not interrupt tracking. */ }
            catch (ObjectDisposedException) { }
        });
        input.IsBackground = true; input.Start();
    }

    static int Main(string[] args)
    {
        int pid = 0;
        bool probe = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--probe") probe = true;
            else if (args[i] == "--pid" && i + 1 < args.Length && int.TryParse(args[++i], out pid) && pid > 0) { }
            else { Status("invalid-arguments", "", 0, 0, false); return 2; }
        }
        if (pid <= 0) { Status("invalid-arguments", "", 0, 0, false); return 2; }
        try
        {
#if LINUX
            using (LinuxTarget target = LinuxTarget.Open(pid))
#endif
            using (Process process = Process.GetProcessById(pid))
            {
#if LINUX
                linuxTarget = target;
                activeHash = target.Hash;
                long moduleBase = target.ImageBase;
#else
                if (!string.Equals(process.ProcessName, "Soulframe.x64", StringComparison.OrdinalIgnoreCase))
                { Status("wrong-process", "", 0, 0, false); return 2; }
                ProcessModule module = process.MainModule;
                if (!string.Equals(Path.GetFileName(module.FileName), "Soulframe.x64.exe", StringComparison.OrdinalIgnoreCase))
                { Status("wrong-process", "", 0, 0, false); return 2; }
                string hash;
                using (var stream = File.OpenRead(module.FileName))
                using (var algorithm = SHA256.Create())
                    hash = BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                activeHash = hash;
                if (module.ModuleMemorySize < 4096 || module.ModuleMemorySize > MaximumImageBytes)
                { Status("unsupported-build", "", 0, 0, false); return 3; }
                long moduleBase = module.BaseAddress.ToInt64();
#endif
                using (var reader = new Reader(process, moduleBase))
                {
                    reader.Probe = probe;
                    if (!reader.ValidateProfile()) { Status("profile-mismatch", reader.StartTicks, 0, 0, false); return 3; }
                    var rootRefresh = new RootRefreshGate();
                    var rootClock = Stopwatch.StartNew();
                    if (!probe) ListenForRootRefresh(rootRefresh);
                    long player = 0, lastDropsTimestamp = -1;
                    while (!process.HasExited)
                    {
                        if (player == 0)
                        {
                            DiscoveryPass pass = reader.Discover(out player);
                            if (probe) Console.WriteLine("{\"type\":\"diagnostic\",\"typeMatches\":" + reader.TypeMatches +
                                ",\"vtableMatches\":" + reader.VtableMatches + ",\"validPlayerHeaders\":" + reader.ValidPlayerHeaders +
                                ",\"dynamicAvatarHandles\":" + reader.DynamicAvatarHandles + ",\"dynamicAvatars\":" + reader.DynamicAvatars +
                                ",\"validCameraMatrices\":" + reader.ValidCameraMatrices + "}");
                            if (process.HasExited) break;
                            if (player == 0)
                            {
                                Status(!pass.Complete ? "scan-incomplete" : pass.Count == 0 ? "not-found" : "ambiguous",
                                    reader.StartTicks, pass.Count, pass.BytesRead, pass.Complete, pass.Complete ? null : pass.Progress);
                                if (probe) return 4;
                                Thread.Sleep(pass.Complete ? 30000 : 1000);
                                continue;
                            }
                            Status("tracking", reader.StartTicks, 1, pass.BytesRead, true);
                        }
                        if (!probe && rootRefresh.TryStart(rootClock.ElapsedMilliseconds))
                        {
                            // Loaded frame discovery only walks the Region's owned
                            // entity vector. A refresh never repeats the heap scan.
                            reader.RefreshDungeonFrames();
                            rootRefresh.Complete();
                        }
                        Pose pose;
                        if (reader.TryPose(player, out pose)) {
                            OutputPose(pose);
                            if (reader.DroppedItems.Timestamp != lastDropsTimestamp)
                            {
                                OutputWorldDrops(reader.DroppedItems);
                                lastDropsTimestamp = reader.DroppedItems.Timestamp;
                            }
                            if (probe) Console.WriteLine("{\"type\":\"diagnostic\",\"kind\":\"avatar-class\",\"moduleRva\":" + pose.AvatarVtableRva.ToString(Invariant) +
                                ",\"localPosition\":" + Vector(pose.LocalPosition) + "}");
                        }
                        else
                        {
                            reader.ClearWorldDrops(); OutputWorldDrops(reader.DroppedItems);
                            player = 0;
                            Status("unavailable", reader.StartTicks, 0, 0, false);
                        }
                        if (probe) return player != 0 ? 0 : 4;
                        Thread.Sleep(100);
                    }
                    Status("process-gone", reader.StartTicks, 0, 0, false);
                }
            }
            return 0;
        }
#if LINUX
        catch (LinuxTargetException error) { Status(error.Status, "", 0, 0, false); return 4; }
#endif
        catch (ArgumentException) { Status("process-gone", "", 0, 0, false); return 4; }
        catch (UnauthorizedAccessException) { Status("permission-denied", "", 0, 0, false); return 5; }
        catch (System.ComponentModel.Win32Exception) { Status("permission-denied", "", 0, 0, false); return 5; }
        catch (IOException) { Status("unavailable", "", 0, 0, false); return 4; }
        catch (InvalidOperationException) { Status("process-gone", "", 0, 0, false); return 4; }
    }
}
