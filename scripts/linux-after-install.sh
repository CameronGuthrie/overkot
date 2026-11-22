# Appended to electron-builder's default Debian/Arch install hook during preparation.
# Only these game-specific native helpers receive process-read capability.
# Use fixed system paths: Debian ships setcap under /usr/sbin, Arch under /usr/bin.
if [ -x '/usr/sbin/setcap' ]; then
    setcap_binary='/usr/sbin/setcap'
elif [ -x '/usr/bin/setcap' ]; then
    setcap_binary='/usr/bin/setcap'
else
    echo 'Overkot: the system setcap utility is missing.' >&2
    exit 1
fi
getcap_binary="${setcap_binary%/setcap}/getcap"
if [ ! -x "$getcap_binary" ]; then
    echo 'Overkot: the system getcap utility is missing.' >&2
    exit 1
fi
for scanner in '/opt/Overkot/resources/bin/overkot-session-scanner' '/opt/Overkot/resources/bin/overkot-position-reader' '/opt/Overkot/resources/bin/overkot-position-reader-core'; do
    for scanner_path in '/opt' '/opt/Overkot' '/opt/Overkot/resources' '/opt/Overkot/resources/bin' "$scanner"; do
        if [ -L "$scanner_path" ]; then
            echo 'Overkot: refusing to configure a symlinked game reader path.' >&2
            exit 1
        fi
        if [ "$scanner_path" != "$scanner" ]; then
            if [ ! -d "$scanner_path" ]; then
                echo 'Overkot: the game reader directory is missing.' >&2
                exit 1
            fi
            scanner_owner=$(stat -c '%u:%g' "$scanner_path") || exit 1
            scanner_mode=$(stat -c '%a' "$scanner_path") || exit 1
            if [ "$scanner_owner" != '0:0' ] || [ $((0$scanner_mode & 022)) -ne 0 ]; then
                echo 'Overkot: game reader directories must be owned by root and not writable by other users.' >&2
                exit 1
            fi
        fi
    done
    if [ ! -f "$scanner" ]; then
        echo "Overkot: the packaged game reader is missing: $scanner" >&2
        exit 1
    fi
    chown root:root "$scanner" || exit 1
    chmod 0755 "$scanner" || exit 1
    if [ "$scanner" = '/opt/Overkot/resources/bin/overkot-position-reader-core' ]; then
        # The runtime starts only after the small C launcher drops capabilities.
        # The companion must never acquire file capabilities of its own.
        scanner_capabilities=$("$getcap_binary" "$scanner") || exit 1
        if [ -n "$scanner_capabilities" ]; then
            "$setcap_binary" -r "$scanner" || exit 1
        fi
    elif ! "$setcap_binary" cap_sys_ptrace=ep "$scanner"; then
        echo 'Overkot: could not enable a game reader capability on this filesystem.' >&2
        exit 1
    fi
done
