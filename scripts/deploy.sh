#!/bin/sh
# Kept for existing muscle memory; the real logic is in deploy.mjs (works on Windows and WSL).
set -eu
cd "$(dirname "$0")/.."
exec node scripts/deploy.mjs "$@"
