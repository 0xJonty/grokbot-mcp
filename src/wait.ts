// grokbot_wait: block until a bot's turn ends, so the model does not sleep and poll.
// The poll runs here, every POLL_MS, and costs no model tokens. One call returns within the budget
// (Claude Desktop ends local MCP tool calls after 60 s); if the bot is still working the model calls again.
import { GrokError } from "./errors.ts";
import { resolveBot, type Bot, type Bots } from "./bots.ts";
import { historyOf, lastSentTo, runsOnServer, tail, truncate } from "./history.ts";
import { log } from "./log.ts";
import type { Transport } from "./transport.ts";

export const POLL_MS = 2000;
export const WAIT_DEFAULT_SEC = 45;
/** Tolerance between our clock and the server's when matching a turn settlement to our send. */
const SKEW_MS = 5000;

/** Longest one call may block. GROKBOT_WAIT_MAX_SEC raises it for clients with longer tool timeouts. */
export function waitMaxSec(): number {
  const n = Number(process.env.GROKBOT_WAIT_MAX_SEC);
  return Number.isFinite(n) && n >= 5 ? Math.min(3600, Math.trunc(n)) : 50;
}

export function waitBudgetMs(timeoutSec?: number): number {
  const s = timeoutSec === undefined || !Number.isFinite(timeoutSec) ? WAIT_DEFAULT_SEC : timeoutSec;
  return Math.min(waitMaxSec(), Math.max(1, Math.trunc(s))) * 1000;
}

