#define _GNU_SOURCE
/* Game-only, read-only session scanner. The DEB grants only this executable
 * CAP_SYS_PTRACE; Electron stays unprivileged. No memory contents or addresses
 * are accepted over IPC or returned to the application. */
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <time.h>
#include <unistd.h>

#define CHUNK (512 * 1024)
#define CARRY 160
#define MAX_REGIONS 65536
#define MAX_NONCES 32
#define MAX_ACCOUNTS 16

typedef struct { uint64_t start, end; int priority; } Region;
static char accounts[MAX_ACCOUNTS][25], nonces[MAX_NONCES][21];
static unsigned account_count, nonce_count;
static uint64_t next_region, next_offset;

static const char *access_error(void) {
    if (errno == EACCES || errno == EPERM) return "permission-denied";
    if (errno == ENOENT || errno == ESRCH) return "process-gone";
    return "scan-failed";
}

static int finish(const char *error) {
    printf("{\"accountIds\":[");
    for (unsigned i = 0; i < account_count; ++i) printf("%s\"%s\"", i ? "," : "", accounts[i]);
    printf("],\"nonces\":[");
    for (unsigned i = 0; i < nonce_count; ++i) printf("%s\"%s\"", i ? "," : "", nonces[i]);
    printf("],\"error\":\"%s\",\"nextRegion\":%" PRIu64 ",\"nextOffset\":%" PRIu64 "}\n", error, next_region, next_offset);
    return 0;
}

static bool number(const char *text, uint64_t *value) {
    if (!text || !*text) return false;
    for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return false;
    errno = 0;
    char *end;
    *value = strtoull(text, &end, 10);
    return !errno && !*end && *value <= UINT64_C(9007199254740991);
}

