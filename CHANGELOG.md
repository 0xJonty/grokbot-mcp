# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- `grokbot_wait` (read-only): blocks until a bot finishes its turn, then returns its new messages. It replaces
  "sleep, then check `grokbot_history`": the server checks the bot's live state every 2 seconds (no Claude usage) and
  returns the moment the turn ends, the bot asks a question, or the turn fails. One call returns within 45 seconds by
  default (Claude Desktop ends local MCP tool calls at 60 seconds); if the bot is still working, Claude calls again.
- `grokbot_send` takes `waitSec`: send, then wait for the reply, in one call. A failed wait never hides the receipt.
- `GROKBOT_WAIT_MAX_SEC` raises the per-call cap for clients with longer tool timeouts.

### Changed
- Send receipts now point to `grokbot_wait` instead of `grokbot_history`.

## [0.3.0] - 2026-11-23

### Fixed
- `grokbot_update_bot` now actually changes server-run (temporal) bots. Before, it wrote only the box mirror and
  checked the mirror, so it reported "Verified" while the bot kept running its old instructions, and the edit was
  lost when the mirror re-synced. It now writes the server copy first (the app's own save path), then tells the
  mirror with `serverHeldFields`, and verifies against the server. Edits take effect from the bot's next turn or
  routine run. There is no box-only fallback for server-run bots: if the server write fails, nothing is written and
  the reason is shown. If the server refuses it, the tool points to the documented chat method (ask the bot to
  replace its description with `UpdateProfile`).
- `grokbot_list_bots` and `grokbot_get_bot` show the server copy of name, instructions and avatar for server-run
  bots instead of the possibly stale mirror. The `etag` covers the server values.
- `grokbot_create_bot` no longer turns "Name" + title into a bot named "Name · Title". The server folds any title
  into the name for server-run bots, so a title is now refused for them (create and update) instead.
- Trailing whitespace in instructions is removed before saving. The mirror trimmed it, so the two copies differed and
  verification failed.
- A backend `permission_denied` (HTTP 403) is reported as a refusal with its reason, not as a sign-in problem.
- README: Claude Desktop config and log locations for current Microsoft Store versions
  (`%LOCALAPPDATA%\Claude-Data\claude_<id>\` and `%LOCALAPPDATA%\Claude\Logs`). The agent install prompt now checks
  every known config location.

### Added
- `grokbot_routines` (read-only): a bot's routines with schedule, timing window, next run, prompt and the last 5 runs.
  Rate-limit failures are flagged, because failed runs are not retried.
- `grokbot_delete_bot`: preview first; deleting needs `confirm=true` and the bot's exact name as `confirmName`.
  Server-run bots are deleted on the server, then removed from the box mirror.
- `grokbot_get_bot` shows `source`, `serverUpdatedAt` (the real last-edit time), `mirrorInSync` and, for server-run
  bots, the mirror's `profileFile` path. `grokbot_list_bots` flags bots shown from the mirror.

### Changed
- `grokbot_get_bot`: the instructions field is labelled `instructions (hidden description)`, and the box `updatedAt`
  is shown as `lastActivityAt` (it tracks activity, not edits).
- Instructions are limited to 20,000 characters and name and title to 255, the app's limits. Non-ASCII text is fine.
- The `grokbot_update_bot` description says that server-run bots are written through an internal app endpoint that
  may change.

## [0.2.0] - 2026-11-23

### Added
- One-click install for Claude Desktop: an MCP Bundle (`.mcpb`) attached to each GitHub Release. No Node, git or
  config editing needed. Settings: time zone and debug logging.
- `GROKBOT_TZ` to choose the time zone for displayed times.
- Tool titles, short server instructions, descriptions for every free-form parameter, and input size limits.
- `grokbot_get_bot` returns `structuredContent` with a declared `outputSchema`.
- `grokbot_status` shows the time zone in use.
- `npm run deploy` works from plain Windows as well as WSL.
- Setup steps for Claude Code and other MCP clients, plus update and uninstall steps.
- CI on Windows and Linux, and a tag-triggered release workflow.
- SECURITY.md and this changelog.

### Changed
- Times are shown in the system time zone (or `GROKBOT_TZ`) instead of always Australia/Sydney, and are labelled
  with the zone.
- Node.js requirement for building from source is 22.6 or newer (the docs said 22+ and package.json said 24+).
- `GROKBOT_MCP_DEBUG` is on only for `1`, `true`, `yes` or `on`; before, `0` and `false` also turned it on.

## [0.1.1] - 2026-11-23

### Fixed
- `grokbot_send` failed with "409 This Bot runs on the server" for server-run (temporal) bots. They are now messaged
  through the same backend route as the app, with a delivery receipt and no automatic resend.
- `grokbot_create_bot` reported "Create outcome unknown" when the account creates server-run bots.
- `grokbot_history` reads server-run bots from the server transcript.
- New bots appear in the bot list straight away; deleted bots no longer linger.

### Changed
- Client identity headers match the app, and the app version is read from the installed app.
- Send errors name the endpoint and harness that were used.

## [0.1.0] - 2026-11-22

- First release: status, list, get, create, update, history, send and usage tools for Grok Bots.

[Unreleased]: https://github.com/0xJonty/grokbot-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/0xJonty/grokbot-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/0xJonty/grokbot-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/0xJonty/grokbot-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0xJonty/grokbot-mcp/releases/tag/v0.1.0
