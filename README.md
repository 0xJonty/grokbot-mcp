# grokbot-mcp

An MCP server (stdio) that lets Claude Desktop manage Grok Bots. It reuses the signed-in
Grok Bot Windows app session, so you don't copy any tokens. When the bot's cloud computer is
asleep, the server wakes it and retries the call.

> Unofficial. Not affiliated with xAI, Cursor or Anthropic. It talks to private, undocumented APIs
> that can change without notice.

## Requirements

- Windows with the Grok Bot desktop app installed and signed in
- Node.js 22+ on Windows (Claude Desktop runs the server with it)
- Building and the smoke test also work from WSL

## Install

```sh
npm install && npm run build && sh scripts/deploy.sh   # -> %USERPROFILE%\grokbot-mcp\grokbot-mcp.mjs
```

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "grokbot": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\<you>\\grokbot-mcp\\grokbot-mcp.mjs"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `grokbot_status` | Shows whether the app is running, sign-in state, and whether the box is awake or asleep. It never wakes the box. |
| `grokbot_list_bots` | Lists bots by id, name, and a preview of their instructions. Takes an optional `query`. |
| `grokbot_get_bot` | Returns the full config, including instructions and an `etag`. |
| `grokbot_create_bot` | Creates a bot. With `confirm=false` (the default) it only shows a preview. |
| `grokbot_update_bot` | Edits name, instructions, title, avatar, notify, or hidden. Needs the `etag` from `grokbot_get_bot` and rejects the edit if the bot changed since then. With `confirm=false` it shows a diff. With `confirm=true` it writes, re-reads, and checks the result. |
| `grokbot_history` | Shows chat history, newest last, with Sydney times. Text is cut to 500 chars unless `full=true`. Use `before=`/`after=` with the entry numbers from a previous result to page. |
| `grokbot_send` | Sends one message and returns a delivery receipt. It is never resent automatically. |
| `grokbot_usage` | Shows how much of the weekly Grok usage is used, when it resets, and a breakdown by source and by bot. |

`bot` takes an id or an exact name (case-insensitive). There is no delete tool.

## Troubleshooting

- **"Grok Bot app is signed out"**: open Grok Bot and sign in.
- **"sign-in has expired"**: open the Grok Bot app; it renews sign-in itself. This server never uses the refresh token (see DECISIONS.md).
- **"cloud computer unreachable after 90s"**: the box failed to wake. Retry, or open the app.
- **"Delivery … unknown"**: check `grokbot_history` before you resend.
- Logs are written to stderr and to `%LOCALAPPDATA%\grokbot-mcp\log.txt`, which rotates at 256 KB. Set `GROKBOT_MCP_LOG=0` to turn the file off, or `GROKBOT_MCP_DEBUG=1` for more detail. Tokens are never logged.
- Smoke test (read-only), run from WSL: `"/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w scripts/smoke.mjs)"`.

## Development

`npm test` runs the mocked unit tests. `npm run typecheck` type-checks the code. `npm run build` writes `dist/grokbot-mcp.mjs`.
PROTOCOL.md describes the reverse-engineered protocol. DECISIONS.md records the design choices.

## Credits and licence

The protocol research drew on [grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) (MIT).
This project is MIT licensed; see LICENSE.
