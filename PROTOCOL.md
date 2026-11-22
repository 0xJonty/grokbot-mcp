# Grok Bot protocol notes (Windows desktop app 1.2.3, grok-bot-cli 0.12.5)

Sources:
- `reference/grok-bot-cli-0.12.5/dist/bin/gbot.mjs` (rspack output, readable). Modules are delimited by
  `"./src/core/<name>.js" (` — search those strings.
- `reference/app/` = `npx @electron/asar extract` of
  `%LOCALAPPDATA%\Programs\Grok Bot\resources\app.asar` (app `package.json` name `sand`, version 1.2.3).
  Minified; cite by search string.
- Live read-only probes (2026-11-22) confirmed every request/response shape marked **[live]**.

## 1. Locating the session (Windows)

Directory: `%APPDATA%\Grok Bot` (gbot: `grokBotAppDataPath`, module `./src/core/app-session.js`).

| File | Contents | Secret? |
|---|---|---|
| `desktop-status.json` | `{version:1,pid,appVersion:"1.2.3",startedAtMs,signedIn:true}` | no |
| `Local State` | `os_crypt.encrypted_key` = base64(`"DPAPI"` + DPAPI blob) of the 32-byte AES key | yes |
| `sand-secrets.json` | `{version:1, "cursor-machine-id", "cursor-accounts": "<JSON string>", "local-exec-file-key"}` | yes |
| `gateway-descriptor.json` | `{version:3, entries:{<accountKey>:{savedAtMs, encrypted}}}` | yes |

`cursor-accounts` (JSON string) = `{active:<accountKey>, accounts:{<accountKey>:{"cursor-access-token",
"cursor-refresh-token","cursor-account-profile", "cursor-selected-team-id"?}}}`; each value is an encrypted
string (see §2). No `active`, or `active` missing from `accounts` => signed out (gbot `activeAppAccount`).
Decrypted profile **[live]**: `{email,name,avatar}`.

Gateway descriptor: gbot `encryptedPayload` accepts v1 (`encrypted`) / v2,v3 (`entries`, refuses >1 entry).
We select `entries[<active accountKey>]` (keys match **[live]**). Decrypted **[live]**:
`{baseUrl:"https://<pod>.us14.cursorvm.com…", token, headers:{"x-anyrun-port-token"}, egressTunnelHeaders, vncProxy}`.
The app writes this descriptor itself (search `function BWt(` in `reference/app/dist/electron-main/main-app.cjs`).
It goes stale when the box sleeps (see §4).

Access token: JWT; claims `sub,time,randomness,exp,iss,scope,aud,type`. Observed lifetime ≈ 50 days **[live]**.

## 2. Decryption (Chromium os_crypt, Windows)

gbot `readWindowsSafeStorageKey` / `unprotectWithDpapi` / `decryptWindowsSafeStorageString`:
1. `blob = base64decode(Local State.os_crypt.encrypted_key)`; require `blob[0..5] == "DPAPI"`.
2. key = `ProtectedData.Unprotect(blob[5..], null, CurrentUser)` via
   `powershell.exe -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))"`
   (blob base64 on stdin, key base64 on stdout). Path: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.
3. Value: `e = base64decode(v)`; `e[0..3] == "v10"`; nonce `e[3..15]`; tag `e[-16..]`; ciphertext `e[15..-16]`;
   AES-256-GCM → UTF-8.

## 3. Backend (api2.cursor.sh): Connect protocol, JSON encoding

Base `https://api2.cursor.sh` (app: `KN="https://api2.cursor.sh"` in `main-core.cjs`). The app itself uses
binary protobuf (`useBinaryFormat:!0` in `main-app.cjs`), but Connect JSON works for every RPC below **[live]**.
`POST {base}/aiserver.v1.<Service>/<Method>`, body = JSON message (`{}` ok), field names lowerCamelCase,
int64 as strings, enums as full names, Timestamps as RFC3339.

Headers (gbot `ensureSandboxHeaders`, module `./src/core/headers.js`; app `function Kpe(` in `main-core.cjs`):
```
content-type: application/json
connect-protocol-version: 1
authorization: Bearer <cursor-access-token>
x-cursor-client-type: sand
x-cursor-client-version: <desktop-status.json appVersion>
x-sand-box-namespace: prod
x-cursor-team-id: <decrypted cursor-selected-team-id>   (only if present)
x-ghost-mode: true                                      (app sets it; harmless)
```
The app also sends `x-cursor-checksum` (`function xS(` in `main-app.cjs`: base64url(time-obfuscated bytes)+machineId),
`user-agent`, `x-cursor-client-os`. Not required **[live]**; we omit them.

