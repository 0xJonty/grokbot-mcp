import crypto from "node:crypto";
import { GrokError } from "./errors.ts";
import { sydney } from "./time.ts";
import { resolveBot, type Bot, type Bots } from "./bots.ts";
import type { Transport } from "./transport.ts";

export interface Line {
  seq: number;
  id: string;
  ts?: number;
  role: string;
  text: string;
}

const PAGE_MAX = 200;

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).filter(Boolean).join("\n");
  if (c && typeof c === "object" && typeof (c as any).text === "string") return (c as any).text;
  return "";
}

/** Map a raw transcript entry to a display line; null for UI-only entries. */
export function entryLine(e: any, bot: Bot, names: Map<string, string>): Line | null {
  if (!e || typeof e !== "object" || typeof e.seq !== "number") return null;
  const ts = typeof e.timestampMs === "number" ? e.timestampMs : undefined;
  const base = { seq: e.seq, id: String(e.id ?? ""), ts };
  const author = e.authorAgentId ?? e.agentId ?? e.senderAgentId ?? e.authorId;
  const botName = (typeof author === "string" && names.get(author)) || bot.name;
  switch (e.kind) {
    case "message": {
      const role = e.role === "user" ? "you" : e.role === "assistant" ? botName : String(e.role ?? "msg");
      const userName = typeof e.authorName === "string" && e.role === "user" ? e.authorName : null;
      return { ...base, role: userName ?? role, text: contentText(e.content ?? e.text) };
    }
    case "send-message": {
      const m = e.message ?? {};
      if (m.type === "text" || typeof m.content === "string") return { ...base, role: botName, text: contentText(m.content) };
      if (m.type === "widget") {
        const opts = Array.isArray(m.widget?.options) ? m.widget.options.map((o: any) => o?.label).filter(Boolean).join(" / ") : "";
        return { ...base, role: botName, text: `[question] ${m.widget?.prompt ?? ""}${opts ? ` (options: ${opts})` : ""}` };
      }
      if (m.type === "connector") return { ...base, role: botName, text: `[connector request: ${m.connector ?? "?"}]` };
      return { ...base, role: botName, text: `[${m.type ?? "message"}]` };
    }
    case "notice":
      return { ...base, role: "notice", text: contentText(e.text) };
    case "event": {
      const ev = e.event ?? {};
      return { ...base, role: "event", text: [ev.type, ev.action, ev.automationName ?? ev.name].filter(Boolean).join(" ") };
    }
    case "feedback":
      return null;
    default: {
      const t = contentText(e.text ?? e.content ?? e.message?.content);
      return t ? { ...base, role: String(e.kind ?? "entry"), text: t } : null;
    }
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s;
}

async function tail(t: Transport, id: string, limit: number, beforeSeq?: number): Promise<{ entries: any[]; nextBeforeSeq?: number }> {
  const body: Record<string, unknown> = { id, limit: Math.min(PAGE_MAX, Math.max(1, limit)) };
  if (beforeSeq !== undefined) body.beforeSeq = beforeSeq;
  const data = await t.gateway("getAgentTranscriptTail", body, { idempotent: true });
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const n = Number(data?.nextBeforeSeq);
  return { entries, nextBeforeSeq: Number.isFinite(n) ? n : undefined };
}

export interface HistoryOpts {
  limit?: number;
  before?: number;
  after?: number;
  full?: boolean;
}

export async function history(t: Transport, bots: Bots, ref: string, opts: HistoryOpts): Promise<string> {
  const list = await bots.list();
  const bot = resolveBot(list, ref);
  const names = new Map(list.map((b) => [b.id, b.name]));
  const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 20)));
  if (opts.before !== undefined && opts.after !== undefined) throw new GrokError("invalid", "Use before or after, not both.");

  let lines: Line[] = [];
  let older: number | undefined;
  let newer: number | undefined;
  let moreNewer = false;

  if (opts.after !== undefined) {
    const after = opts.after;
    const raw: any[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await tail(t, bot.id, PAGE_MAX, cursor);
      raw.unshift(...r.entries);
      const oldest = r.entries[0]?.seq;
      if (r.nextBeforeSeq === undefined || typeof oldest !== "number" || oldest <= after + 1) break;
      cursor = r.nextBeforeSeq;
    }
    const all = raw.filter((e) => typeof e?.seq === "number" && e.seq > after).sort((a, b) => a.seq - b.seq)
      .map((e) => entryLine(e, bot, names)).filter((l): l is Line => !!l);
    lines = all.slice(0, limit);
    moreNewer = all.length > limit;
    if (lines.length) older = lines[0]!.seq;
  } else {
    let cursor = opts.before;
    let exhausted = false;
    for (let page = 0; page < 5 && lines.length < limit && !exhausted; page++) {
      const r = await tail(t, bot.id, Math.min(PAGE_MAX, limit * 2 + 10), cursor);
      const got = r.entries.map((e) => entryLine(e, bot, names)).filter((l): l is Line => !!l);
      lines = [...got, ...lines];
      if (r.nextBeforeSeq === undefined || r.entries.length === 0) exhausted = true;
      cursor = r.nextBeforeSeq;
    }
    if (lines.length > limit) {
      lines = lines.slice(-limit);
      exhausted = false;
    }
    if (!exhausted && lines.length) older = lines[0]!.seq;
  }
  if (lines.length) newer = lines[lines.length - 1]!.seq;

  const max = opts.full ? Infinity : 500;
  const head = [
    `${bot.isGroup ? "Group" : "Bot"}: ${bot.name} (${bot.id}) — ${lines.length} entries, newest last, times Australia/Sydney.`,
    older !== undefined ? `Older: before=${older}` : "Older: none",
    newer !== undefined ? `Newer: after=${newer}${moreNewer ? " (more newer entries exist)" : ""}` : "",
  ].filter(Boolean);
  const body = lines.map((l) => `[${sydney(l.ts)}] ${l.role} (#${l.seq}): ${truncate(l.text, max)}`);
  return [...head, "", ...(body.length ? body : ["(no messages)"])].join("\n");
}

