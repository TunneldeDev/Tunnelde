#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
#
# Fails when the repository tracks local artifacts, credentials or personal
# paths. Runs in CI and can be executed locally before pushing.

set -euo pipefail

status=0

while IFS= read -r path; do
  case "$path" in
    .tmp/* | */.tmp/* | node_modules/* | */node_modules/* | \
      src-tauri/target/* | target/* | dist/* | */dist/* | \
      coverage/* | release/* | artifacts/*)
      echo "::error file=$path::tracked local artifact"
      status=1
      ;;
    *.pem | *.key | *.p12 | *.pfx | *.keystore | .env | .env.* | */.env | */.env.*)
      echo "::error file=$path::tracked credential or environment file"
      status=1
      ;;
    .DS_Store | */.DS_Store | Thumbs.db | */Thumbs.db)
      echo "::error file=$path::tracked operating system file"
      status=1
      ;;
  esac
done < <(git ls-files)

if git grep -InE 'C:\\\\Users\\\\|/Users/[a-z]|BEGIN [A-Z ]*PRIVATE KEY' -- \
  ':!*.example' ':!LICENSE' >/tmp/tunnelde-secret-scan 2>/dev/null; then
  echo "::error::personal paths or private keys found in tracked files"
  cat /tmp/tunnelde-secret-scan
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "repository tree is clean"
fi

exit "$status"
