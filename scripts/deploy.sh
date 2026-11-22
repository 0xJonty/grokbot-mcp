#!/bin/sh
# Build and copy the bundle to the Windows deploy target used by Claude Desktop.
set -eu
cd "$(dirname "$0")/.."
node scripts/build.mjs
TARGET="${GROKBOT_MCP_DEPLOY_DIR:-/mnt/c/Users/$USER/grokbot-mcp}"
mkdir -p "$TARGET"
# Write to a temp name then rename, so a running server never sees a half-written file.
cp dist/grokbot-mcp.mjs "$TARGET/grokbot-mcp.mjs.tmp"
mv -f "$TARGET/grokbot-mcp.mjs.tmp" "$TARGET/grokbot-mcp.mjs"
echo "deployed to $TARGET/grokbot-mcp.mjs"
