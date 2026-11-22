#!/bin/bash
# FPM defines post_install before inserting this into Pacman's post_upgrade.
# Reuse the rendered install hook to restore links, sandbox mode and scanner capability.
post_install "$@"