Services/methods (compact descriptors in `reference/app/dist/electron-main/proto.cjs`; search
`typeName:"aiserver.v1.GrokBotService"` / `typeName:"aiserver.v1.DashboardService"` and `return["<Message>|`).
Field type codes: 1 double, 3 int64, 5 int32, 8 bool, 9 string, 13 uint32, `#n` message/enum ref, `?` optional, `*` repeated.

### GrokBotService/EnsureSandBox
- Request `EnsureSandBoxRequest|2 wake 8?|3 supports_asleep_box 8?`.
  - `{wake:false, supportsAsleepBox:true}`: read state without waking (app `describe()`: search `ensureBox({wake:!1})`).
  - `{wake:true, supportsAsleepBox:true}`: wake; blocked ~9 s then returned RUNNING **[live]**. gbot sends `{}`.
- Response `EnsureSandBoxResponse`: `cluster, tenantId, podId, networkToken, gatewayUrl, gatewayToken,
  gatewayPortToken, egressTunnelPortToken, forkVncPortToken, vncUrl, forkVncBaseUrl, runState, image,
  credentialsRefreshAfterSeconds (uint32), imageUpdateAvailable, egressTunnelOwnership`.
- `runState` enum `SandBoxRunState`: `SAND_BOX_RUN_STATE_{UNSPECIFIED,ABSENT,HIBERNATED,RUNNING,STARTING}`
  (search `"SandBoxRunState",[[0,"UNSPECIFIED"]`). When asleep (wake:false) the response has no gateway fields **[live]**.
- Route headers (app `function uJ(` / `BWt(` / `KBe(` in `main-app.cjs`):
  if `networkToken` is empty and `gatewayPortToken` non-empty → `x-anyrun-port-token: <gatewayPortToken>`;
  else `x-anyrun-network-token: <networkToken>`. **gbot only implements the network-token branch**
  (`headersFromEnsureSandbox`) — the current backend returns empty `networkToken` **[live]**, so gbot's
  refreshed routes lack the port token. Likely root cause of its post-sleep auth failures.
- `credentialsRefreshAfterSeconds` (~9 h observed) bounds route lifetime; refresh before it.

### Usage RPCs (all `aiserver.v1.DashboardService`, request `{}`)
| Method | Useful response fields **[live]** |
|---|---|
| `GetSandUsageStatus` | `currentPeriodStart`, `nextResetTimestampUtc` (Timestamp), `usagePercent` (double), `hasAvailableUsage`, `wouldRefuseSend`, `grokPlanLabel`, `cursorPlanName`, `billingBrand`, `additionalUsageLimit{state,limitCents,spentCents,resetsAt}`, `prepaidAvailableCents`, `availableBankedResetCount`, `nextBankedResetRedeemAt` |
| `GetGrokBotUsageBreakdown` (`1 enterprise_team_id 5?`) | oneof `billedCents` / `weeklyLimitPpm` / `billingCyclePpm` = `GrokBotUsagePpmSplits{periodStartMs,periodEndMs,bySource[{dayMs,source,ppm}],byBot[{dayMs,botId,ppm}]}`. ppm = parts-per-million of the limit; Σ bySource ppm / 1e4 == `usagePercent` **[live]**. Sources `GROK_BOT_USAGE_SOURCE_{USER,AGENT,AUTOMATION}` |
| `GetCurrentPeriodUsage` | `billingCycleStart/End` (ms strings), `planUsage{totalPercentUsed,autoPercentUsed,…}`, `displayMessage` |
| `GetHardLimit` | `hardLimit` (int32; 2147483647 = none) |
| `GetMonthlyBillingCycle` | `startDateEpochMillis`, `endDateEpochMillis` (Cursor monthly cycle, not the Grok weekly window) |
| `GetAggregatedUsageEvents` | Cursor per-model token events; not needed |
The app's own usage card calls `getSandUsageStatus` + `getCurrentPeriodUsage` (search `async function MLt(` in `main-app.cjs`).
Grok usage window is weekly (period start→end = 7 days **[live]**).

### Token refresh (not implemented — see DECISIONS.md)
`POST {backend}/oauth/token` JSON `{client_id, grant_type:"refresh_token", refresh_token}` (search
`runRefreshAccessToken` in `main-app.cjs`; client ids `Npe=`/`odt=` in `main-core.cjs`). Refresh tokens
**rotate** (`rotatedPairFrom`, `preserveRotatedPair`), so using the app's refresh token would invalidate the
app's stored pair and sign the app out.

