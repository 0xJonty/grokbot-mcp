import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSession, agent, ensureRunning, json, makeTransport, mockFetch, hibernated, appRoute } from "./helpers.ts";
import { Bots, etagOf, resolveBot, toBot } from "../src/bots.ts";
import { history, send } from "../src/history.ts";
import { unifiedDiff } from "../src/diff.ts";

const caps = (temporal: boolean) => () => json(200, { capabilities: { temporalCreationEnabled: temporal } });

/** Box-run bots: the box copy is authoritative and updates go to box updateAgent. */
function world(initial = [agent("id-1", "Alpha", { harness: "box" }), agent("id-2", "Beta", { harness: "box" })], temporal = false) {
  const agents = initial.map((a) => ({ ...a }));
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    GetGrokBotRuntimeCapabilities: caps(temporal),
    CreateGrokBotTemporalAgent: (c) => {
      agents.push(agent(c.body.agentId, c.body.name, { description: c.body.description }));
      return json(200, { agent: { id: "server-row", agentId: c.body.agentId, name: c.body.name, description: c.body.description, harness: "temporal", createdAtMs: "1795296000000" } });
    },
    listAgents: () => json(200, agents),
    updateAgent: (c) => {
      const a = agents.find((x) => x.id === c.body.id)!;
      Object.assign(a, { name: c.body.profile.name, description: c.body.profile.description }, c.body.profile.title !== undefined ? { title: c.body.profile.title } : {});
      if (c.body.profile.avatarShape !== undefined) a.avatarShape = c.body.profile.avatarShape;
      return json(200, { ok: true });
    },
    setAgentNotifyOnUpdates: (c) => {
      agents.find((x) => x.id === c.body.id)!.notifyOnUpdatesEnabled = c.body.isEnabled;
      return json(200, {});
    },
    createAgent: (c) => {
      const a = agent("id-new", c.body.name, { description: c.body.description });
      agents.push(a);
      return json(200, { agent: a });
    },
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  return { agents, m, t, bots: new Bots(t) };
}

test("resolve by id, case-insensitive name, ambiguity lists candidates", () => {
  const list = [agent("A1", "Dup"), agent("A2", "dup"), agent("B", "Solo")].map((a) => toBot(a)!);
  assert.equal(resolveBot(list, "solo").id, "B");
  assert.equal(resolveBot(list, "a1").id, "A1");
  assert.throws(() => resolveBot(list, "DUP"), (e: any) => e.code === "ambiguous" && /A1/.test(e.message) && /A2/.test(e.message));
  assert.throws(() => resolveBot(list, "zzz"), (e: any) => e.code === "not_found" && /Solo/.test(e.message));
});

test("update: preview shows unified diff and writes nothing", async () => {
  const w = world();
  const etag = etagOf(toBot(w.agents[0])!);
  const out = await w.bots.update("alpha", { instructions: "Instructions for Alpha\nline TWO\nline three" }, etag, false);
  assert.match(out, /PREVIEW/);
  assert.match(out, /-line two\n\+line TWO/);
  assert.equal(w.m.counts.updateAgent ?? 0, 0);
});

test("update: stale etag rejected before any write", async () => {
  const w = world();
  await assert.rejects(w.bots.update("Alpha", { title: "x" }, "deadbeefdeadbeef", true), (e: any) => e.code === "stale");
  assert.equal(w.m.counts.updateAgent ?? 0, 0);
});

test("update: confirm writes, re-reads and verifies; returns new etag", async () => {
  const w = world();
  const etag = etagOf(toBot(w.agents[0])!);
  const out = await w.bots.update("Alpha", { instructions: "new", notifyOnUpdates: false, avatarShape: "egg" }, etag, true);
  assert.match(out, /Verified/);
  const call = w.m.calls.find((c) => c.method === "updateAgent")!;
  assert.deepEqual(call.body, { id: "id-1", profile: { name: "Alpha", description: "new", avatarShape: "egg" } });
  assert.deepEqual(w.m.calls.find((c) => c.method === "setAgentNotifyOnUpdates")!.body, { id: "id-1", isEnabled: false });
  const newTag = out.match(/New etag: (\w+)/)![1];
  assert.equal(newTag, etagOf(toBot(w.agents[0])!));
  assert.notEqual(newTag, etag);
});