export interface Live {
  running: boolean;
  awaiting: boolean;
  activity?: string;
  settlement?: { outcome: string; settledAtMs: number; clientNonce?: string };
  lastActivityAtMs?: number;
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function settlementOf(v: any): Live["settlement"] {
  const at = num(v?.settledAtMs);
  if (!v || typeof v !== "object" || at === undefined) return undefined;
  return { outcome: String(v.outcome ?? ""), settledAtMs: at, clientNonce: typeof v.clientNonce === "string" && v.clientNonce ? v.clientNonce : undefined };
}

function activityText(a: any): string | undefined {
  if (!a || typeof a !== "object") return undefined;
  const parts = [a.kind, a.tool, a.detail || a.target].filter((x) => typeof x === "string" && x.trim());
  return parts.length ? truncate(parts.join(" ").replace(/\s+/g, " ").trim(), 80) : undefined;
}

/**
 * api2 GrokBotAgentStatus -> Live. `live` is only present while the bot has live state [live, 2026-11-24].
 * "Working" follows the app (renderer `zu`): running or composing, unless it is waiting for the user.
 */
export function liveFromStatus(s: any, nowMs: number): Live {
  const live = s?.live && typeof s.live === "object" ? s.live : undefined;
  const updated = num(live?.updatedAtMs);
  const staleAfter = num(live?.staleAfterMs);
  const fresh = !!live && !(updated !== undefined && staleAfter !== undefined && staleAfter > 0 && nowMs > updated + staleAfter);
  const awaiting = fresh && live.awaiting != null;
  const busy = fresh && (live.isRunning === true || live.isComposingMessage === true || live.hasRunningSubagents === true);
  return {
    running: !awaiting && (busy || s?.isRunning === true),
    awaiting,
    activity: busy ? activityText(live.activity) : undefined,
    settlement: settlementOf(live?.lastTurnSettlement),
    lastActivityAtMs: num(s?.client?.lastActivityAtMs),
  };
}

/** Box listAgents row -> Live (node-agent-coordinator merges the live sessions into these fields). */
export function liveFromBoxRow(a: any): Live {
  const awaiting = a?.awaitingUserResponse != null;
  return {
    running: !awaiting && (a?.isRunningTurn === true || a?.isRunning === true),
    awaiting,
    activity: activityText(a?.currentActivity),
    settlement: settlementOf(a?.lastTurnSettlement),
    lastActivityAtMs: num(a?.lastActivityAt),
  };
}

/** `useBox` is set after the first api2 failure so later polls in the same call skip its retries. */
async function readLive(t: Transport, bot: Bot, state: { useBox: boolean }): Promise<Live> {
  if (runsOnServer(bot) && !state.useBox) {
    try {
      const r = await t.backend("GrokBotService", "ListGrokBotAgentStatuses", { agentIds: [bot.id] }, { timeoutMs: 10_000 });
      const s = (Array.isArray(r?.statuses) ? r.statuses : []).find((x: any) => x?.agentId === bot.id);
      return liveFromStatus(s, t.clock());
    } catch (err) {
      if (err instanceof GrokError && (err.code === "auth" || err.code === "signed_out")) throw err;
      state.useBox = true;
      log("warn", `status read failed for ${bot.id}, using box roster: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const rows = await t.gateway("listAgents", {}, { idempotent: true });
  return liveFromBoxRow((Array.isArray(rows) ? rows : []).find((x: any) => x?.id === bot.id));
}

const isUserEntry = (e: any) => e?.kind === "message" && e?.role === "user";

/** A bot-side entry newer than `after` (reply, question, notice, event). */
async function replyAfter(t: Transport, bot: Bot, after: number): Promise<boolean> {
  const r = await tail(t, bot, 20);
  return r.entries.some((e) => typeof e?.seq === "number" && e.seq > after && !isUserEntry(e) && e.kind !== "feedback");
}

async function newestSeq(t: Transport, bot: Bot): Promise<number> {
  const r = await tail(t, bot, 1);
  const s = r.entries[r.entries.length - 1]?.seq;
  return typeof s === "number" ? s : 0;
}

export interface WaitOpts {
  after?: number;
  timeoutSec?: number;
  limit?: number;
  full?: boolean;
  signal?: AbortSignal;
}

/**
 * Block until the bot is not working, then return what it wrote after `after`.
 * After our own send, "not working" only counts once the turn was seen running, settled, or replied
 * (the turn can take a few seconds to start). Otherwise an idle bot returns at once.
 */
export async function waitFor(t: Transport, bots: Bots, ref: string, opts: WaitOpts = {}): Promise<string> {
  const t0 = t.clock();
  const deadline = t0 + waitBudgetMs(opts.timeoutSec);
  const list = await bots.list();
  const bot = resolveBot(list, ref);
  const rec = lastSentTo(bot.id);
  const after = opts.after ?? rec?.seq ?? (await newestSeq(t, bot));
  const secs = () => Math.round((t.clock() - t0) / 1000);
  const entries = async (head: string) => `${head}\n${await historyOf(t, bot, list, { after, limit: opts.limit ?? 20, full: opts.full })}`;
  const again = `Call grokbot_wait again with after=${after}.`;

  const state = { useBox: false };
  let first = true;
  let lastAct: number | undefined;
  let activity: string | undefined;
  for (;;) {
    if (opts.signal?.aborted) throw new GrokError("timeout", "Wait cancelled by the client.");
    const live = await readLive(t, bot, state);
    if (live.running) {
      if (rec) rec.started = true;
      activity = live.activity ?? activity;
    } else if (live.awaiting) {
      if (rec) rec.done = true;
      return entries(`"${bot.name}" is waiting for you (question or approval) — waited ${secs()}s. Answer with grokbot_send or in the Grok Bot app.`);
    } else {
      const s = live.settlement;
      const settled = !!rec && !!s && (s.clientNonce ? s.clientNonce === rec.nonce : s.settledAtMs >= rec.atMs - SKEW_MS);
      let finished = !rec || rec.done || rec.started || settled;
      // Sent but never seen running: a fast turn may have ended between polls, or it has not started yet.
      if (!finished && rec && (first || (live.lastActivityAtMs !== undefined && live.lastActivityAtMs !== lastAct))) {
        finished = await replyAfter(t, bot, rec.seq ?? after);
      }
      if (finished) {
        const pending = !!rec && !rec.done;
        if (rec) rec.done = true;
        const outcome = settled && s ? s.outcome : "";
        if (!pending && opts.after === undefined && !rec) return `"${bot.name}" is idle (no turn running). Earlier messages: grokbot_history.`;
        if (!pending) return entries(`"${bot.name}" is idle (no turn running).`);
        if (outcome === "error") return entries(`"${bot.name}" finished with an error after ${secs()}s.`);
        if (outcome === "cancelled") return entries(`"${bot.name}"'s turn was cancelled after ${secs()}s.`);
        return entries(`"${bot.name}" finished after ${secs()}s.`);
      }
    }
    lastAct = live.lastActivityAtMs;
    first = false;
    if (t.clock() + POLL_MS > deadline) {
      if (live.running) return `"${bot.name}" is still working${activity ? ` (${activity})` : ""} after ${secs()}s. ${again}`;
      return `"${bot.name}" has not started on your message after ${secs()}s (queued, or its computer is waking). ${again}`;
    }
    await t.pause(POLL_MS);
  }
}
