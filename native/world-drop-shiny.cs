using System;
using System.Collections.Generic;
using System.Security.Cryptography;

// Optional read-only replay of the same named mShiny result exposed by the
// pickup's GetInfo binding. Unsupported code or incomplete metadata is unknown.
// No game function is called, and no process memory is written.
internal sealed class WorldDropShiny
{
    const ulong Multiplier = 0x5851f42d4c957f2dUL, Increment = 0x14057b7ef767814fUL;
    readonly long moduleBase, moduleEnd, regionVtable, dropVtable;
    readonly long sceneGetter, localGetter, clientGetter, clientIdGetter, findClient, itemGenerator, aspectGenerator;
    readonly long networkGlobal;
    public readonly long ResourceManager;

    WorldDropShiny(long address, int size, long region, long drop, long scene, long local, long client,
        long clientId, long find, long item, long aspect, long network, long resources)
    {
        moduleBase = address; moduleEnd = address + size; regionVtable = region; dropVtable = drop;
        sceneGetter = scene; localGetter = local; clientGetter = client; clientIdGetter = clientId;
        findClient = find; itemGenerator = item; aspectGenerator = aspect; networkGlobal = network; ResourceManager = resources;
    }

    static bool Match(byte[] bytes, int at, params byte[] expected)
    {
        if (bytes == null || at < 0 || at > bytes.Length - expected.Length) return false;
        for (int i = 0; i < expected.Length; i++) if (bytes[at + i] != expected[i]) return false;
        return true;
    }
    static int Offset(byte[] image, long address, long addressBase, int length)
    {
        long value = address - addressBase;
        return image != null && length > 0 && value >= 0 && value <= image.Length - length ? (int)value : -1;
    }
    static long Pointer(byte[] image, long address, long addressBase)
    {
        int at = Offset(image, address, addressBase, 8); return at < 0 ? 0 : BitConverter.ToInt64(image, at);
    }
    static bool Hash(byte[] bytes, int at, int length, string expected)
    {
        if (bytes == null || at < 0 || length <= 0 || at > bytes.Length - length) return false;
        using (var sha = SHA256.Create())
        {
            return BitConverter.ToString(sha.ComputeHash(bytes, at, length)).Replace("-", "").ToLowerInvariant() == expected;
        }
    }
    static long Call(byte[] image, long function, int delta, long addressBase)
    {
        int at = Offset(image, function + delta, addressBase, 5);
        return at >= 0 && image[at] == 0xe8 ? function + delta + 5 + BitConverter.ToInt32(image, at + 1) : 0;
    }
    static long Relative(byte[] image, long instruction, long addressBase)
    {
        int at = Offset(image, instruction, addressBase, 7);
        return at < 0 ? 0 : instruction + 7 + BitConverter.ToInt32(image, at + 3);
    }
    static long Find(byte[] image, long addressBase, int delta, int length, string hash, params byte[] anchor)
    {
        long result = 0;
        for (int at = 0; at <= image.Length - anchor.Length; at++)
        {
            if (image[at] != anchor[0] || !Match(image, at, anchor) || !Hash(image, at - delta, length, hash)) continue;
            if (result != 0) return 0;
            result = addressBase + at - delta;
        }
        return result;
    }

