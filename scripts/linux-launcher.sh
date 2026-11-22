#!/bin/sh
# Electron initializes Ozone before the JavaScript main process can select X11.
# Resolve the packaged launcher symlink so native packages and AppImages share
# the same early display selection without altering Chromium's sandbox flags.
set -eu
launcher_path=$(readlink -f -- "$0")
runtime_directory=$(dirname -- "$launcher_path")
runtime="$runtime_directory/overkot-bin"

if [ "${ELECTRON_RUN_AS_NODE:-}" = 1 ]; then
  exec "$runtime" "$@"
fi

platform_found=0
platform_hint=
remaining=$#
options_ended=0
# Rotate only the original positional arguments. This preserves spaces and
# quotes without eval, while removing Electron 40's invalid platform=auto.
while [ "$remaining" -gt 0 ]; do
  argument=$1
  shift
  remaining=$((remaining - 1))
  if [ "$options_ended" = 1 ]; then
    set -- "$@" "$argument"
    continue
  fi
  case "$argument" in
    --)
      options_ended=1
      set -- "$@" "$argument"
      ;;
    --ozone-platform=auto)
      if [ -n "${DISPLAY:-}" ]; then
        set -- "$@" --ozone-platform=x11
        platform_found=1
      fi
      ;;
    --ozone-platform=*)
      platform_found=1
      set -- "$@" "$argument"
      ;;
    --ozone-platform)
      if [ "$remaining" -gt 0 ]; then
        platform=$1
        shift
        remaining=$((remaining - 1))
        if [ "$platform" = auto ]; then
          if [ -n "${DISPLAY:-}" ]; then
            set -- "$@" --ozone-platform=x11
            platform_found=1
          fi
        else
          platform_found=1
          set -- "$@" "$argument" "$platform"
        fi
      else
        platform_found=1
        set -- "$@" "$argument"
      fi
      ;;
    --ozone-platform-hint=x11|--ozone-platform-hint=wayland)
      platform_hint=${argument#--ozone-platform-hint=}
      set -- "$@" "$argument"
      ;;
    *)
      set -- "$@" "$argument"
      ;;
  esac
done

if [ "$platform_found" = 0 ]; then
  if [ -n "$platform_hint" ]; then
    exec "$runtime" "--ozone-platform=$platform_hint" "$@"
  elif [ -n "${DISPLAY:-}" ]; then
    exec "$runtime" --ozone-platform=x11 "$@"
  fi
fi
exec "$runtime" "$@"