## 4. Box gateway (in-box HTTP JSON RPC)

`POST {gatewayUrl}/api/<method>`, body JSON (gbot `gatewayCall`, module `./src/core/gateway.js`). Headers:
```
content-type: application/json
authorization: Bearer <gatewayToken>
x-anyrun-port-token: <gatewayPortToken>      (or x-anyrun-network-token, see §3)
```
Method table + arg schemas: `reference/app/dist/node-agent-coordinator/main.cjs`, search `listAgents:C().noArgs`
and `jo("gateway",{methods:`. Use `redirect:"error"` and only send credentials to `https://*.cursorvm.com`
(gateway) / `*.cursor.sh` (backend) (gbot `./src/core/url-policy.js`).

Failure modes:
- **Sleeping box** → `417`, headers `x-anyrun-error-source: anyrun-proxy`, `x-anyrun-failure-reason: pod_hibernated`,
  empty body **[live]** (gbot `gatewayCall` handles only this, only for read methods). App failure vocabulary
  (search `P8t=["refused","dns","timeout"`): `refused, dns, timeout, network, no_storage, access_denied,
  box_blocked, http_5xx, pod_hibernated`. Proxy also returns 404 "could not be routed" for dead routes (SPEC).
- **Unknown method** → `404 {"error":"unknown gateway method: X","failureCode":"gateway/unknown-method"}` **[live]** — not a route failure.
- First call right after wake can 500 transiently **[live]**; retry.
- Unknown agent id on reads → `200 {"entries":[]}` **[live]**.

### Methods used
| Method | Body | Response **[live]** unless noted |
|---|---|---|
| `listAgents` | `{}` | **array** of agents: `id, name, description` (= UI "Instructions"), `title, avatarShape, avatarColor, notifyOnUpdatesEnabled, isHiddenFromSidebar, isGroup, memberIds, harness, origin, createdAt, updatedAt, lastActivityAt, lastMessagePreview, isRunningTurn, hasUnread, unreadCount, awaitingUserResponse, …` |
| `createAgent` | `{name, description, title?, avatarShape?, avatarColor?, origin:"user", clientNonce?}` (schema `Bl=I({...H7,`; `H7={name:f(),description:f(),title:_(f()),avatarShape:_(f()),avatarColor:_(f())}`) | `{agent}` or agent (gbot `unwrapOne`) — not live-tested |
| `updateAgent` | `{id, profile:{name, description, title?, avatarShape?, avatarColor?}, editedFields?, serverHeldFields?, serverSavedAtMs?}` (search `updateAgent:C().args(`) | not live-tested; gbot re-lists to verify |
| `setAgentNotifyOnUpdates` | `{id, isEnabled}` | gbot `updateAgent` |
| `setAgentHiddenFromSidebar` | `{id, isHidden}` | gbot `updateAgent` |
| `getAgentTranscriptTail` | `{id, limit, beforeSeq?}` (schema `pye=I({id:W(),beforeSeq:_(se()),limit:se(),…`) | `{entries[], nextBeforeSeq?, precedingTimestampMs?}`; ascending by `seq`; `beforeSeq` exclusive; `nextBeforeSeq` = oldest returned seq, absent when no older entries |
| `getAgentThread` | `{id, rootId}` | `{entries[]}` |
| `sendPrompt` | `{agentId, prompt, clientNonce, replyToId?}` (schema `y0={prompt:f(),agentId:W(),…`) | gbot: `{messageId}` or `{accepted:true}` → resolve id by finding `clientNonce` in tail — not live-tested |
Avatar enums (gbot `AVATAR_SHAPES`/`AVATAR_COLORS` in `./src/core/store.js`): shapes `blob pebble bean egg squircle
tablet capsule cylinder hex gem crystal wedge shield dome arch cloud teardrop leaf`; colors `black brown red orange
yellow green cyan blue violet magenta gray`.

### Transcript entries **[live]**
Common: `kind, id, timestampMs, seq, requestId?`.
- `kind:"message"`, `role:"user"`, `content` (string), `richText`, `clientNonce` — user prompts.
- `kind:"send-message"`, `message:{type:"text",content}` — bot replies; `message.type` also `widget{prompt,options}`, `connector{connector}`.
- `kind:"event"`, `event:{type,action,…}`; `kind:"notice"`, `text`; `kind:"feedback"` (UI-only).