    public static bool TryCreate(byte[] image, long addressBase, long region, long drop, out WorldDropShiny profile)
    {
        profile = null;
        try
        {
            if (image == null || image.Length < 4096 || addressBase < 65536 || addressBase > long.MaxValue - image.Length) return false;
            long generator = Pointer(image, drop + 0x5b0, addressBase);
            if (!Hash(image, Offset(image, generator, addressBase, 0x13b), 0x13b, "7b64f94545e309f301247d42d686f54d828776803c09775ba8d08e973a0b763f")) return false;
            long randomizer = Call(image, generator, 0x125, addressBase), mixer = Call(image, generator, 0xef, addressBase);
            if (!Hash(image, Offset(image, randomizer, addressBase, 0x1f7), 0x1f7, "ff43a4ee422c8e338eb7d0a9ff49338051c1a4777f077baf052f634cc8a18e90")
                || !Hash(image, Offset(image, mixer, addressBase, 0x38), 0x38, "b35e696606399e3b04406aff9d71d672111938cd5ed8f1d115296f2cd0d12a45")) return false;
            long local = Pointer(image, region + 0x3e8, addressBase), sceneReference = Pointer(image, region + 0x310, addressBase);
            if (!Hash(image, Offset(image, local, addressBase, 0x6f), 0x6f, "dfd15a7d41b964df5dce35e73df64a1cfa3f5f25923eebf4162eabf791918326")
                || !Match(image, Offset(image, sceneReference, addressBase, 11), 0x48, 0x8b, 0x81, 0x40, 0x02, 0, 0, 0x48, 0x8b, 0, 0xc3)) return false;
            long scene = Find(image, addressBase, 0xb4, 0xc4, "97b7c112696c9eda28991aa4bc8d4411c3ff8cafdfad366f2b375ae8b29c146a",
                0x48, 0x8b, 0x83, 0xf8, 0x07, 0, 0, 0x48, 0xf7, 0xd0, 0x48, 0x83, 0xc4, 0x20, 0x5b, 0xc3);
            long client = Find(image, addressBase, 0, 0x57, "67db64cf107c3bdcea2837beabb71170b9d5b6175efb052bab3a73f43502b058",
                0x40, 0x53, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0x01, 0x48, 0x8b, 0xd9, 0xff, 0x90, 0xb0, 0, 0, 0);
            long clientId = Find(image, addressBase, 0x13, 0x119, "0db405b16d3900f3e1151f4904f502d77a6d8f50bf54d09f1ee5d9dd2eb09c58",
                0x0f, 0xb6, 0x91, 0x57, 0x01, 0, 0, 0x80, 0xfa, 0xff);
            long find = Find(image, addressBase, 0, 0x84, "206837ea1642d327e5c3fa93490f88f8e9ee309ca7b179a1a523293564b11a8d",
                0x48, 0x89, 0x5c, 0x24, 0x08, 0x48, 0x89, 0x74, 0x24, 0x10, 0x57, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0x99, 0x30, 0x02, 0, 0);
            long item = Find(image, addressBase, 0, 0x6d, "46ca3bbe03395bb20bb631f749e8da17ace3283bb8d8054126488380ad678e42",
                0x48, 0x89, 0x5c, 0x24, 0x10, 0x57, 0x48, 0x83, 0xec, 0x20, 0x48, 0x8b, 0xda, 0x49, 0x8b, 0xf8);
            // This audited Aspect body reads quality and writes only the compact
            // fingerprint at record+0x20; it never alters the named mShiny byte.
            long aspect = Find(image, addressBase, 0, 0xb9c, "b0c8e7034591576c8f6c84114b2e5e55969dad3e47c5d6f49f8fc327ab27dc30",
                0x48, 0x8b, 0xc4, 0x4c, 0x89, 0x40, 0x18, 0x48, 0x89, 0x50, 0x10, 0x55, 0x41, 0x56);
            if (scene == 0 || client == 0 || clientId == 0 || find == 0 || item == 0 || aspect == 0) return false;
            long networking = Call(image, scene, 9, addressBase);
            if (!Match(image, Offset(image, networking, addressBase, 11), 0x48, 0x8b, 0x05)
                || !Match(image, Offset(image, networking + 7, addressBase, 4), 0x48, 0x8b, 0, 0xc3)) return false;
            long network = Relative(image, networking, addressBase);
            long resolve = Call(image, randomizer, 0x8e, addressBase), resourcesGetter = Call(image, resolve, 0x23, addressBase);
            if (!Match(image, Offset(image, resourcesGetter + 0x27, addressBase, 12), 0x48, 0x8d, 0x05)
                || !Match(image, Offset(image, resourcesGetter + 0x2e, addressBase, 5), 0x48, 0x83, 0xc4, 0x28, 0xc3)) return false;
            long resources = Relative(image, resourcesGetter + 0x27, addressBase);
            if (Offset(image, network, addressBase, 8) < 0 || Offset(image, resources, addressBase, 0x90) < 0) return false;
            // The property atom is hash-confirmed as "mShiny". Its getter reads
            // record+0x11 as a boolean, rather than a resource's authored flag.
            int matches = 0;
            for (int at = 24; at <= image.Length - 24; at += 8)
                if (BitConverter.ToUInt32(image, at) == 0xc1ed7aca && BitConverter.ToUInt32(image, at - 24) == 0x76903fb2
                    && Hash(image, Offset(image, BitConverter.ToInt64(image, at + 8), addressBase, 0x2d), 0x2d,
                        "d1f01b7c2ca35a99ed2f9c9186a973f4ca8ba85937ff9d837fc28bd6284a2012")) matches++;
            if (matches != 1) return false;
            profile = new WorldDropShiny(addressBase, image.Length, region, drop, scene, local, client, clientId, find, item, aspect, network, resources);
            return true;
        }
        catch { profile = null; return false; }
    }

