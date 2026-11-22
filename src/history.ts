import crypto from "node:crypto";
import { GrokError } from "./errors.ts";
import { sydney } from "./time.ts";
import { resolveBot, type Bot, type Bots } from "./bots.ts";
import { log } from "./log.ts";
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

export const SERVER_SEND_ENDPOINT = "api2 GrokBotService/SendGrokBotUserMessage";
export const BOX_SEND_ENDPOINT = "box gateway /api/sendPrompt";

/** Bots that run on the server ("temporal" harness): the app messages and reads them via api2, not the box. */
export function runsOnServer(bot: Bot): boolean {
  return bot.harness === "temporal";
}

/** api2 transcript entry -> the box entry shape `entryLine` understands. Body is base64 JSON. */
export function serverEntry(e: any): any | null {
  const seq = Number(e?.seq);
  if (!Number.isFinite(seq)) return null;
  let body: any = null;
  if (typeof e.body === "string" && e.body) {
    try {
      body = JSON.parse(Buffer.from(e.body, "base64").toString("utf8"));
    } catch {}
  }
  if (!body || typeof body !== "object") {
    return { kind: "notice", id: String(e.entryId ?? ""), seq, text: `[${e.entryKind ?? "entry"} not shown: stored out of line]` };
  }
  return { ...body, seq, id: body.id ?? e.entryId, kind: body.kind ?? e.entryKind };
}

async function boxTail(t: Transport, id: string, limit: number, beforeSeq?: number): Promise<{ entries: any[]; nextBeforeSeq?: number }> {
  const body: Record<string, unknown> = { id, limit };
  if (beforeSeq !== undefined) body.beforeSeq = beforeSeq;
  const data = await t.gateway("getAgentTranscriptTail", body, { idempotent: true });
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const n = Number(data?.nextBeforeSeq);
  return { entries, nextBeforeSeq: Number.isFinite(n) ? n : undefined };
}

async function serverTail(t: Transport, id: string, limit: number, beforeSeq?: number): Promise<{ entries: any[]; nextBeforeSeq?: number }> {
  const body: Record<string, unknown> = { agentId: id, limit };
  if (beforeSeq !== undefined) body.beforeSeq = String(beforeSeq);
  const data = await t.backend("GrokBotService", "ListGrokBotTranscriptEntries", body);
  const raw = Array.isArray(data?.entries) ? data.entries : [];
  // The server returns newest first; `beforeSeq` is exclusive, like the box.
  const entries = raw.map(serverEntry).filter((e: any) => !!e).sort((a: any, b: any) => a.seq - b.seq);
  const oldest = entries[0]?.seq;
  return { entries, nextBeforeSeq: typeof oldest === "number" && oldest > 1 ? oldest : undefined };
}

/** Transcript page (oldest first). Server-run bots are read from api2 like the app; the box mirror is a fallback. */
async function tail(t: Transport, bot: Bot, limit: number, beforeSeq?: number): Promise<{ entries: any[]; nextBeforeSeq?: number }> {
  const n = Math.min(PAGE_MAX, Math.max(1, limit));
  if (!runsOnServer(bot)) return boxTail(t, bot.id, n, beforeSeq);
  try {
    return await serverTail(t, bot.id, n, beforeSeq);
  } catch (err) {
    if (err instanceof GrokError && (err.code === "auth" || err.code === "signed_out")) throw err;
    log("warn", `server transcript read failed for ${bot.id}, using box mirror: ${err instanceof Error ? err.message : String(err)}`);
    return boxTail(t, bot.id, n, beforeSeq);
  }
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
      const r = await tail(t, bot, PAGE_MAX, cursor);
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
      const r = await tail(t, bot, Math.min(PAGE_MAX, limit * 2 + 10), cursor);
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
  delivery: "accepted" | "pending" | "unknown";
  bot: string;
  botId: string;
  harness: string;
  endpoint: string;
  entryId?: string;
  seq?: number;
  clientNonce: string;
  sentAt: string;
}

const ENUM = (prefix: string, v: unknown) => String(v ?? "").replace(prefix, "");

/** Add the endpoint and harness to a failure so it can be diagnosed from the message alone. */
function withRoute(err: unknown, endpoint: string, harness: string): unknown {
  if (!(err instanceof GrokError)) return err;
  return new GrokError(err.code, `${err.message} [endpoint: ${endpoint}; harness: ${harness}]`, err.status);
}

export async function send(t: Transport, bots: Bots, ref: string, message: string): Promise<Receipt> {
  if (!message?.trim()) throw new GrokError("invalid", "Message is empty.");
  const bot = await bots.resolve(ref);
  const clientNonce = crypto.randomUUID();
  const harness = bot.harness ?? "unknown";
  if (runsOnServer(bot)) return sendViaServer(t, bot, message, clientNonce, harness);
  try {
    return await sendViaBox(t, bot, message, clientNonce, harness);
  } catch (err) {
    // A definite 409 "runs on the server" refusal means the box did not take it, so the server route is safe.
    if (err instanceof GrokError && err.status === 409 && /runs on the server/i.test(err.message)) {
      log("info", `box refused send to ${bot.id} (409 runs on the server); using server route`);
      return sendViaServer(t, bot, message, clientNonce, harness);
    }
    throw withRoute(err, BOX_SEND_ENDPOINT, harness);
  }
}

