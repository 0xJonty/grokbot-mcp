# grokbot-mcp

An MCP server that lets Claude (Claude Desktop, Claude Code, or any MCP client) manage your Grok Bots: list them,
read and edit their instructions, create new ones, read their chat history, send them messages and check usage.

It reuses the signed-in Grok Bot Windows app session, so you don't copy any tokens. When a bot's cloud computer is
asleep, the server wakes it and retries the call.

> Unofficial. Not affiliated with xAI, Cursor or Anthropic. It talks to private, undocumented APIs
> that can change without notice.

## Requirements

- Windows, with the Grok Bot desktop app installed and signed in.
- An MCP client: Claude Desktop, Claude Code, or another client that runs local (stdio) servers.
- Only when installing from source or using a client other than Claude Desktop: Node.js 22.6+ on Windows.

## Install in Claude Desktop (one click)

1. Download `grokbot-mcp-<version>.mcpb` from the [latest release](https://github.com/0xJonty/grokbot-mcp/releases/latest).
2. Double-click it, or drag it into Claude Desktop, or use **Settings → Extensions → Advanced settings → Install
   Extension…**.
3. Optional settings: **Time zone** (an IANA name such as `Europe/London`; blank uses this PC's zone) and **Debug
   logging**.
4. Ask Claude to run `grokbot_status`.

Claude Desktop ships its own Node.js, so nothing else needs installing. Use either the extension or a manual config
entry (below), not both, or every tool will show up twice.

## Install from source

```sh
git clone https://github.com/0xJonty/grokbot-mcp
cd grokbot-mcp
npm ci
npm run deploy     # builds and copies the server to %USERPROFILE%\grokbot-mcp\grokbot-mcp.mjs
```

`npm run deploy` works from PowerShell, cmd or WSL, and prints the Windows path it wrote. Set
`GROKBOT_MCP_DEPLOY_DIR` to use a different folder. Then register the server with your client.

### Claude Desktop

Open **Settings → Developer → Edit Config** and add this to `mcpServers`, keeping any servers already there:

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

**Edit Config** always opens the right file. Where it lives depends on how Claude Desktop was installed:

| Install | Config file |
|---|---|
| Standard installer | `%APPDATA%\Claude\claude_desktop_config.json` |
| Microsoft Store, current versions | `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude_desktop_config.json` |
| Microsoft Store, older versions | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |

If more than one exists, the most recently modified is the live one. Fully quit Claude Desktop (including the tray
icon) and reopen it after editing.

### Claude Code

On Windows (PowerShell or cmd):

```sh
claude mcp add grokbot --scope user -- node C:\Users\<you>\grokbot-mcp\grokbot-mcp.mjs
```

From WSL, run the Windows Node so the server can reach the Windows app session:

```sh
claude mcp add grokbot --scope user -- "/mnt/c/Program Files/nodejs/node.exe" 'C:\Users\<you>\grokbot-mcp\grokbot-mcp.mjs'
```

To pass settings from WSL, also list them in `WSLENV`, for example
`-e WSLENV=GROKBOT_TZ -e GROKBOT_TZ=Europe/London` before the `--`.

### Other MCP clients

Any client that launches stdio servers works with the same `command` and `args` as the Claude Desktop example.

## Configuration

All settings are optional environment variables.

| Variable | Effect |
|---|---|
| `GROKBOT_TZ` | IANA time zone for displayed times, e.g. `Europe/London`. Default: the system time zone. |
| `GROKBOT_MCP_DEBUG` | `1` adds debug detail to the log. |
| `GROKBOT_MCP_LOG` | `0` turns the log file off (stderr logging stays). |
| `GROKBOT_MCP_LOG_FILE` | Log file path. Default: `%LOCALAPPDATA%\grokbot-mcp\log.txt`. |
| `GROKBOT_APPDATA_DIR` | Grok Bot app data folder, if not `%APPDATA%\Grok Bot`. |
| `GROKBOT_APP_ASAR` | The app's `app.asar`, if the app is not installed in the default place. |
| `GROKBOT_WAIT_MAX_SEC` | Longest one `grokbot_wait` call may block. Default `50`, because Claude Desktop ends a local MCP tool call after 60 seconds. Raise it (up to `3600`) only for a client with a longer tool timeout. |

## Tools

| Tool | Purpose |
|---|---|
| `grokbot_status` | Shows whether the app is running, sign-in state, whether the box is awake or asleep, and the time zone in use. It never wakes the box. |
| `grokbot_list_bots` | Lists bots by id, name, and a preview of their instructions. Takes an optional `query`. |
| `grokbot_get_bot` | Returns the full config, including the instructions (the bot's hidden description), where they were read from (`source`), when they were last edited (`serverUpdatedAt`), whether the box mirror matches (`mirrorInSync`) and an `etag`. |
| `grokbot_create_bot` | Creates a bot. With `confirm=false` (the default) it only shows a preview. |
| `grokbot_update_bot` | Edits name, instructions, title (box-run bots only), avatar, notify, or hidden. Needs the `etag` from `grokbot_get_bot` and rejects the edit if the bot changed since then. With `confirm=false` it shows a diff. With `confirm=true` it writes, re-reads, and checks the result. |
| `grokbot_delete_bot` | Deletes a bot permanently. With `confirm=false` (the default) it only shows a preview; `confirm=true` also needs `confirmName` set to the bot's exact name. |
| `grokbot_history` | Shows chat history, newest last, in your time zone. Text is cut to 500 chars unless `full=true`. Use `before=`/`after=` with the entry numbers from a previous result to page. |
| `grokbot_routines` | Read-only. Shows a bot's routines: schedule, timing window, next run, the routine prompt and the last 5 runs (failed runs are not retried, and rate-limit failures are flagged). |
| `grokbot_send` | Sends one message and returns a delivery receipt. It is never resent automatically. With `waitSec` above 0 it then waits for the reply in the same call, like `grokbot_wait`. |
| `grokbot_wait` | Read-only. Blocks until the bot finishes its turn, then returns what it wrote. It returns as soon as the bot stops working, or asks a question, or after `timeoutSec` (default 45). If the bot is still working it says so, and Claude calls it again. The server checks the bot every 2 seconds, which costs no Claude usage. Use it instead of sleeping and re-reading `grokbot_history`. |
| `grokbot_usage` | Shows how much of the weekly Grok usage is used, when it resets, and a breakdown by source and by bot. |

`bot` takes an id or an exact name (case-insensitive). There are no tools for approvals, memory or editing
routines; do those through the bot (in chat) or in the Grok Bot app.

### Server-run bots

All current Grok Bots are server-run (harness `temporal`). Their instructions live on Cursor's server, and every
turn and routine run reads that copy when it starts; the bot's cloud computer keeps only a mirror, which can lag.
`grokbot_update_bot` writes the server copy first, the same way the app does, then tells the mirror. Edits take
effect from the bot's next turn or routine run. Notes:

- The server write uses an internal app endpoint (`UpdateGrokBotAgent`), not a public API, and may change. If the
  server refuses it, the tool says so and writes nothing; the documented way to change a bot's description is to ask
  the bot in chat to replace it (its `UpdateProfile` tool) and quote the saved text back.
- Instructions are limited to 20,000 characters and names to 255 (the app's limits). Trailing whitespace is removed.
  Non-ASCII text is stored exactly.
- Server-run bots have no separate title: the server folds a title into the name (`Name · Title`), so the tool
  refuses a title for them.

## Updating

- **Extension:** install the new `.mcpb` from the latest release; it replaces the old one.
- **From source:** `git pull`, `npm ci`, `npm run deploy`, then restart Claude Desktop (or run `/mcp` and reconnect
  in Claude Code). `grokbot_status` shows the running version.

See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Uninstalling

- **Extension:** Settings → Extensions → Grok Bot → Uninstall.
- **From source:** remove the `grokbot` entry from `claude_desktop_config.json` (or run
  `claude mcp remove grokbot --scope user`), then delete `%USERPROFILE%\grokbot-mcp`.
- Optionally delete the log folder `%LOCALAPPDATA%\grokbot-mcp`. Nothing in the Grok Bot app is changed.

## Troubleshooting

- **"Grok Bot app is signed out"**: open Grok Bot and sign in.
- **"sign-in has expired"**: open the Grok Bot app; it renews sign-in itself. This server never uses the refresh
  token (see DECISIONS.md).
- **"cloud computer unreachable after 90s"**: the box failed to wake. Retry, or open the app.
- **"Delivery … unknown"**: check `grokbot_history` before you resend.
- **"Server update refused"**: the server would not take the edit. Ask the bot in chat to replace its description
  (see [Server-run bots](#server-run-bots)).
- **`grokbot_get_bot` shows `source: box-mirror (server unreachable)`**: the server list could not be read, so you are
  seeing the mirror, which may be stale. Edits to server-run bots are refused until the server is reachable.
- **Tools don't appear**: check Claude Desktop's log for the server, `mcp-server-grokbot.log` (named after the
  config key or extension). It is in `%LOCALAPPDATA%\Claude\Logs` for current Microsoft Store versions, or
  `%APPDATA%\Claude\logs` for the installer version. A healthy start ends with `grokbot-mcp <version> ready (stdio)`.
- **Logs**: the server writes to stderr (which ends up in the log above) and to `%LOCALAPPDATA%\grokbot-mcp\log.txt`,
  which rotates at 256 KB. Some Microsoft Store versions of Claude Desktop make Windows redirect that file to
  `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Local\grokbot-mcp\log.txt`; check there if the first is
  missing or stale. Tokens are never logged.
- **Smoke test** (read-only; previews only, never creates, edits, deletes or sends). Set `GROKBOT_MCP_BIN` to test an
  installed copy instead of `dist/`:
  - Windows: `node scripts\smoke.mjs`
  - WSL: `"/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w scripts/smoke.mjs)"`

## Agent install

Paste this into a coding agent (Claude Code, Codex, Cursor, etc.) on the Windows machine to install from source:

```text
Install the grokbot-mcp MCP server from https://github.com/0xJonty/grokbot-mcp for Claude Desktop on this Windows PC.

1. Check prerequisites and stop with a clear message if any are missing:
   - Windows, with Node.js 22.6+ on Windows (`node -v`; get its absolute path with `where node`).
   - The Grok Bot desktop app is installed and signed in (the folder %APPDATA%\Grok Bot exists and contains sand-secrets.json).
   - Claude Desktop is installed, and the Grok Bot extension (.mcpb) is NOT already installed in it.
2. Clone the repo to a working folder, then run `npm ci` and `npm run deploy`. Note the path it prints
   (normally %USERPROFILE%\grokbot-mcp\grokbot-mcp.mjs).
3. Find claude_desktop_config.json. Check, in order: %APPDATA%\Claude\, %LOCALAPPDATA%\Claude-Data\claude_*\ and
   %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\. If more than one exists, use the most recently
   modified; if none exists, ask me to open Claude Desktop > Settings > Developer > Edit Config once and retry.
   Back it up, then MERGE (never overwrite other servers) this entry into "mcpServers":
   "grokbot": { "command": "<absolute path to node.exe>", "args": ["<path printed by npm run deploy>"] }
   Use real absolute paths and keep the JSON valid.
4. Run the read-only smoke test: set GROKBOT_MCP_BIN to the deployed file and run `node scripts/smoke.mjs`.
   It must list 10 tools and grokbot_status must report signedIn=true.
5. Tell me to fully quit Claude Desktop (including the tray icon) and reopen it, then ask Claude to run grokbot_status.

Rules: never print or log tokens or keys; do not call grokbot_create_bot, grokbot_update_bot, grokbot_delete_bot or
grokbot_send with confirm=true during install; do not modify the Grok Bot app or its files.
```

## Security and privacy

The server reads the Grok Bot app's saved sign-in (decrypted with Windows DPAPI as the current user, kept in memory
only) and talks only to Cursor-owned hosts. It sends no telemetry. See [SECURITY.md](SECURITY.md) for details and
how to report a vulnerability.

## Development

| Command | What it does |
|---|---|
| `npm test` | Mocked unit tests (no network). |
| `npm run typecheck` | Type-checks the code. |
| `npm run build` | Writes the single-file server `dist/grokbot-mcp.mjs`. |
| `npm run bundle` | Writes the Claude Desktop extension `dist/grokbot-mcp-<version>.mcpb`. |
| `npm run deploy` | Builds and copies the server to the deploy folder. |
| `npm run smoke` | Read-only live check against your signed-in app. |

CI runs typecheck, tests and build on Windows and Linux. To release: bump `version` in `package.json` and
`mcpb/manifest.json`, add a CHANGELOG.md section, commit, then push a `vX.Y.Z` tag. The release workflow attaches the
`.mcpb` and the single-file server to a GitHub Release.

PROTOCOL.md describes the reverse-engineered protocol. DECISIONS.md records the design choices.

## Credits and licence

The protocol research drew on [grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) (MIT).
This project is MIT licensed; see LICENSE.
