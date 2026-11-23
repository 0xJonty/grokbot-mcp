import type { Bots } from "./bots.ts";
import { truncate } from "./history.ts";
import { localTime, timeZone } from "./time.ts";
import type { Transport } from "./transport.ts";

export const ROUTINES_NOTE = "Routines are edited by the bot's UpdateRoutine tool or in the app (bot details -> Routines). This tool is read-only.";
const RATE_LIMIT = /automation run rate limit exceeded/i;
const RUNS_SHOWN = 5;

function parseJson(s: unknown): any {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** ms epoch number, numeric string or ISO string -> local time; anything else as short text. */
function when(v: unknown): string {
  if (v == null || v === "") return "?";
  if ((typeof v === "number" && v > 1e11) || (typeof v === "string" && (/^\d{11,}$/.test(v) || /^\d{4}-\d{2}-\d{2}T/.test(v)))) return localTime(v as any);
  return typeof v === "string" ? v : truncate(JSON.stringify(v), 80);
}

function runStatus(r: any): string {
  // Same labels as the app's routine drill-down: error -> failed, ok -> reported outcome kind.
  if (r?.status === "error") return "failed";
  if (r?.status === "ok") return String(r?.reportedOutcome?.kind || "ran");
  return String(r?.status ?? "?");
}

function runReason(r: any): string {
  const parts = [r?.reportedOutcome?.reason, typeof r?.error === "string" ? r.error : r?.error?.message, r?.errorMessage, r?.failureReason]
    .filter((x) => typeof x === "string" && x.trim())
    .map((x: string) => x.trim());
  return [...new Set(parts)].join(" / ");
}

function startedMs(r: any): number {
  const v = r?.startedAt;
  const n = typeof v === "number" ? v : typeof v === "string" ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** One api2 GrokBotAgentRoutine (its `recordJson` is the box automation.json record) as display lines. */
export function formatRoutine(r: any, i: number, full: boolean): string[] {
  const rec = parseJson(r?.recordJson) ?? {};
  const trig = rec.trigger && typeof rec.trigger === "object" ? rec.trigger : {};
  const enabled = (r?.isEnabled ?? rec.isEnabled) === true;
  const lines = [`${i + 1}. ${r?.name || rec.name || "(unnamed)"} [${enabled ? "enabled" : "paused"}]`];
  const schedule = r?.schedule || trig.schedule || rec.schedule || trig.type || "?";
  const desc = r?.triggerDescription || rec.triggerDescription;
  lines.push(`   schedule: ${schedule}${desc && desc !== schedule ? ` (${desc})` : ""}`);
  const timing = [
    trig.firesAt != null ? `fires at ${when(trig.firesAt)}` : null,
    trig.window && typeof trig.window === "object" ? `window -${trig.window.earlyMinutes ?? 0}/+${trig.window.lateMinutes ?? 0} min` : null,
    trig.timing ? `timing ${trig.timing}` : null,
  ].filter(Boolean);
  if (timing.length) lines.push(`   ${timing.join(", ")}`);
  const next = r?.nextRunAtMs ?? rec.nextRunAt;
  lines.push(`   next run: ${next != null && next !== "" ? when(next) : "none scheduled"}`);
  if (typeof rec.prompt === "string" && rec.prompt) {
    lines.push(full ? `   prompt:\n${rec.prompt}` : `   prompt: ${truncate(rec.prompt.replace(/\s+/g, " ").trim(), 300)}`);
  }
  const runs: any[] = Array.isArray(rec.runs) ? [...rec.runs].sort((a, b) => startedMs(b) - startedMs(a)) : [];
  if (!runs.length) lines.push("   runs: none recorded");
  else {
    lines.push(`   last runs (${Math.min(RUNS_SHOWN, runs.length)} of ${runs.length}, newest first):`);
    for (const run of runs.slice(0, RUNS_SHOWN)) {
      const reason = runReason(run);
      const limited = RATE_LIMIT.test(JSON.stringify(run ?? {}));
      const end = run?.finishedAt != null ? ` -> ${when(run.finishedAt)}` : "";
      const why = limited ? " RATE LIMITED (Automation run rate limit exceeded; failed runs are not retried)" : reason ? `: ${truncate(reason, 200)}` : "";
      lines.push(`   - ${when(run?.startedAt)}${end} ${runStatus(run)}${why}`);
    }
  }
  return lines;
}

/** grokbot_routines: api2 ListGrokBotAgentRoutines {agentId, timeZone}. Read-only. */
export async function routines(t: Transport, bots: Bots, ref: string, opts: { full?: boolean } = {}): Promise<string> {
  const bot = await bots.resolve(ref);
  const zone = timeZone();
  const data = await t.backend("GrokBotService", "ListGrokBotAgentRoutines", { agentId: bot.id, timeZone: zone });
  const list: any[] = Array.isArray(data?.routines) ? data.routines : [];
  const out = [`Routines for "${bot.name}" (${list.length}); times in ${zone}:`];
  if (!list.length) out.push("(none)");
  list.forEach((r, i) => out.push(...formatRoutine(r, i, opts.full === true)));
  out.push(ROUTINES_NOTE);
  return out.join("\n");
}