test("update: verification failure is reported", async () => {
  const w = world();
  const etag = etagOf(toBot(w.agents[0])!);
  // Server silently ignores the write.
  (w.m as any);
  const m2 = mockFetch({ EnsureSandBox: () => ensureRunning(), listAgents: () => json(200, w.agents), updateAgent: () => json(200, {}) });
  const { t } = makeTransport(new FakeSession(), m2.fn);
  const out = await new Bots(t).update("Alpha", { title: "T" }, etag, true);
  assert.match(out, /verification failed for: title/);
});

test("update: invalid avatar rejected", async () => {
  const w = world();
  await assert.rejects(w.bots.update("Alpha", { avatarColor: "pink" }, "x", true), (e: any) => e.code === "invalid");
});

test("create: preview does nothing; confirm creates once and verifies", async () => {
  const w = world();
  const prev = await w.bots.previewCreate({ name: "Gamma", instructions: "do things" });
  assert.match(prev, /PREVIEW/);
  assert.equal(w.m.counts.createAgent ?? 0, 0);
  const r = await w.bots.create({ name: "Gamma", instructions: "do things", avatarColor: "blue" });
  assert.equal(r.bot.id, "id-new");
  assert.ok(r.verified);
  const body = w.m.calls.find((c) => c.method === "createAgent")!.body;
  assert.equal(body.origin, "user");
  assert.equal(body.description, "do things");
  assert.equal(typeof body.clientNonce, "string");
  assert.equal(w.m.counts.createAgent, 1);
});

test("create: duplicate name refused", async () => {
  const w = world();
  await assert.rejects(w.bots.create({ name: "alpha", instructions: "x" }), (e: any) => e.code === "invalid");
});

test("create: unknown delivery is not retried", async () => {
  const m = mockFetch({ EnsureSandBox: () => ensureRunning(), GetGrokBotRuntimeCapabilities: caps(false), listAgents: () => json(200, []), createAgent: () => json(502, { error: "bad gateway" }) });
  const { t } = makeTransport(new FakeSession(), m.fn);
  await assert.rejects(new Bots(t).create({ name: "N", instructions: "x" }), (e: any) => e.code === "delivery_unknown");
  assert.equal(m.counts.createAgent, 1);
});

