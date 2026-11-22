#!/bin/bash
# Administrative QA in an isolated CI container; Electron runs as an ordinary user.
set -euo pipefail
format="${1:?Pass deb or arch}"
version=$(node -p 'require("./package.json").version')
scanner='/opt/Overkot/resources/bin/overkot-session-scanner'
position_reader='/opt/Overkot/resources/bin/overkot-position-reader'
position_core='/opt/Overkot/resources/bin/overkot-position-reader-core'
position_notices='/opt/Overkot/resources/bin/overkot-position-reader-NOTICES.txt'
useradd --uid 1010 --create-home overkot-qa
install -d -o 1010 -g 1010 output

if [ "$format" = 'deb' ]; then
  package="$PWD/dist/overkot-$version-linux-amd64.deb"
  apt-get install --no-install-recommends -y "$package"
elif [ "$format" = 'arch' ]; then
  package="$PWD/dist/overkot-$version-linux-x64.pkg.tar.xz"
  pacman -U --noconfirm "$package"
else
  echo 'Unknown native package format.' >&2
  exit 1
fi
getcap "$scanner" | grep -q 'cap_sys_ptrace=ep'
getcap "$position_reader" | grep -q 'cap_sys_ptrace=ep'
runuser -u overkot-qa -- test -x "$position_reader"
runuser -u overkot-qa -- test -x "$position_core"
runuser -u overkot-qa -- test -r "$position_notices"
grep -q 'OpenSSL distribution notices' "$position_notices"
test -z "$(getcap "$position_core")"
test "$(stat -c '%u:%g:%a' "$position_core")" = '0:0:755'
node scripts/check-linux-scanner.js "$scanner"
OVERKOT_POSITION_QA_UID=1010 OVERKOT_POSITION_READER="$position_reader" node --test test/linuxPositionReaderNative.test.js
runuser -u overkot-qa -- env OVERKOT_PACKAGED_DIRECTORY='/opt/Overkot' xvfb-run -a node scripts/check-edge-dock-package.js

# Reinstallation must restore the launcher and narrowly scoped scanner capability.
setcap -r "$scanner"
setcap -r "$position_reader"
if [ "$format" = 'deb' ]; then
  apt-get install --reinstall --no-install-recommends -y "$package"
else
  pacman -U --noconfirm "$package"
fi
getcap "$scanner" | grep -q 'cap_sys_ptrace=ep'
getcap "$position_reader" | grep -q 'cap_sys_ptrace=ep'
test -z "$(getcap "$position_core")"
test "$(stat -c '%u:%g:%a' "$position_core")" = '0:0:755'
test -x /usr/bin/overkot

appimage="$PWD/dist/overkot-$version-linux-x86_64.AppImage"
chmod 0755 "$appimage"
install -d -o 1010 -g 1010 output/appimage-extracted
(cd output/appimage-extracted && runuser -u overkot-qa -- "$appimage" --appimage-extract >/dev/null)
image_directory="$PWD/output/appimage-extracted/squashfs-root"
# Extraction does not preserve the setuid bit; configure only the isolated QA copy.
chown root:root "$image_directory/chrome-sandbox"
chmod 4755 "$image_directory/chrome-sandbox"
runuser -u overkot-qa -- test -x "$image_directory/overkot"
runuser -u overkot-qa -- test -x "$image_directory/resources/bin/overkot-position-reader"
runuser -u overkot-qa -- test -x "$image_directory/resources/bin/overkot-position-reader-core"
runuser -u overkot-qa -- test -r "$image_directory/resources/bin/overkot-position-reader-NOTICES.txt"
test -z "$(getcap "$image_directory/resources/bin/overkot-position-reader-core")"
OVERKOT_POSITION_QA_UID=1010 OVERKOT_POSITION_READER="$image_directory/resources/bin/overkot-position-reader" node --test test/linuxPositionReaderNative.test.js
runuser -u overkot-qa -- env OVERKOT_PACKAGED_DIRECTORY="$image_directory" xvfb-run -a node scripts/check-edge-dock-package.js

if [ "$format" = 'deb' ]; then
  apt-get remove -y overkot
else
  pacman -R --noconfirm overkot
fi
test ! -e "$scanner"
test ! -e "$position_reader"
test ! -e "$position_core"
test ! -e "$position_notices"
test ! -e /usr/bin/overkot
echo "PASS: $format install, native scanner, packaged renderers, reinstall, AppImage extraction and removal."
