import { errorText } from "./errors.ts";
import { relative, sydney } from "./time.ts";
import type { Transport } from "./transport.ts";

function maskEmail(e?: string): string | undefined {
  if (!e) return undefined;
  const [user, domain] = e.split("@");
  return user && domain ? `${user.slice(0, 2)}…@${domain}` : undefined;
}

function pidAlive(pid?: number): boolean | undefined {
  if (!pid || !Number.isInteger(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Cheap health check. Never throws; never wakes the box. */
export async function status(t: Transport, version: string): Promise<string> {
  const out: string[] = [`grokbot-mcp ${version}`];
  const ds = t.session.desktopStatus();
  if (!ds) out.push("App: Grok Bot app data not found (install the app and sign in).");
  else {
    const alive = pidAlive(ds.pid);
    out.push(`App: v${ds.appVersion ?? "?"}, ${alive === false ? "not running" : alive ? "running" : "state unknown"}, signedIn=${ds.signedIn ?? "?"}`);
  }
  let authed = false;
  try {
    const c = await t.session.credentials();
    authed = true;
    const exp = c.expMs ? `token expires ${relative(c.expMs)}` : "token expiry unknown";
    out.push(`Auth: OK — ${[c.name, maskEmail(c.email)].filter(Boolean).join(" ") || "account"}${c.teamId ? ` (team ${c.teamId})` : ""}, ${exp}`);
  } catch (err) {
    out.push(`Auth: FAIL — ${errorText(err)}`);
  }
  if (authed) {
    try {
      const b = await t.boxState();
      const label = b.runState === "RUNNING" ? "awake" : b.runState === "HIBERNATED" ? "asleep (wakes automatically on next bot call, ~10s)" : b.runState.toLowerCase();
      out.push(`Box: ${label}`);
    } catch (err) {
      out.push(`Box: unknown — ${errorText(err)}`);
    }
  }
  out.push(`Route: ${t.hasRoute() ? "fresh route cached" : "none cached"}${t.lastWakeAt ? `, last wake ${sydney(t.lastWakeAt)}` : ""}`);
  return out.join("\n");
}
