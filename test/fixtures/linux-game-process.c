#define _GNU_SOURCE
/* Synthetic process used only by the isolated Linux scanner integration check. */
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "game") && strcmp(argv[1], "unrelated"))) return 2;
    const char *name = !strcmp(argv[1], "game") ? "Soulframe.x64.e" : "overkot-fixture";
    if (prctl(PR_SET_NAME, name, 0, 0, 0)) return 3;
    unsigned char *memory = mmap(NULL, 1024 * 1024, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (memory == MAP_FAILED) return 4;
    const char *ascii = "accountId=abcdef0123456789abcdef01&nonce=246813579&ct=MSI";
    /* Keep the second complete credential out of ASCII process memory so this
     * assertion genuinely exercises UTF-16LE, including the read boundary. */
    const char *wide_parts[] = {"accountId=", "abcdef0123456789abcdef01", "&nonce=", "975318642", "&ct=MSI"};
    memcpy(memory + 128, ascii, strlen(ascii));
    size_t cursor = 512 * 1024 - 63;
    for (size_t part = 0; part < sizeof wide_parts / sizeof *wide_parts; ++part) {
        for (size_t i = 0; wide_parts[part][i]; ++i) {
            memory[cursor++] = (unsigned char)wide_parts[part][i];
            memory[cursor++] = 0;
        }
    }
    puts("READY");
    fflush(stdout);
    for (;;) pause();
}
