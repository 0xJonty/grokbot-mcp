# Security

grokbot-mcp reads the signed-in Grok Bot app's saved credentials on your PC, so security reports matter.

## What it touches

- Reads the Grok Bot app's files under `%APPDATA%\Grok Bot` and unwraps its encryption key with Windows DPAPI as the
  current user. The key and tokens stay in memory only.
- Sends requests only to Cursor-owned HTTPS hosts (`api2.cursor.sh`, and the bot's cloud computer on
  `*.cursorvm.com`). Any other `*.cursor.sh` / `*.cursor.com` host is also allowed; everything else is refused.
- Never writes tokens to logs, errors or tool output. Logs go to stderr and `%LOCALAPPDATA%\grokbot-mcp\log.txt`.
- Never refreshes the sign-in itself, never modifies the Grok Bot app, and sends no telemetry.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on
https://github.com/0xJonty/grokbot-mcp/security. Don't open a public issue for security problems, and don't include
real tokens, cookies or log files containing account details in a report.

Fixes go into the latest release only.