async function sendViaBox(t: Transport, bot: Bot, message: string, clientNonce: string, harness: string): Promise<Receipt> {
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
  const found = await findSent(t, bot, clientNonce, entryId);
  entryId = entryId ?? found.entryId;
  const accepted = !!entryId || data?.accepted === true;
  return { delivery: accepted ? "accepted" : "unknown", bot: bot.name, botId: bot.id, harness, endpoint: BOX_SEND_ENDPOINT, entryId, seq: found.seq, clientNonce, sentAt };
}

/**
 * Same call the app makes for server-run bots (main-app.cjs `async function e3e(` case "sendPrompt"):
 * api2 SendGrokBotUserMessage with messageId = clientNonce (the server dedupes on it).
 * An unknown outcome is settled with GetGrokBotSendStatus; we never resend.
 */
async function sendViaServer(t: Transport, bot: Bot, message: string, clientNonce: string, harness: string): Promise<Receipt> {
  const endpoint = SERVER_SEND_ENDPOINT;
  const tz = deviceTimeZone();
  const headers: Record<string, string> = { "x-cursor-client-capabilities": "grok-bot-email-offer-card" };
  if (tz) headers["x-cursor-timezone"] = tz;
  const req = {
    agentId: bot.id,
    messageId: clientNonce,
    text: message,
    sentAtMs: String(Date.now()),
    isFork: false,
    attachmentPaths: [],
    attachmentNames: [],
    source: "GROK_BOT_CLIENT_SURFACE_DESKTOP",
    initiator: "GROK_BOT_USER_MESSAGE_INITIATOR_USER",
    sendSource: "GROK_BOT_SEND_SOURCE_CHAT",
  };
  const sentAt = sydney(Date.now());
  const receipt = (delivery: Receipt["delivery"], entryId?: string, seq?: number): Receipt => ({ delivery, bot: bot.name, botId: bot.id, harness, endpoint, entryId, seq, clientNonce, sentAt });

  let data: any;
  try {
    data = await t.backend("GrokBotService", "SendGrokBotUserMessage", req, { idempotent: false, timeoutMs: 20_000, headers });
  } catch (err) {
    if (!(err instanceof GrokError) || (err.code !== "delivery_unknown" && err.code !== "timeout")) throw withRoute(err, endpoint, harness);
    return settleUnknown(t, bot, clientNonce, err.message, receipt, endpoint, harness);
  }
  const delivery = ENUM("GROK_BOT_USER_MESSAGE_DELIVERY_", data?.delivery);
  if (delivery === "REFUSED") {
    const why = data?.refusal?.message || data?.refusal?.failureCode || "no reason given";
    throw new GrokError("gateway", `Send to "${bot.name}" refused: ${why} [endpoint: ${endpoint}; harness: ${harness}]`);
  }
  if (delivery !== "ACCEPTED_TEMPORAL" && delivery !== "ACCEPTED_BOX" && delivery !== "DUPLICATE") {
    return settleUnknown(t, bot, clientNonce, `delivery ${delivery || "unspecified"}`, receipt, endpoint, harness);
  }
  const found = await findSent(t, bot, clientNonce);
  return receipt("accepted", found.entryId, found.seq);
}

async function settleUnknown(
  t: Transport,
  bot: Bot,
  clientNonce: string,
  why: string,
  receipt: (d: Receipt["delivery"], entryId?: string, seq?: number) => Receipt,
  endpoint: string,
  harness: string,
): Promise<Receipt> {
  let status = "";
  let echo: string | undefined;
  let rejection = "";
  try {
    const s = await t.backend("GrokBotService", "GetGrokBotSendStatus", { agentId: bot.id, messageId: clientNonce }, { timeoutMs: 20_000 });
    status = ENUM("GROK_BOT_SEND_STATUS_", s?.status);
    echo = typeof s?.echoEntryId === "string" && s.echoEntryId ? s.echoEntryId : undefined;
    rejection = typeof s?.rejectionCode === "string" ? s.rejectionCode : "";
  } catch {}
  const route = `[endpoint: ${endpoint}; harness: ${harness}]`;
  if (status === "ACCEPTED" || status === "PENDING") {
    const found = await findSent(t, bot, clientNonce, echo);
    return receipt(status === "ACCEPTED" ? "accepted" : "pending", echo ?? found.entryId, found.seq);
  }
  if (status === "REJECTED") throw new GrokError("gateway", `Send to "${bot.name}" rejected${rejection ? `: ${rejection}` : ""} ${route}`);
  const seen = status === "NOT_FOUND" ? " The server has no record of it yet." : "";
  throw new GrokError("delivery_unknown", `Delivery to "${bot.name}" unknown (${why}).${seen} Do NOT resend blindly: check grokbot_history first. ${route}`);
}

/** Look the sent message up in the transcript to report its entry id and # (best effort). */
async function findSent(t: Transport, bot: Bot, clientNonce: string, entryId?: string): Promise<{ entryId?: string; seq?: number }> {
  // The entry can land in the transcript a moment after the send is accepted.
  for (let i = 0; i < 3; i++) {
    if (i > 0) await t.pause(1000);
    try {
      const r = await tail(t, bot, 20);
      const hit = r.entries.find((e) => e?.clientNonce === clientNonce || (entryId && e?.id === entryId));
      if (hit) return { entryId: entryId ?? (typeof hit.id === "string" ? hit.id : undefined), seq: typeof hit.seq === "number" ? hit.seq : undefined };
    } catch {}
  }
  return { entryId };
}

function deviceTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}