static const char *target_error(int directory) {
    int status_fd = openat(directory, "status", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (status_fd < 0) return access_error();
    FILE *status = fdopen(status_fd, "r");
    if (!status) { close(status_fd); return "scan-failed"; }
    char line[512];
    bool uid_ok = false;
    while (fgets(line, sizeof line, status)) {
        unsigned long real, effective, saved, filesystem;
        if (sscanf(line, "Uid: %lu %lu %lu %lu", &real, &effective, &saved, &filesystem) == 4) {
            uid_t caller = getuid();
            uid_ok = caller != 0 && caller == geteuid() && real == caller && effective == caller
                && saved == caller && filesystem == caller;
            break;
        }
    }
    const char *error = ferror(status) ? access_error() : "";
    fclose(status);
    if (*error) return error;
    if (!uid_ok) return "wrong-process";
    int comm_fd = openat(directory, "comm", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (comm_fd < 0) return access_error();
    char comm[64] = {0};
    ssize_t length = read(comm_fd, comm, sizeof comm - 1);
    error = length < 0 ? access_error() : "";
    close(comm_fd);
    if (*error) return error;
    if (!length) return "process-gone";
    comm[strcspn(comm, "\r\n")] = 0;
    /* Linux task names truncate the Windows executable name at 15 bytes. */
    return !strcasecmp(comm, "Soulframe.x64.e") || !strcasecmp(comm, "Soulframe.x64.exe") ? "" : "wrong-process";
}

static bool drop_capabilities(void) {
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    return syscall(SYS_capset, &header, data) == 0;
}

static int region_order(const void *left, const void *right) {
    const Region *a = left, *b = right;
    if (a->priority != b->priority) return a->priority - b->priority;
    return (a->start > b->start) - (a->start < b->start);
}

static uint64_t milliseconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static unsigned byte_at(const unsigned char *data, size_t size, size_t offset, size_t stride) {
    if (offset >= size || (stride == 2 && (offset + 1 >= size || data[offset + 1]))) return 256;
    return data[offset];
}

static bool literal(const unsigned char *data, size_t size, size_t offset, size_t stride, const char *text) {
    for (; *text; ++text, offset += stride) {
        unsigned value = byte_at(data, size, offset, stride);
        if (value > 255 || tolower((unsigned char)value) != tolower((unsigned char)*text)) return false;
    }
    return true;
}

static void add_account(const char *account) {
    for (unsigned i = 0; i < account_count; ++i) if (!strcmp(account, accounts[i])) return;
    if (account_count < MAX_ACCOUNTS) strcpy(accounts[account_count++], account);
}

static void extract(const unsigned char *data, size_t size, size_t offset, size_t stride) {
    char account[25] = {0}, nonce[21] = {0};
    size_t cursor = offset;
    if (literal(data, size, cursor, stride, "accountId=")) {
        cursor += 10 * stride;
        for (unsigned i = 0; i < 24; ++i, cursor += stride) {
            unsigned value = byte_at(data, size, cursor, stride);
            if (value > 255 || !isxdigit((unsigned char)value)) return;
            account[i] = (char)tolower((unsigned char)value);
        }
    }
    unsigned prefix = byte_at(data, size, cursor, stride);
    if (prefix != '&' && prefix != '?') return;
    if (!literal(data, size, cursor + stride, stride, "nonce=")) return;
    cursor += 7 * stride;
    unsigned count = 0, repeated = 0, previous = 256;
    while (count < 20) {
        unsigned value = byte_at(data, size, cursor, stride);
        if (value < '0' || value > '9') break;
        repeated = value == previous ? repeated + 1 : 1;
        if (repeated >= 5) return;
        previous = value;
        nonce[count++] = (char)value;
        cursor += stride;
    }
    if (count < 5 || !literal(data, size, cursor, stride, "&ct=MSI")) return;
    if (*account) add_account(account);
    for (unsigned i = 0; i < nonce_count; ++i) if (!strcmp(nonce, nonces[i])) return;
    if (nonce_count < MAX_NONCES) strcpy(nonces[nonce_count++], nonce);
}

int main(int argc, char **argv) {
    uint64_t pid, start_region = 0, start_offset = 0;
    if (argc != 5 || !number(argv[1], &pid) || !pid || pid > INT32_MAX
        || (strcmp(argv[2], "normal") && strcmp(argv[2], "extended"))
        || !number(argv[3], &start_region) || !number(argv[4], &start_offset)) return finish("scan-failed");
    bool extended = !strcmp(argv[2], "extended");
    const uint64_t budget = (extended ? 512ULL : 128ULL) * 1024 * 1024;
    const uint64_t deadline = milliseconds() + (extended ? 10000 : 5000);
    char proc_path[64];
    snprintf(proc_path, sizeof proc_path, "/proc/%" PRIu64, pid);
    int directory = open(proc_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) return finish(access_error());
    struct statfs filesystem;
    if (fstatfs(directory, &filesystem) || filesystem.f_type != PROC_SUPER_MAGIC) {
        close(directory); return finish("wrong-process");
    }
    const char *error = target_error(directory);
    if (*error) { close(directory); return finish(error); }
    int maps_fd = openat(directory, "maps", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (maps_fd < 0) { error = access_error(); close(directory); return finish(error); }
    int mem_fd = openat(directory, "mem", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (mem_fd < 0) error = access_error();
    if (!*error) error = target_error(directory);
    close(directory);
    /* Open descriptors pin this process's memory. Drop all capabilities before
     * processing map text or scanning data; no child process is ever spawned. */
    if (!drop_capabilities()) error = "scan-failed";
    if (*error) {
        if (maps_fd >= 0) close(maps_fd);
        if (mem_fd >= 0) close(mem_fd);
        return finish(error);
    }
    FILE *maps = fdopen(maps_fd, "r");
    Region *regions = calloc(MAX_REGIONS, sizeof *regions);
    unsigned char *buffer = malloc(CHUNK + CARRY);
    if (!maps || !regions || !buffer) {
        if (maps) fclose(maps); else close(maps_fd);
        close(mem_fd); free(regions); free(buffer); return finish("scan-failed");
    }
    size_t total = 0;
    char line[4096], permissions[5];
    uint64_t start, end;
    while (fgets(line, sizeof line, maps)) {
        if (total == MAX_REGIONS) { error = "scan-failed"; break; }
        if (sscanf(line, "%" SCNx64 "-%" SCNx64 " %4s", &start, &end, permissions) != 3
            || permissions[0] != 'r' || end <= start || end > INT64_MAX) continue;
        regions[total++] = (Region){start, end, strstr(line, "[heap]") ? 0 : permissions[1] == 'w' ? 1 : 2};
    }
    fclose(maps);
    if (!total) error = "scan-failed";
    qsort(regions, total, sizeof *regions, region_order);
    uint64_t attempted = 0, read_bytes = 0;
    if (start_region >= total) { start_region = 0; start_offset = 0; }
    for (size_t visit = 0; !*error && visit < total; ++visit) {
        size_t index = (start_region + visit) % total;
        Region region = regions[index];
        uint64_t offset = visit == 0 && start_offset < region.end - region.start ? start_offset : 0;
        if (offset > CARRY) offset -= CARRY; else offset = 0;
        size_t carry = 0;
        while (offset < region.end - region.start) {
            next_region = index; next_offset = offset;
            if (attempted >= budget || milliseconds() >= deadline) goto done;
            size_t length = CHUNK;
            if (length > region.end - region.start - offset) length = (size_t)(region.end - region.start - offset);
            if (length > budget - attempted) length = (size_t)(budget - attempted);
            attempted += length;
            ssize_t count = pread(mem_fd, buffer + carry, length, (off_t)(region.start + offset));
            if (count <= 0) {
                if (count < 0 && (errno == EACCES || errno == EPERM || errno == ESRCH)) { error = access_error(); goto done; }
                offset += length; carry = 0; continue;
            }
            read_bytes += (uint64_t)count;
            size_t size = carry + (size_t)count;
            for (size_t i = 0; i < size; ++i) {
                if (buffer[i] != '&' && buffer[i] != '?' && buffer[i] != 'a' && buffer[i] != 'A') continue;
                extract(buffer, size, i, 1);
                if (i + 1 < size && buffer[i + 1] == 0) extract(buffer, size, i, 2);
                if (nonce_count == MAX_NONCES) {
                    next_offset = offset + (i >= carry ? i - carry + 1 : 1);
                    goto done;
                }
            }
            carry = size < CARRY ? size : CARRY;
            memmove(buffer, buffer + size - carry, carry);
            offset += (uint64_t)count;
        }
        next_region = (index + 1) % total; next_offset = 0;
    }
done:
    if (!*error && attempted && !read_bytes) error = "scan-failed";
    close(mem_fd); free(regions); free(buffer);
    return finish(error);
}
