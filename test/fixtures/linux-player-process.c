#define _GNU_SOURCE
/* Synthetic Wine-style loaded PE and typed objects for Linux native reader QA.
 * No game binaries, captures, credentials or fixed production addresses. */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <unistd.h>

enum { IMAGE_BYTES = 0x10000, CODE = 0x1000, DATA = 0x7000, META = 0xb000 };
static unsigned char *image, *heap;
static int records[5], registrations[5], factories[5], vtables[5], getters[6];
static const char *names[] = {"HumanPlayer", "SFHumanPlayer", "ContextImpl", "RegionMgrImpl", "LevelInfo"};

static void bytes(int at, const unsigned char *value, size_t size) { memcpy(image + at, value, size); }
#define PUT(at, ...) do { const unsigned char value[] = {__VA_ARGS__}; bytes((at), value, sizeof value); } while (0)
static void u16(int at, uint16_t value) { memcpy(image + at, &value, 2); }
static void i32(int at, int32_t value) { memcpy(image + at, &value, 4); }
static void ptr(int at, uintptr_t value) { memcpy(image + at, &value, 8); }
static void hp(int at, uintptr_t value) { memcpy(heap + at, &value, 8); }
static uintptr_t ip(int at) { return (uintptr_t)(image + at); }
static uintptr_t h(int at) { return (uintptr_t)(heap + at); }
static void lea(int at, unsigned char prefix, unsigned char reg, int target) {
    PUT(at, prefix, 0x8d, reg); i32(at + 3, target - at - 7);
}
static void section(int index, const char *name, int start, int size, uint32_t flags) {
    int at = 0x188 + index * 40;
    memcpy(image + at, name, strlen(name)); i32(at + 8, size); i32(at + 12, start); i32(at + 36, (int32_t)flags);
}
static void registration(int index, int at, int record, int parent) {
    static const int sizes[] = {0x15d0, 0x3c90, 0x158, 0x9d0, 0x1210};
    lea(at, 0x48, 0x15, DATA + 0x100 + index * 0x40);
    PUT(at + 7, 0x48, 0x8d, 0x4c, 0x24, 0x50, 0xe8); i32(at + 13, CODE + 0x4900 - at - 17);
    lea(at + 0x11, 0x48, 0x15, DATA + 0x100 + index * 0x40);
    PUT(at + 0x18, 0x48, 0x8d, 0x4c, 0x24, 0x58, 0x8b, 0x18, 0xe8); i32(at + 0x20, CODE + 0x4900 - at - 0x24);
    lea(at + 0x2c, 0x48, 0x0d, factories[index]);
    PUT(at + 0x33, 0xc7, 0x44, 0x24, 0x30); i32(at + 0x37, sizes[index]);
    lea(at + 0x3b, 0x4c, 0x0d, parent); PUT(at + 0x42, 0x48, 0x89, 0x4c, 0x24, 0x28, 0x44, 0x8b, 0xc3, 0x8b, 0x10);
    lea(at + 0x4c, 0x48, 0x0d, record);
    PUT(at + 0x53, 0xc6, 0x44, 0x24, 0x20, 0x00, 0xe8); i32(at + 0x59, CODE + 0x4a00 - at - 0x5d);
}
static void profile(void) {
    u16(0, 0x5a4d); i32(0x3c, 0x80); i32(0x80, 0x4550);
    u16(0x84, 0x8664); u16(0x86, 3); u16(0x94, 240); u16(0x98, 0x20b); i32(0xd0, IMAGE_BYTES);
    section(0, ".text", CODE, 0x5000, 0x60000000);
    section(1, ".rdata", DATA, 0x4000, 0x40000000);
    section(2, ".data", META, 0x3000, 0xc0000000);
    for (int i = 0; i < 5; i++) {
        records[i] = META + 0x200 + i * 0x100;
        registrations[i] = CODE + 0x100 + i * 0x100;
        factories[i] = CODE + 0x1000 + i * 0x100;
        vtables[i] = DATA + 0x400 + i * 0x400;
    }
    for (int i = 0; i < 6; i++) getters[i] = CODE + 0x4000 + i * 0x100;
    PUT(getters[0], 0x48, 0x8b, 0x81, 0x48, 0x01, 0x00, 0x00, 0x48, 0x8b, 0x00, 0xc3);
    PUT(getters[1], 0x48, 0x8b, 0x81, 0xd0, 0x00, 0x00, 0x00, 0x48, 0x8b, 0x00, 0x48, 0x85, 0xc0, 0x75, 0x02, 0xcd, 0x2c, 0xc3);
    PUT(getters[2], 0x48, 0x8d, 0x41, 0x70, 0xc3);
    PUT(getters[3], 0x8b, 0x81, 0x08, 0x02, 0x00, 0x00, 0x48, 0xc1, 0xe8, 0x03, 0xc3);
    image[getters[4] - 1] = image[getters[5] - 1] = 0xcc;
    PUT(getters[4], 0x48, 0x8d, 0x81, 0xd0, 0x00, 0x00, 0x00, 0xc3);
    PUT(getters[5], 0x48, 0x8d, 0x81, 0xa0, 0x00, 0x00, 0x00, 0xc3);
    image[CODE + 0x4800] = image[CODE + 0x4900] = image[CODE + 0x4a00] = 0xc3;
    ptr(DATA + 0x3000, ip(CODE + 0x4800));
    for (int i = 0; i < 5; i++) {
        int parent = i == 1 ? records[0] : META + 0x1800 + i * 0x100;
        ptr(records[i], ip(DATA + 0x3000)); ptr(records[i] + 0x18, ip(parent)); ptr(parent, ip(DATA + 0x3000));
        for (int slot = 0; slot < 12; slot++) ptr(vtables[i] + slot * 8, ip(CODE + 0x4800));
        memcpy(image + DATA + 0x100 + i * 0x40, names[i], strlen(names[i]) + 1);
        registration(i, registrations[i], records[i], parent);
        image[factories[i]] = 0xe9; i32(factories[i] + 1, 0x20 - 5);
        lea(factories[i] + 0x20, 0x48, 0x05, vtables[i]); PUT(factories[i] + 0x27, 0x48, 0x89, 0x03);
    }
    ptr(vtables[3] + 0x258, ip(getters[3]));
}
static void matrix(int at, float x, float y, float z, int quarter_turn) {
    float value[16] = {1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1};
    if (quarter_turn) { value[0] = value[10] = 0; value[2] = -1; value[8] = 1; }
    memcpy(heap + at, value, sizeof value);
}
static void objects(int player) {
    hp(player, ip(vtables[1])); hp(player + 8, ip(records[1]));
    hp(player + 0x148, h(0x100)); hp(0x100, h(0x2000));
    hp(player + 0xd0, h(0x108)); hp(0x108, h(0x3000));
    hp(0x2000, ip(vtables[0])); matrix(0x20a0, 10,20,30,1);
    hp(0x3000, ip(vtables[0])); matrix(0x3030, 0,0,0,0);
    hp(0x21e0, h(0x4000)); hp(0x4000, ip(vtables[2])); hp(0x4008, ip(records[2]));
    hp(0x4090, h(0x110)); hp(0x110, h(0x5000)); hp(0x5000, ip(vtables[3])); hp(0x5008, ip(records[3]));
    hp(0x5200, h(0x6000)); uint32_t size = 24; memcpy(heap + 0x5208, &size, sizeof size);
    for (int i = 0; i < 3; i++) {
        int at = 0x7000 + i * 0x1000;
        hp(0x6000 + i * 8, h(0x6100 + i * 8)); hp(0x6100 + i * 8, h(at));
        hp(at, ip(vtables[4])); hp(at + 8, ip(records[4])); hp(at + 0x1e0, h(0x4000));
        matrix(at + 0xa0, (float)(i * 100), 1000, (float)(i * i * 50), i == 1);
    }
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    const char *mode = argv[1];
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || prctl(PR_SET_NAME, !strcmp(mode, "unrelated") ? "overkot-fixture" : "Soulframe.x64.e", 0,0,0)) return 3;
    if (strcmp(mode, "blocked") && prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0,0,0)) return 4;
    int fd = open(argv[2], O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0 || ftruncate(fd, IMAGE_BYTES)) return 5;
    image = mmap(NULL, IMAGE_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0); close(fd);
    heap = mmap(NULL, IMAGE_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (image == MAP_FAILED || heap == MAP_FAILED) return 6;
    profile(); objects(0x1000);
    if (!strcmp(mode, "malformed")) image[0] = 0;
    if (!strcmp(mode, "profile-mismatch")) image[getters[0]] = 0x90;
    if (!strcmp(mode, "ambiguous")) objects(0xa000);
    if (!strcmp(mode, "invalid-pose")) { float nan = __builtin_nanf(""); memcpy(heap + 0x20a0, &nan, sizeof nan); }
    if (mprotect(image, 0x1000, PROT_READ) || mprotect(image + CODE, 0x5000, PROT_READ | PROT_EXEC) || mprotect(image + DATA, 0x4000, PROT_READ)) return 7;
    puts("READY"); fflush(stdout);
    for (;;) pause();
}