export interface Receipt {
  delivery: "accepted" | "unknown";
  bot: string;
  botId: string;
  entryId?: string;
  seq?: number;
  clientNonce: string;
  sentAt: string;
}

export async function send(t: Transport, bots: Bots, ref: string, message: string): Promise<Receipt> {
  if (!message?.trim()) throw new GrokError("invalid", "Message is empty.");
  const bot = await bots.resolve(ref);
  const clientNonce = crypto.randomUUID();
  let data: any;
  try {
    data = await t.gateway("sendPrompt", { agentId: bot.id, prompt: message, clientNonce }, { idempotent: false });
  } catch (err) {
    if (err instanceof GrokError && (err.code === "delivery_unknown" || err.code === "timeout")) {
      throw new GrokError("delivery_unknown", `Delivery to "${bot.name}" unknown (${err.message}). Do NOT resend blindly: check grokbot_history first.`);
    }
    throw err;
  }
  const sentAt = sydney(Date.now());
  let entryId = typeof data?.messageId === "string" ? data.messageId : undefined;
  let seq: number | undefined;
  try {
    const r = await tail(t, bot.id, 20);
    const hit = r.entries.find((e) => e?.clientNonce === clientNonce || (entryId && e?.id === entryId));
    if (hit) {
      entryId = entryId ?? (typeof hit.id === "string" ? hit.id : undefined);
      seq = typeof hit.seq === "number" ? hit.seq : undefined;
    }
  } catch {}
  const accepted = !!entryId || data?.accepted === true;
  return { delivery: accepted ? "accepted" : "unknown", bot: bot.name, botId: bot.id, entryId, seq, clientNonce, sentAt };
}