    sealed class Snapshot
    {
        readonly Func<long, byte[], int, bool> read;
        readonly Dictionary<long, byte[]> values = new Dictionary<long, byte[]>();
        public Snapshot(Func<long, byte[], int, bool> callback) { read = callback; }
        public byte[] Bytes(long address, int size)
        {
            if (address < 65536 || size < 1 || size > 4096 || address > long.MaxValue - size || values.Count > 512) throw new InvalidOperationException();
            byte[] value;
            if (values.TryGetValue(address, out value)) { if (value.Length != size) throw new InvalidOperationException(); return value; }
            value = new byte[size]; if (!read(address, value, size)) throw new InvalidOperationException(); values.Add(address, value); return value;
        }
        public long Ptr(long at) { return BitConverter.ToInt64(Bytes(at, 8), 0); }
        public uint UInt(long at) { return BitConverter.ToUInt32(Bytes(at, 4), 0); }
        public byte Byte(long at) { return Bytes(at, 1)[0]; }
        public bool Stable()
        {
            foreach (var pair in values)
            {
                byte[] next = new byte[pair.Value.Length]; if (!read(pair.Key, next, next.Length)) return false;
                for (int i = 0; i < next.Length; i++) if (next[i] != pair.Value[i]) return false;
            }
            return true;
        }
    }
    bool Code(Snapshot s, long function, params byte[] expected)
    {
        return function >= moduleBase && function <= moduleEnd - expected.Length && Match(s.Bytes(function, expected.Length), 0, expected);
    }
    long Slot(Snapshot s, long obj, int slot) { return s.Ptr(s.Ptr(obj) + slot); }
    bool Compact(Snapshot s, long address, out byte[] value)
    {
        value = null; byte[] descriptor = s.Bytes(address, 16); int length;
        if (descriptor[15] == 0xff) { length = (int)(BitConverter.ToUInt32(descriptor, 8) & 0xfffffff); if (length > 256) return false; value = length == 0 ? new byte[0] : s.Bytes(BitConverter.ToInt64(descriptor, 0), length); }
        else { if (descriptor[15] > 15) return false; length = 15 - descriptor[15]; value = new byte[length]; Array.Copy(descriptor, value, length); }
        return true;
    }
    static int Hex(byte value) { return value >= '0' && value <= '9' ? value - '0' : value >= 'a' && value <= 'f' ? value - 'a' + 10 : value >= 'A' && value <= 'F' ? value - 'A' + 10 : -1; }

    internal static bool Replay(uint pickupSeed, byte advances, int context, ulong sceneSeed)
    {
        unchecked
        {
            ulong state = pickupSeed;
            for (int i = 0; i < advances; i++) state = state * Multiplier + Increment;
            state = (state | ((ulong)(long)context << 32)) ^ sceneSeed;
            state = state * Multiplier + Increment;
            state = state * Multiplier + Increment;
            // U24 / 2^24 <= binary64(0.0005), exactly K <= 8388.
            return ((state >> 38) & 0xffffffUL) <= 8388UL;
        }
    }

