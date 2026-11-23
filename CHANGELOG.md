# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

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

[0.2.0]: https://github.com/0xJonty/grokbot-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/0xJonty/grokbot-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0xJonty/grokbot-mcp/releases/tag/v0.1.0
