# Decisions

1. **We never refresh the access token ourselves.** The app's `/oauth/token` refresh rotates the refresh token
   (PROTOCOL.md §3). If we used it, the app's stored pair would stop working and the app would get signed out.
   Instead we re-read `sand-secrets.json` when its mtime changes and after any 401/403, and we tell the user to
   open the app once the token has expired. The observed token lifetime is about 50 days, so this should rarely
   come up.
2. **Port-token routing header.** A route from EnsureSandBox sends `x-anyrun-port-token: gatewayPortToken` when
   `networkToken` is empty, which is what the app does. gbot only handles `networkToken`, and that is probably
   why it failed after the box slept.
3. **Route preference.** We use our own EnsureSandBox route until `credentialsRefreshAfterSeconds` minus 2 min,
   then the app's cached descriptor, then a wake. Routes that fail are fingerprinted so a stale app descriptor
   is not tried again. We never write fresh routes to disk.
4. **Retry safety.** Read calls and updateAgent/setAgent* (idempotent) retry on any transient failure.
   createAgent and sendPrompt retry only when the failure means the request never arrived: 417/proxy
   `x-anyrun-failure-reason`, 404 "could not be routed", DNS failure, connection refused, or connect timeout.
   A reset, timeout, or 5xx from the box gives `delivery_unknown` and is never retried.
5. **Status never wakes the box.** It calls EnsureSandBox with `{wake:false, supportsAsleepBox:true}`. Other
   tools wake it with `{wake:true, supportsAsleepBox:true}`, the same as the app.
6. **Connect JSON instead of binary protobuf** for api2. Every RPC we use works with JSON (checked live), and it
   avoids a protobuf dependency. We don't send `x-cursor-checksum`, because it isn't required.
7. **The etag is the first 16 hex chars of sha256** over the canonical editable fields (name, instructions,
   title, avatarShape, avatarColor, notifyOnUpdates, hiddenFromSidebar). Shorter strings cost fewer tokens,
   and 64 bits is enough to detect a stale edit.
8. **create_bot refuses a duplicate name** (case-insensitive), because bots are addressed by exact name.
   It sends `origin:"user"` and a `clientNonce`, the same as gbot.
9. **updateAgent always sends `name` + `description`.** It sends `title`/`avatar*` only when they changed (gbot
   behaviour). We don't send `editedFields`/`serverSavedAtMs`: gbot works without them, and our etag check runs
   just before the write.
10. **History cursors are transcript `seq` numbers** (`before` is exclusive and matches the gateway's `beforeSeq`;
    `after` is exclusive). UI-only `feedback` entries are skipped. Widgets and connectors are shown as short tags.
11. **Usage** comes from `GetSandUsageStatus` (percent, reset time) plus `GetGrokBotUsageBreakdown` (weekly ppm
    split). Bot names in the breakdown come only from a cached list, so the usage tool never wakes the box.
    `GetHardLimit`/`GetMonthlyBillingCycle` cover Cursor's monthly billing, not the Grok weekly limit, so we don't
    call them.
12. **`dist/` stays git-ignored**, as in the scaffold's `.gitignore`. It is rebuilt by `npm run build` /
    `scripts/deploy.sh`. `reference/` (gbot plus the extracted app.asar) is also ignored.
13. **Tests use Node's built-in runner** with type stripping, so there is no test or ts-runner dependency.
    TypeScript is restricted to erasable syntax.
14. **The account email is masked** in status output (`us…@example.com`).
15. **create_bot picks the creation route the way the app does** (`resolveAgentCreation`): it reads api2
    `GetGrokBotRuntimeCapabilities`. With `temporalCreationEnabled` it calls api2 `CreateGrokBotTemporalAgent`
    (`agentId` = our clientNonce, harness TEMPORAL, no kickstart, intro suppressed); otherwise it calls box `createAgent`.
    On temporal accounts the box refuses `createAgent` with 500 `[permission_denied] A Sand box session is not permitted
    on this endpoint.` Because we choose the id, an unknown outcome is settled by looking it up in `ListGrokBotAgents`
    and is never retried. Server agents carry a row `id` and an `agentId`; the bot id used everywhere else is `agentId`.
