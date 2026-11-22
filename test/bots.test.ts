import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSession, agent, ensureRunning, json, makeTransport, mockFetch, hibernated, appRoute } from "./helpers.ts";
import { Bots, etagOf, resolveBot, toBot } from "../src/bots.ts";
import { history, send } from "../src/history.ts";
import { unifiedDiff } from "../src/diff.ts";

function world(initial = [agent("id-1", "Alpha"), agent("id-2", "Beta")]) {
  const agents = initial.map((a) => ({ ...a }));
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
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
  const prev = w.bots.previewCreate({ name: "Gamma", instructions: "do things" });
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
  const m = mockFetch({ EnsureSandBox: () => ensureRunning(), listAgents: () => json(200, []), createAgent: () => json(502, { error: "bad gateway" }) });
  const { t } = makeTransport(new FakeSession(), m.fn);
  await assert.rejects(new Bots(t).create({ name: "N", instructions: "x" }), (e: any) => e.code === "delivery_unknown");
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
    listAgents: () => json(200, [agent("id-1", "Alpha")]),
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
    listAgents: () => json(200, [agent("id-1", "Alpha")]),
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
    listAgents: (c) => (c.url.includes("stale") ? hibernated() : json(200, [agent("id-1", "Alpha")])),
    sendPrompt: () => json(200, { messageId: "m1" }),
    getAgentTranscriptTail: () => json(200, { entries: [] }),
  });
  const { t } = makeTransport(s, m.fn);
  const r = await send(t, new Bots(t), "alpha", "hi");
  assert.equal(r.delivery, "accepted");
  assert.equal(m.counts.sendPrompt, 1);
});

test("unified diff basics", () => {
  const d = unifiedDiff("f", "a\nb\nc", "a\nB\nc");
  assert.equal(d, "--- f (current)\n+++ f (proposed)\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  assert.equal(unifiedDiff("f", "same", "same"), "");
});