    public bool TryRead(Func<long, byte[], int, bool> read, long region, long pickup, long store,
        Func<long, long> resolveResource, out bool shiny)
    {
        shiny = false;
        try
        {
            if (read == null || resolveResource == null) return false;
            var s = new Snapshot(read);
            if (s.Ptr(region) != regionVtable || s.Ptr(pickup) != dropVtable || Slot(s, region, 0x3e8) != localGetter) return false;
            long canonical = s.Ptr(store + 0x28), item = resolveResource(canonical);
            if (canonical < 65536 || item < 65536 || s.Ptr(item + 8) != canonical || Slot(s, item, 0x290) != itemGenerator) return false;
            long manifestType = s.Ptr(item + 0x1cf8);
            if (manifestType != 0)
            {
                long manifest = resolveResource(manifestType);
                if (manifest < 65536 || s.Ptr(manifest + 8) != manifestType || Slot(s, manifest, 0x290) != aspectGenerator) return false;
                long encoder = Slot(s, manifest, 0x4a8);
                if (encoder < moduleBase || encoder > moduleEnd - 0x8e
                    || !Hash(s.Bytes(encoder, 0x8e), 0, 0x8e, "ed17d4885602fcf09e843465d571c37825a7938480190c008046bf73ddcaded4")) return false;
            }
            if (!Code(s, Slot(s, item, 0x200), 0x0f, 0xb6, 0x81, 0xb9, 0x04, 0, 0, 0xc3)) return false;
            byte ignore = s.Byte(item + 0x51e), category = s.Byte(item + 0x4b9);
            if (ignore > 1) return false;
            // A verified native skipped-generation branch leaves the freshly
            // constructed mShiny byte zero; this is observed eligibility, not a default.
            if (ignore == 1 || category != 1 && category != 5) return s.Stable();
            long locals = s.Ptr(region + 0x230); uint localBytes = s.UInt(region + 0x238);
            if (localBytes == 0 || localBytes > 1024 || (localBytes & 7) != 0) return false;
            long player = 0;
            for (int i = 0; i < localBytes; i += 8)
            {
                long candidate = s.Ptr(s.Ptr(locals + i));
                if (candidate < 65536 || (s.Byte(candidate + 0x20) & 1) != 0) continue;
                if (!Code(s, Slot(s, candidate, 0xb0), 0x0f, 0xb6, 0x81, 0x88, 0x02, 0, 0, 0xc3)) return false;
                if (s.Byte(candidate + 0x288) != 0) { player = candidate; break; }
            }
            if (player == 0 || Slot(s, player, 0x100) != clientGetter) return false;
            long scene = s.Ptr(s.Ptr(region + 0x240));
            if (Slot(s, scene, 0x760) != sceneGetter) return false;
            long manager = s.Ptr(s.Ptr(networkGlobal));
            if (!Code(s, Slot(s, manager, 0x148), 0x83, 0xb9, 0x68, 0x01, 0, 0, 0x04, 0x0f, 0x94, 0xc0, 0xc3)
                || s.UInt(manager + 0x168) != 4 || Slot(s, manager, 0xb8) != findClient) return false;
            long clients = s.Ptr(manager + 0x230); uint clientBytes = s.UInt(manager + 0x238);
            if (clientBytes == 0 || clientBytes > 64 || (clientBytes & 7) != 0) return false;
            long client = 0;
            for (int i = 0; i < clientBytes; i += 8)
            {
                long candidate = s.Ptr(s.Ptr(clients + i));
                if (!Code(s, Slot(s, candidate, 0x18), 0x48, 0x8b, 0x81, 0xe8, 0x01, 0, 0, 0xc3)) return false;
                if (s.Ptr(candidate + 0x1e8) == 0) { if (client != 0) return false; client = candidate; }
            }
            if (client == 0 || Slot(s, client, 0x90) != clientIdGetter
                || !Code(s, Slot(s, client, 0x378), 0x48, 0x8b, 0x81, 0x10, 0x02, 0, 0, 0x48, 0x8b, 0, 0xc3)) return false;
            long session = s.Ptr(s.Ptr(client + 0x210));
            if (!Code(s, Slot(s, session, 0x2a8), 0x48, 0x8d, 0x81, 0x90, 0xa9, 0, 0, 0xc3)) return false;
            ulong sceneValue = (ulong)s.Ptr(session + 0xa990);
            if ((ulong)s.Ptr(scene + 0x7f8) != sceneValue) return false;
            byte[] first, second;
            if (!Compact(s, client + 0x128, out first) || !Compact(s, client + 0x148, out second)) return false;
            byte[] identity = second.Length == 0 ? first : second;
            if (identity.Length < 8) return false;
            int context = 0;
            for (int i = 2; i < 8; i++) { int nibble = Hex(identity[i]); if (nibble < 0) return false; context = (context << 4) | nibble; }
            bool result = Replay(s.UInt(pickup + 0x988), s.Byte(pickup + 0x98c), context, ~sceneValue);
            if (!s.Stable()) return false;
            shiny = result; return true;
        }
        catch { shiny = false; return false; }
    }
}