16. **Box 5xx with a definite Connect code is final.** The box reports upstream Connect errors as HTTP 500 with a
    `[code] message` detail. For invalid_argument, not_found, already_exists, permission_denied, failed_precondition,
    out_of_range, unimplemented, unauthenticated and resource_exhausted the request was refused, so we show the reason
    and do not retry, instead of returning `delivery_unknown`. The same applies to api2 `backend()` calls.
17. **Server-run bots are messaged through api2**, the same way as the app (main-app.cjs `async function e3e(`, case
    `sendPrompt`): `SendGrokBotUserMessage` with `messageId` = clientNonce and the app's `x-cursor-timezone` and
    `x-cursor-client-capabilities` headers. An unknown outcome is settled with `GetGrokBotSendStatus`. The app resends when
    the status is NOT_FOUND, but we never resend; we report that delivery is unknown. A bot with no `temporal` harness
    goes to the box. If the box gives a definite 409 "runs on the server", we fall through to the server route once,
    which is safe because the box did not take the message. Every send failure names the endpoint and the harness.
18. **History for server-run bots is read from api2** `ListGrokBotTranscriptEntries`, as the app does for temporal
    agents. On a non-auth failure it falls back to the box mirror. Entries stored out of line (`blobHash`, no body) are
    shown as a placeholder; we don't presign blob reads.
19. **The bot list merges in the server roster.** Server-only bots are added, because a new bot can take a while to
    reach the box. A box row for a `temporal` bot that the server no longer has is dropped as a stale mirror, unless the
    server list failed or is truncated.
20. **Client identity matches the app** (user-agent `Sand/<ver>`, `x-cursor-client-os`, `x-cursor-client-source`). The
    version comes from `desktop-status.json`, then from package.json inside the installed `app.asar` (read in place),
    and only as a last resort from a constant. It follows app updates without a code change.
21. **Times use the system time zone**, or `GROKBOT_TZ` (IANA name) if set and valid. It was hardcoded to
    Australia/Sydney, which is wrong for anyone else. An invalid `GROKBOT_TZ` falls back to the system zone and
    `grokbot_status` says so; a blank value or an unsubstituted MCPB placeholder (`${user_config.timezone}`) counts as
    unset. Every time shown is labelled with the zone. Tests pin `GROKBOT_TZ=Australia/Sydney` so fixtures are stable.
22. **One-click install is an MCP Bundle** (`mcpb/manifest.json`, `npm run bundle`, attached to GitHub Releases).
    Claude Desktop ships Node, so bundle users need no Node, git or config editing. `platforms: ["win32"]` because
    credentials are unwrapped with Windows DPAPI. `user_config` exposes only time zone and debug logging. The mcpb CLI
    is pinned and run with `npx` instead of being a devDependency: its own dependency tree has open advisories that
    would otherwise show in every contributor's `npm audit`, and it never ships in the bundle.
23. **Tool metadata follows the MCP spec guidance**: every tool has a `title`, read-only tools say so, every
    free-form parameter has a short description, and the server sends short `instructions` (preview-then-confirm,
    etag, never resend). Descriptions stay terse because tool definitions are paid for on every turn.
24. **Input bounds are generous sanity limits** (name/title ≤200, instructions ≤200k, message ≤100k, blank message
    rejected). The app bundle publishes no limits, so these only stop empty or runaway input before any network call;
    `bots.ts` still does the semantic checks.
25. **Only `grokbot_get_bot` declares an `outputSchema`** and returns `structuredContent` (plus the same JSON as text
    for older clients). The other tools return compact text written for the model; schemas for them would add tokens
    without helping it.
26. **Protocol revision 2026-07-28 (stateless core, `server/discover`) is deferred.** The newest stable TypeScript SDK
    (1.32.2) negotiates up to 2025-11-25 and handles older clients. Revisit when the SDK ships the new revision.
27. **Deploy is a Node script** (`scripts/deploy.mjs`) so it works from plain Windows as well as WSL. From WSL it
    asks Windows for `%USERPROFILE%` instead of assuming the WSL user name matches. `deploy.sh` just calls it.