test("create: temporal unknown outcome is settled by id lookup, not retried", async () => {
  const id = { v: "" };
  const m = mockFetch({
    GetGrokBotRuntimeCapabilities: caps(true),
    EnsureSandBox: () => ensureRunning(),
    listAgents: () => json(200, []),
    CreateGrokBotTemporalAgent: (c) => ((id.v = c.body.agentId), json(503, { code: "unavailable", message: "x" })),
    ListGrokBotAgents: () => json(200, { agents: [] }),
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  await assert.rejects(new Bots(t).create({ name: "N", instructions: "x" }), (e: any) => e.code === "delivery_unknown" && /503/.test(e.message));
  assert.equal(m.counts.CreateGrokBotTemporalAgent, 1);
});

test("create: box 500 [permission_denied] is a definite failure with the reason", async () => {
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    GetGrokBotRuntimeCapabilities: caps(false),
    listAgents: () => json(200, []),
    createAgent: () => json(500, { error: "[permission_denied] A Sand box session is not permitted on this endpoint." }),
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  await assert.rejects(new Bots(t).create({ name: "N", instructions: "x" }), (e: any) => e.code === "gateway" && /permission_denied/.test(e.message));
  assert.equal(m.counts.createAgent, 1);
});

const entries = [
  { kind: "message", id: "t0u", role: "user", content: "hello bot", timestampMs: 1795296000000, seq: 7, clientNonce: "n0" },
  { kind: "feedback", id: "fb", seq: 8, timestampMs: 1795296000001 },
  { kind: "send-message", id: "t0s0", message: { type: "text", content: "x".repeat(800) }, timestampMs: 1795296035594, seq: 9 },
  { kind: "send-message", id: "t0s1", message: { type: "widget", widget: { prompt: "Pick", options: [{ label: "A" }, { label: "B" }] } }, timestampMs: 1795296035595, seq: 10 },
  { kind: "event", id: "ev", event: { type: "automation-changed", action: "created", automationName: "daily" }, timestampMs: 1795296035596, seq: 11 },
];

function historyWorld() {
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    listAgents: () => json(200, [agent("id-1", "Alpha", { harness: "box" })]),
    getAgentTranscriptTail: (c) => {
      const before = c.body.beforeSeq ?? Infinity;
      const avail = entries.filter((e) => e.seq < before);
      const page = avail.slice(-c.body.limit);
      return json(200, { entries: page, ...(avail.length > page.length ? { nextBeforeSeq: page[0]!.seq } : {}) });
    },
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  return { t, bots: new Bots(t), m };
}

test("history: compact, Sydney time, truncation, UI entries skipped", async () => {
  const h = historyWorld();
  const out = await history(h.t, h.bots, "alpha", { limit: 20 });
  assert.match(out, /\[2026-11-22 \d\d:\d\d\] you \(#7\): hello bot/);
  assert.match(out, /Alpha \(#9\): x{500}… \[\+300 chars\]/);
  assert.match(out, /\[question\] Pick \(options: A \/ B\)/);
  assert.match(out, /event \(#11\): automation-changed created daily/);
  assert.ok(!out.includes("#8"));
  assert.match(out, /Older: none/);
  assert.match(out, /Newer: after=11/);
  const full = await history(h.t, h.bots, "alpha", { limit: 20, full: true });
  assert.ok(full.includes("x".repeat(800)));
});

test("history: limit + before/after cursors", async () => {
  const h = historyWorld();
  const last2 = await history(h.t, h.bots, "alpha", { limit: 2 });
  assert.match(last2, /Older: before=10/);
  assert.ok(!last2.includes("#9"));
  const older = await history(h.t, h.bots, "alpha", { limit: 2, before: 10 });
  assert.match(older, /#7/);
  assert.match(older, /#9/);
  const newer = await history(h.t, h.bots, "alpha", { limit: 5, after: 9 });
  assert.ok(!newer.includes("#9)"));
  assert.match(newer, /#10/);
  assert.match(newer, /#11/);
});

test("send: receipt via clientNonce lookup; one sendPrompt only", async () => {
  const sent: any[] = [];
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    listAgents: () => json(200, [agent("id-1", "Alpha", { harness: "box" })]),
    sendPrompt: (c) => {
      sent.push(c.body);
      return json(200, { accepted: true });
    },
    getAgentTranscriptTail: () => json(200, { entries: [{ kind: "message", id: "t5u", role: "user", content: "hi", clientNonce: sent[0]?.clientNonce, seq: 42 }] }),
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  const r = await send(t, new Bots(t), "Alpha", "hi");
  assert.equal(r.delivery, "accepted");
  assert.equal(r.entryId, "t5u");
  assert.equal(r.seq, 42);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agentId, "id-1");
});

test("send: box asleep -> wake -> delivered once", async () => {
  const s = new FakeSession();
  s.app = appRoute();
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    listAgents: (c) => (c.url.includes("stale") ? hibernated() : json(200, [agent("id-1", "Alpha", { harness: "box" })])),
    sendPrompt: () => json(200, { messageId: "m1" }),
    getAgentTranscriptTail: () => json(200, { entries: [] }),
  });
  const { t } = makeTransport(s, m.fn);
  const r = await send(t, new Bots(t), "alpha", "hi");
  assert.equal(r.delivery, "accepted");
  assert.equal(m.counts.sendPrompt, 1);
});

// ---------------------------------------------------------------- server-run ("temporal") bots

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
/** api2 ListGrokBotTranscriptEntries page: newest first, int64 seq as string, body base64 JSON without seq. */
function serverPage(all: any[], before: number | undefined, limit: number) {
  const avail = all.filter((e) => e.seq < (before ?? Infinity));
  return avail.slice(-limit).reverse().map(({ seq, ...body }) => ({ seq: String(seq), entryKind: body.kind, body: b64(body), updatedSeq: String(seq), entryId: body.id }));
}

function serverWorld(extra: Record<string, any> = {}) {
  const sent: any[] = [];
  const transcript: any[] = entries.map((e) => ({ ...e }));
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    listAgents: () => json(200, [agent("id-1", "Alpha")]),
    ListGrokBotTranscriptEntries: (c) => json(200, { entries: serverPage(transcript, c.body.beforeSeq !== undefined ? Number(c.body.beforeSeq) : undefined, c.body.limit) }),
    SendGrokBotUserMessage: (c) => {
      sent.push(c);
      transcript.push({ kind: "message", id: "u-new", role: "user", content: c.body.text, clientNonce: c.body.messageId, timestampMs: 1795296099000, seq: 12 });
      return json(200, { dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
    },
    ...extra,
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  return { t, bots: new Bots(t), m, sent };
}

test("history: server-run bot is read from api2, not the box", async () => {
  const w = serverWorld();
  const out = await history(w.t, w.bots, "alpha", { limit: 20 });
  assert.equal(w.m.counts.getAgentTranscriptTail ?? 0, 0);
  assert.match(out, /you \(#7\): hello bot/);
  assert.match(out, /event \(#11\): automation-changed created daily/);
  assert.match(out, /Older: none/);
  const older = await history(w.t, w.bots, "alpha", { limit: 2, before: 10 });
  assert.match(older, /#7/);
  assert.match(older, /#9/);
  assert.ok(w.m.calls.some((c) => c.method === "ListGrokBotTranscriptEntries" && c.body.beforeSeq === "10"));
});

test("send: server-run bot uses SendGrokBotUserMessage with the app's headers; never the box", async () => {
  const w = serverWorld();
  const r = await send(w.t, w.bots, "Alpha", "ping");
  assert.equal(w.m.counts.sendPrompt ?? 0, 0);
  assert.equal(w.sent.length, 1);
  const c = w.sent[0];
  assert.equal(c.body.agentId, "id-1");
  assert.equal(c.body.text, "ping");
  assert.equal(c.body.messageId, r.clientNonce);
  assert.equal(c.body.source, "GROK_BOT_CLIENT_SURFACE_DESKTOP");
  assert.equal(c.headers["x-cursor-client-version"], "1.2.3");
  assert.equal(c.headers["x-cursor-client-source"], "sand-desktop");
  assert.match(c.headers["user-agent"], /Sand\/1\.2\.3/);
  assert.ok(c.headers["x-cursor-timezone"]);
  assert.equal(r.delivery, "accepted");
  assert.equal(r.seq, 12);
  assert.equal(r.entryId, "u-new");
  assert.equal(r.harness, "temporal");
});

test("send: server refusal returns the reason, endpoint and harness", async () => {
  const w = serverWorld({ SendGrokBotUserMessage: () => json(200, { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED", refusal: { failureCode: "x", message: "Bot is paused" } }) });
  await assert.rejects(send(w.t, w.bots, "Alpha", "ping"), (e: any) => /Bot is paused/.test(e.message) && /SendGrokBotUserMessage/.test(e.message) && /harness: temporal/.test(e.message));
});

test("send: server non-2xx includes endpoint and harness", async () => {
  const w = serverWorld({ SendGrokBotUserMessage: () => json(409, { code: "failed_precondition", message: "nope" }) });
  await assert.rejects(send(w.t, w.bots, "Alpha", "ping"), (e: any) => /409/.test(e.message) && /nope/.test(e.message) && /SendGrokBotUserMessage/.test(e.message) && /harness: temporal/.test(e.message));
});

test("send: unknown server outcome is settled by status, never resent", async () => {
  const w = serverWorld({
    SendGrokBotUserMessage: () => json(503, { code: "unavailable", message: "busy" }),
    GetGrokBotSendStatus: () => json(200, { status: "GROK_BOT_SEND_STATUS_NOT_FOUND" }),
  });
  await assert.rejects(send(w.t, w.bots, "Alpha", "ping"), (e: any) => e.code === "delivery_unknown" && /no record/.test(e.message));
  assert.equal(w.m.counts.SendGrokBotUserMessage, 1);
  const w2 = serverWorld({
    SendGrokBotUserMessage: () => json(503, { code: "unavailable", message: "busy" }),
    GetGrokBotSendStatus: () => json(200, { status: "GROK_BOT_SEND_STATUS_ACCEPTED", echoEntryId: "u-echo" }),
  });
  const r = await send(w2.t, w2.bots, "Alpha", "ping");
  assert.equal(r.delivery, "accepted");
  assert.equal(r.entryId, "u-echo");
  assert.equal(w2.m.counts.SendGrokBotUserMessage, 1);
});

test("send: box 409 'runs on the server' falls through to the server route once", async () => {
  const w = serverWorld({
    listAgents: () => json(200, [agent("id-1", "Alpha", { harness: undefined })]),
    sendPrompt: () => json(409, { error: "This Bot runs on the server, and this version of the app can't message it. Update the app and try again." }),
  });
  const r = await send(w.t, w.bots, "Alpha", "ping");
  assert.equal(w.m.counts.sendPrompt, 1);
  assert.equal(w.m.counts.SendGrokBotUserMessage, 1);
  assert.equal(r.delivery, "accepted");
});

test("list: server-run bot not yet on the box roster is still listed and resolvable", async () => {
  const w = serverWorld({
    ListGrokBotAgents: () =>
      json(200, {
        agents: [
          { id: "row-1", agentId: "id-1", name: "Alpha", description: "", harness: "temporal" },
          { id: "row-9", agentId: "id-9", name: "Fresh", description: "new", harness: "temporal", kind: "GROK_BOT_AGENT_KIND_AGENT" },
        ],
      }),
  });
  const list = await w.bots.list();
  assert.deepEqual(list.map((b) => b.id), ["id-1", "id-9"]);
  const b = await w.bots.resolve("fresh");
  assert.equal(b.id, "id-9");
  assert.equal(b.harness, "temporal");
});

test("list: box mirror of a server-run bot the server no longer has is dropped", async () => {
  const w = serverWorld({
    listAgents: () => json(200, [agent("id-1", "Alpha"), agent("ghost", "Gone"), agent("box-1", "Local", { harness: "box" })]),
    ListGrokBotAgents: () => json(200, { agents: [{ id: "r1", agentId: "id-1", name: "Alpha", description: "", harness: "temporal" }] }),
  });
  assert.deepEqual((await w.bots.list()).map((b) => b.id), ["id-1", "box-1"]);
});

test("list: server roster unavailable -> box roster as is", async () => {
  const w = serverWorld({ ListGrokBotAgents: () => json(503, { code: "unavailable", message: "x" }) });
  assert.deepEqual((await w.bots.list()).map((b) => b.id), ["id-1"]);
});

test("unified diff basics", () => {
  const d = unifiedDiff("f", "a\nb\nc", "a\nB\nc");
  assert.equal(d, "--- f (current)\n+++ f (proposed)\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  assert.equal(unifiedDiff("f", "same", "same"), "");
});
