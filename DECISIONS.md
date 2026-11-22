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
