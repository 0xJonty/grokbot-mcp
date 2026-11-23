import { localTime, relative, timeZone } from "./time.ts";
import type { Bots } from "./bots.ts";
import type { Transport } from "./transport.ts";

const pct = (ppm: number) => `${(ppm / 10_000).toFixed(1)}%`;

/** Usage summary from DashboardService (no box wake needed). */
export async function usage(t: Transport, bots: Bots): Promise<string> {
  const [status, breakdown] = await Promise.all([
    t.backend("DashboardService", "GetSandUsageStatus", {}),
    t.backend("DashboardService", "GetGrokBotUsageBreakdown", {}).catch(() => null),
  ]);
  const now = Date.now();
  const out: string[] = [];
  const plan = [status.grokPlanLabel, status.cursorPlanName ? `Cursor ${status.cursorPlanName}` : null].filter(Boolean).join(" / ");
  const used = typeof status.usagePercent === "number" ? `${status.usagePercent.toFixed(1)}%` : "unknown";
  out.push(`Plan: ${plan || "unknown"}`);
  out.push(
    `Used: ${used} of included usage this period` +
      (status.hasAvailableUsage === false ? " — LIMIT REACHED" : "") +
      (status.wouldRefuseSend ? " (sends would be refused)" : ""),
  );
  const resetMs = Date.parse(status.nextResetTimestampUtc ?? "");
  const startMs = Date.parse(status.currentPeriodStart ?? "");
  if (Number.isFinite(resetMs)) out.push(`Period: ${localTime(startMs)} → resets ${localTime(resetMs)} ${timeZone()} (${relative(resetMs, now)})`);
  const extra = status.additionalUsageLimit;
  if (extra && !/NONE$/.test(String(extra.state ?? "")) && (Number(extra.limitCents) > 0 || Number(extra.spentCents) > 0)) {
    const c = (v: unknown) => (v == null ? "?" : `$${(Number(v) / 100).toFixed(2)}`);
    const state = extra.state ? ` (${String(extra.state).replace(/^.*_STATE_/, "").toLowerCase()})` : "";
    out.push(`Additional usage: ${c(extra.spentCents)} of ${c(extra.limitCents)}${state}`);
  }
  if (Number(status.prepaidAvailableCents) > 0) out.push(`Prepaid credit: $${(Number(status.prepaidAvailableCents) / 100).toFixed(2)}`);
  if (Number(status.availableBankedResetCount) > 0) out.push(`Banked resets available: ${status.availableBankedResetCount}`);

  const w = breakdown?.weeklyLimitPpm ?? breakdown?.billingCyclePpm;
  if (w) {
    const bySource = new Map<string, number>();
    for (const s of w.bySource ?? []) {
      const k = String(s.source ?? "").replace("GROK_BOT_USAGE_SOURCE_", "").toLowerCase() || "other";
      bySource.set(k, (bySource.get(k) ?? 0) + Number(s.ppm ?? 0));
    }
    if (bySource.size) out.push("By source: " + [...bySource].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(", "));
    const byBot = new Map<string, number>();
    for (const b of w.byBot ?? []) {
      const id = String(b.botId ?? "?");
      byBot.set(id, (byBot.get(id) ?? 0) + Number(b.ppm ?? 0));
    }
    if (byBot.size) {
      const names = new Map((bots.cache?.bots ?? []).map((b) => [b.id, b.name]));
      const top = [...byBot].sort((a, b) => b[1] - a[1]).slice(0, 10);
      out.push("By bot: " + top.map(([id, v]) => `${names.get(id) ?? id.slice(0, 8)} ${pct(v)}`).join(", "));
    }
  }
  return out.join("\n");
}
