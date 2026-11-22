#define _GNU_SOURCE
/* Open only the selected same-user game before starting the managed runtime.
 * This single-threaded launcher alone receives CAP_SYS_PTRACE. All runtime
 * threads inherit empty capability sets after exec. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>

static int finish(const char *status) {
    printf("{\"type\":\"status\",\"status\":\"%s\",\"processStartUtcTicks\":null,\"moduleHash\":null,\"bytesScanned\":0}\n", status);
    return 4;
}

static const char *access_error(void) {
    return errno == EPERM || errno == EACCES ? "permission-denied" :
        errno == ENOENT || errno == ESRCH ? "process-gone" : "scan-failed";
}

static const char *validate_target(int directory) {
    uid_t caller = getuid();
    if (!caller || caller != geteuid()) return "wrong-process";
    int descriptor = openat(directory, "status", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return access_error();
    FILE *file = fdopen(descriptor, "r");
    if (!file) { close(descriptor); return "scan-failed"; }
    char line[512];
    bool uid_ok = false;
    while (fgets(line, sizeof line, file)) {
        unsigned long real, effective, saved, filesystem;
        if (sscanf(line, "Uid: %lu %lu %lu %lu", &real, &effective, &saved, &filesystem) == 4) {
            uid_ok = real == caller && effective == caller && saved == caller && filesystem == caller;
            break;
        }
    }
    bool read_error = ferror(file);
    fclose(file);
    if (read_error) return "scan-failed";
    if (!uid_ok) return "wrong-process";
    descriptor = openat(directory, "comm", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return access_error();
    char name[64] = {0};
    ssize_t count = read(descriptor, name, sizeof name - 1);
    const char *error = count < 0 ? access_error() : "";
    close(descriptor);
    if (*error) return error;
    if (!count) return "process-gone";
    name[strcspn(name, "\r\n")] = 0;
    return !strcasecmp(name, "Soulframe.x64.e") || !strcasecmp(name, "Soulframe.x64.exe") ? "" : "wrong-process";
}

/* Keep temporary descriptors above the fixed three-descriptor handoff. */
static int pin_descriptor(int descriptor) {
    if (descriptor < 0) return -1;
    int pinned = fcntl(descriptor, F_DUPFD_CLOEXEC, 6);
    int saved = errno;
    close(descriptor);
    errno = saved;
    return pinned;
}

int main(int argc, char **argv) {
    long pid = 0;
    bool probe = false;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--probe") && !probe) probe = true;
        else if (!strcmp(argv[i], "--pid") && !pid && i + 1 < argc) {
            const char *value = argv[++i];
            if (!*value) return finish("invalid-arguments");
            for (const char *p = value; *p; p++) if (*p < '0' || *p > '9') return finish("invalid-arguments");
            char *end;
            errno = 0;
            pid = strtol(value, &end, 10);
            if (errno || *end || pid <= 0 || pid > INT32_MAX) return finish("invalid-arguments");
        } else return finish("invalid-arguments");
    }
    if (!pid) return finish("invalid-arguments");
    char path[64];
    snprintf(path, sizeof path, "/proc/%ld", pid);
    int directory = pin_descriptor(open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (directory < 0) return finish(access_error());
    struct statfs filesystem;
    if (fstatfs(directory, &filesystem) || filesystem.f_type != PROC_SUPER_MAGIC) return finish("wrong-process");
    const char *error = validate_target(directory);
    if (*error) return finish(error);
    int maps = pin_descriptor(openat(directory, "maps", O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
    if (maps < 0) return finish(access_error());
    int memory = pin_descriptor(openat(directory, "mem", O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
    if (memory < 0) return finish(access_error());
    error = validate_target(directory);
    if (*error) return finish(error);
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, data)) return finish("scan-failed");
    // Only pinned read handles survive exec. Never accept a command, library,
    // output path or raw address from the caller.
    if (dup2(directory, 3) < 0 || dup2(maps, 4) < 0 || dup2(memory, 5) < 0) return finish("scan-failed");
    close(directory); close(maps); close(memory);
    if (setenv("OVERKOT_POSITION_READER_FDS", "3,4,5", 1)) return finish("scan-failed");
    char executable[PATH_MAX + 1];
    ssize_t length = readlink("/proc/self/exe", executable, sizeof executable - 1);
    if (length < 1 || length >= (ssize_t)sizeof executable - 1) return finish("unavailable");
    executable[length] = 0;
    char *base = strrchr(executable, '/');
    const char *core = "/overkot-position-reader-core";
    if (!base || (size_t)(base - executable) + strlen(core) >= sizeof executable) return finish("unavailable");
    strcpy(base, core);
    argv[0] = executable;
    execv(executable, argv);
    return finish("unavailable");
}
