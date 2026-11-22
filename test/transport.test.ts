import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSession, SECRET_ACCESS, appRoute, ensureRunning, hibernated, json, makeTransport, mockFetch, netErr } from "./helpers.ts";
import { GrokError } from "../src/errors.ts";

test("stale app route (417 pod_hibernated) wakes box via EnsureSandBox and retries with port token", async () => {
  const s = new FakeSession();
  s.app = appRoute();
  const m = mockFetch({
    listAgents: (c) => (c.url.includes("stale") ? hibernated() : json(200, [])),
    EnsureSandBox: () => ensureRunning(),
  });
  const { t } = makeTransport(s, m.fn);
  assert.deepEqual(await t.gateway("listAgents"), []);
  assert.equal(m.counts.EnsureSandBox, 1);
  const ens = m.calls.find((c) => c.method === "EnsureSandBox")!;
  assert.deepEqual(ens.body, { wake: true, supportsAsleepBox: true });
  assert.equal(ens.headers["x-cursor-client-version"], "1.2.3");
  assert.equal(ens.headers["connect-protocol-version"], "1");
  const last = m.calls.at(-1)!;
  assert.equal(last.headers["x-anyrun-port-token"], "freshport1");
  assert.equal(last.headers.authorization, "Bearer freshtoken1");
  assert.ok(last.url.startsWith("https://fresh1.us14.cursorvm.com/api/"));
  // Fresh route is reused; stale descriptor not retried.
  await t.gateway("listAgents");
  assert.equal(m.counts.EnsureSandBox, 1);
  assert.equal(m.calls.filter((c) => c.url.includes("stale")).length, 1);
});

test("404 could-not-be-routed triggers wake", async () => {
  const s = new FakeSession();
  s.app = appRoute();
  const m = mockFetch({
    listAgents: (c) => (c.url.includes("stale") ? json(404, { error: "host could not be routed" }) : json(200, [{ id: "a" }])),
    EnsureSandBox: () => ensureRunning(),
  });
  const { t } = makeTransport(s, m.fn);
  assert.deepEqual(await t.gateway("listAgents"), [{ id: "a" }]);
  assert.equal(m.counts.EnsureSandBox, 1);
});

test("unknown gateway method 404 is final, no wake", async () => {
  const s = new FakeSession();
  s.app = appRoute();
  const m = mockFetch({ EnsureSandBox: () => ensureRunning() });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.gateway("nope"), (e: any) => e instanceof GrokError && e.code === "gateway" && /404/.test(e.message));
  assert.equal(m.counts.EnsureSandBox ?? 0, 0);
});

test("no app descriptor: wakes immediately; STARTING is polled until RUNNING", async () => {
  const s = new FakeSession();
  const m = mockFetch({
    EnsureSandBox: (_c, n) => (n < 3 ? json(200, { runState: "SAND_BOX_RUN_STATE_STARTING" }) : ensureRunning()),
    listAgents: () => json(200, []),
  });
  const { t } = makeTransport(s, m.fn);
  await t.gateway("listAgents");
  assert.equal(m.counts.EnsureSandBox, 3);
});

test("connection reset on read is retried; transient 500 after wake retried", async () => {
  const s = new FakeSession();
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    getAgentTranscriptTail: (_c, n) => (n === 1 ? netErr("ECONNRESET") : n === 2 ? json(500, { error: "warming" }) : json(200, { entries: [] })),
  });
  const { t } = makeTransport(s, m.fn);
  assert.deepEqual(await t.gateway("getAgentTranscriptTail", { id: "x", limit: 1 }), { entries: [] });
  assert.equal(m.counts.getAgentTranscriptTail, 3);
});

test("send: connection reset => delivery unknown, never resent", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: () => ensureRunning(), sendPrompt: () => netErr("ECONNRESET") });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.gateway("sendPrompt", { agentId: "a", prompt: "hi" }, { idempotent: false }), (e: any) => e.code === "delivery_unknown");
  assert.equal(m.counts.sendPrompt, 1);
});

test("send: timeout => delivery unknown, never resent", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: () => ensureRunning(), sendPrompt: () => Object.assign(new Error("timed out"), { name: "TimeoutError" }) });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.gateway("sendPrompt", {}, { idempotent: false }), (e: any) => e.code === "delivery_unknown");
  assert.equal(m.counts.sendPrompt, 1);
});

test("send: hibernated / refused (pre-delivery) is safely retried after wake", async () => {
  const s = new FakeSession();
  s.app = appRoute();
  const m = mockFetch({
    EnsureSandBox: (_c, n) => ensureRunning(n),
    sendPrompt: (c, n) => (c.url.includes("stale") ? hibernated() : n === 2 ? netErr("ECONNREFUSED") : json(200, { messageId: "t1s0" })),
  });
  const { t } = makeTransport(s, m.fn);
  assert.deepEqual(await t.gateway("sendPrompt", {}, { idempotent: false }), { messageId: "t1s0" });
  assert.equal(m.counts.sendPrompt, 3);
  assert.equal(m.counts.EnsureSandBox, 2);
});

