#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/yeetbot90/Minerva-archive-ids.git"
TMP_DIR="$(mktemp -d)"
TARGET_DIR="vendor/minerva-archive-ids"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Cloning $REPO_URL ..."
git clone --depth 1 "$REPO_URL" "$TMP_DIR/repo"

mkdir -p "$TARGET_DIR"
rsync -a --delete \
  --include='README.md' \
  --include='LICENSE*' \
  --include='markdown-files/***' \
  --exclude='*' \
  "$TMP_DIR/repo/" "$TARGET_DIR/"

echo "Synced Minerva markdown IDs into $TARGET_DIR"