test("gateway 401 (expired route token) re-obtains route", async () => {
  const s = new FakeSession();
  const m = mockFetch({
    EnsureSandBox: (_c, n) => ensureRunning(n),
    listAgents: (c) => (c.headers.authorization === "Bearer freshtoken1" ? json(401, { error: "bad token" }) : json(200, [])),
  });
  const { t } = makeTransport(s, m.fn);
  assert.deepEqual(await t.gateway("listAgents"), []);
  assert.equal(m.counts.EnsureSandBox, 2);
});

test("backend 401 forces credential re-read then succeeds", async () => {
  const s = new FakeSession();
  const m = mockFetch({
    EnsureSandBox: (c) => (c.headers.authorization === `Bearer ${SECRET_ACCESS}` && s.forcedCredCalls === 0 ? json(401, { code: "unauthenticated" }) : ensureRunning()),
    listAgents: () => json(200, []),
  });
  const { t } = makeTransport(s, m.fn);
  await t.gateway("listAgents");
  assert.equal(s.forcedCredCalls, 1);
});

test("expired access token: re-read once, then actionable error without secrets", async () => {
  const s = new FakeSession();
  s.expMs = 1;
  const m = mockFetch({ EnsureSandBox: () => ensureRunning() });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.gateway("listAgents"), (e: any) => e.code === "auth" && /Open the Grok Bot app/.test(e.message) && !e.message.includes("SECRET"));
  assert.equal(s.forcedCredCalls, 1);
  assert.equal(m.counts.EnsureSandBox ?? 0, 0);
});

test("persistent 401 from backend -> sign-in error", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: () => json(401, { code: "unauthenticated", message: "token Bearer " + SECRET_ACCESS }) });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.gateway("listAgents"), (e: any) => e.code === "auth" && !e.message.includes(SECRET_ACCESS));
});

test("signed out -> clear error", async () => {
  const s = new FakeSession();
  s.signedOut = true;
  const { t } = makeTransport(s, mockFetch({}).fn);
  await assert.rejects(t.gateway("listAgents"), (e: any) => e.code === "signed_out" && /sign in/.test(e.message));
});

test("single-flight: concurrent calls share one wake-up", async () => {
  const s = new FakeSession();
  s.app = appRoute();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const m = mockFetch({
    EnsureSandBox: async () => {
      await gate;
      return ensureRunning();
    },
    listAgents: (c) => (c.url.includes("stale") ? hibernated() : json(200, [])),
  });
  const { t } = makeTransport(s, m.fn);
  const p = Promise.all([t.gateway("listAgents"), t.gateway("listAgents"), t.gateway("listAgents")]);
  setTimeout(release, 10);
  await p;
  assert.equal(m.counts.EnsureSandBox, 1);
});

test("budget exhausted -> timeout error, secret-free", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: () => ensureRunning(), listAgents: () => hibernated() });
  const { t } = makeTransport(s, m.fn, 20_000);
  await assert.rejects(t.gateway("listAgents"), (e: any) => e.code === "timeout" && !/freshtoken|freshport/.test(e.message));
  assert.ok(m.counts.EnsureSandBox! >= 2);
});

test("route expiry (credentialsRefreshAfterSeconds) forces a new EnsureSandBox", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: (_c, n) => ensureRunning(n), listAgents: () => json(200, []) });
  const { t, advance } = makeTransport(s, m.fn);
  await t.gateway("listAgents");
  advance(33_000 * 1000);
  await t.gateway("listAgents");
  assert.equal(m.counts.EnsureSandBox, 2);
});

test("boxState does not wake (wake:false)", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: () => json(200, { runState: "SAND_BOX_RUN_STATE_HIBERNATED" }) });
  const { t } = makeTransport(s, m.fn);
  assert.equal((await t.boxState()).runState, "HIBERNATED");
  assert.deepEqual(m.calls[0]!.body, { wake: false, supportsAsleepBox: true });
});

test("network-token variant uses x-anyrun-network-token", async () => {
  const s = new FakeSession();
  const m = mockFetch({
    EnsureSandBox: () => json(200, { runState: "SAND_BOX_RUN_STATE_RUNNING", gatewayUrl: "https://b.cursorvm.com", gatewayToken: "g", networkToken: "net", gatewayPortToken: "p" }),
    listAgents: () => json(200, []),
  });
  const { t } = makeTransport(s, m.fn);
  await t.gateway("listAgents");
  const last = m.calls.at(-1)!;
  assert.equal(last.headers["x-anyrun-network-token"], "net");
  assert.equal(last.headers["x-anyrun-port-token"], undefined);
});

test("refuses non-cursor gateway hosts", async () => {
  const s = new FakeSession();
  const m = mockFetch({ EnsureSandBox: () => json(200, { runState: "SAND_BOX_RUN_STATE_RUNNING", gatewayUrl: "https://evil.example.com", gatewayToken: "g", gatewayPortToken: "p" }) });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.gateway("listAgents"), (e: any) => e.code === "route");
  assert.equal(m.calls.filter((c) => c.url.includes("evil")).length, 0);
});
