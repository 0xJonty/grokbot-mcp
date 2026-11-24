// grokbot_wait: the server polls the bot's live state so the model does not sleep and re-check history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeSession, agent, ensureRunning, json, makeTransport, mockFetch } from "./helpers.ts";
import { Bots } from "../src/bots.ts";
import { forgetSent, send } from "../src/history.ts";
import { registerTools } from "../src/tools.ts";
import { POLL_MS, liveFromBoxRow, liveFromStatus, waitBudgetMs, waitFor } from "../src/wait.ts";

type Handler = Parameters<typeof mockFetch>[0][string];

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const page = (all: any[], before: number | undefined, limit: number) =>
  all
    .filter((e) => e.seq < (before ?? Infinity))
    .slice(-limit)
    .reverse()
    .map(({ seq, ...body }) => ({ seq: String(seq), entryKind: body.kind, body: b64(body), updatedSeq: String(seq), entryId: body.id }));

const idle = (lastActivityAtMs = 1795296000000) => ({ agentId: "id-1", client: { agentId: "id-1", lastActivityAtMs: String(lastActivityAtMs) } });
const running = (activity?: Record<string, string>) => ({ agentId: "id-1", isRunning: true, live: { agentId: "id-1", isRunning: true, ...(activity ? { activity } : {}) } });
const settled = (clientNonce: string, outcome = "success", settledAtMs = Date.now() + 1000) => ({
  agentId: "id-1",
  live: { agentId: "id-1", isRunning: false, lastTurnSettlement: { turnId: "t1", outcome, settledAtMs: String(settledAtMs), clientNonce } },
  client: { agentId: "id-1", lastActivityAtMs: String(settledAtMs) },
});

/**
 * One server-run bot. `statuses(n, nonce)` scripts the live state per status poll; `onStatus` lets a poll add
 * transcript rows (the bot replying while we wait).
 */
function world(statuses: (n: number, nonce: string) => any, extra: Record<string, Handler> = {}, onStatus?: (n: number, transcript: any[]) => void) {
  forgetSent();
  const transcript: any[] = [{ kind: "message", id: "u0", role: "user", content: "earlier", timestampMs: 1795296000000, seq: 1, clientNonce: "old" }];
  let nonce = "";
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    listAgents: () => json(200, [agent("id-1", "Alpha")]),
    ListGrokBotAgents: () => json(200, { agents: [{ id: "1", agentId: "id-1", name: "Alpha", description: "d", title: "", avatarShape: "cloud", avatarColor: "green", harness: "temporal", viewerIsOwner: true }] }),
    ListGrokBotTranscriptEntries: (c) => json(200, { entries: page(transcript, c.body.beforeSeq !== undefined ? Number(c.body.beforeSeq) : undefined, c.body.limit) }),
    SendGrokBotUserMessage: (c) => {
      nonce = c.body.messageId;
      transcript.push({ kind: "message", id: "u1", role: "user", content: c.body.text, clientNonce: nonce, timestampMs: 1795296099000, seq: 2 });
      return json(200, { dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
    },
    ListGrokBotAgentStatuses: (_c, n) => {
      onStatus?.(n, transcript);
      return json(200, { statuses: [statuses(n, nonce)] });
    },
    ...extra,
  });
  const { t, now } = makeTransport(new FakeSession(), m.fn);
  return { t, now, m, bots: new Bots(t), transcript };
}

const reply = (seq: number, text: string) => ({ kind: "send-message", id: `s${seq}`, message: { type: "text", content: text }, timestampMs: 1795296100000 + seq, seq });

test("live state: idle, running, composing, awaiting and stale rows", () => {
  const now = 1795296000000;
  assert.deepEqual(liveFromStatus(idle(now), now), { running: false, awaiting: false, activity: undefined, settlement: undefined, lastActivityAtMs: now });
  const r = liveFromStatus(running({ kind: "tool", tool: "web_search", detail: "gpu prices" }), now);
  assert.equal(r.running, true);
  assert.equal(r.activity, "tool web_search gpu prices");
  assert.equal(liveFromStatus({ live: { isComposingMessage: true } }, now).running, true);
  const aw = liveFromStatus({ isRunning: true, live: { isRunning: true, awaiting: { kind: "question" } } }, now);
  assert.deepEqual([aw.running, aw.awaiting], [false, true]);
  const stale = liveFromStatus({ live: { isRunning: true, updatedAtMs: String(now - 60_000), staleAfterMs: "30000" } }, now);
  assert.equal(stale.running, false);
  assert.equal(liveFromStatus(undefined, now).running, false);
  assert.deepEqual(liveFromBoxRow({ isRunningTurn: true }).running, true);
  assert.deepEqual(liveFromBoxRow({ isRunningTurn: true, awaitingUserResponse: {} }).awaiting, true);
});

test("wait after send: not started -> running -> settled; returns the reply as soon as the turn ends", async () => {
  const w = world(
    (n, nonce) => (n === 1 ? idle() : n <= 3 ? running({ kind: "tool", tool: "browse" }) : settled(nonce)),
    {},
    (n, tr) => {
      if (n === 4) tr.push(reply(3, "Here are the prices."));
    },
  );
  const r = await send(w.t, w.bots, "Alpha", "check prices");
  assert.equal(r.seq, 2);
  const t0 = w.now();
  const out = await waitFor(w.t, w.bots, "Alpha", { after: r.seq });
  assert.match(out, /^"Alpha" finished after \d+s\./);
  assert.match(out, /Alpha \(#3\): Here are the prices\./);
  assert.doesNotMatch(out, /#2\)/, "the user's own message is not repeated");
  assert.equal(w.m.counts.ListGrokBotAgentStatuses, 4);
  assert.equal(w.now() - t0, 3 * POLL_MS, "returns on the poll that sees the end, no extra sleeping");
  assert.equal(w.m.counts.SendGrokBotUserMessage, 1);
});

test("wait: fast turn that ended between polls is found in the transcript on the first poll", async () => {
  const w = world(() => idle(1795296200000));
  const r = await send(w.t, w.bots, "Alpha", "hi");
  w.transcript.push(reply(3, "hello!"));
  const out = await waitFor(w.t, w.bots, "Alpha", {});
  assert.match(out, /finished after 0s/);
  assert.match(out, /hello!/);
  assert.equal(w.m.counts.ListGrokBotAgentStatuses, 1);
  assert.equal(r.seq, 2);
});

test("wait: still working at the budget -> short 'call again' answer, then finished on the next call", async () => {
  let done = false;
  const w = world((_n, nonce) => (done ? settled(nonce) : running({ kind: "thinking" })));
  const r = await send(w.t, w.bots, "Alpha", "long job");
  const t0 = w.now();
  const out = await waitFor(w.t, w.bots, "Alpha", { after: r.seq, timeoutSec: 10 });
  assert.match(out, /^"Alpha" is still working \(thinking\) after \d+s\. Call grokbot_wait again with after=2\.$/);
  assert.ok(w.now() - t0 <= 10_000, "never blocks past the budget");
  done = true;
  w.transcript.push(reply(3, "done"));
  const out2 = await waitFor(w.t, w.bots, "Alpha", { after: r.seq });
  assert.match(out2, /finished after 0s/);
  assert.match(out2, /#3\): done/);
});

test("wait: sent but never started -> 'has not started' at the budget", async () => {
  const w = world(() => idle());
  await send(w.t, w.bots, "Alpha", "hi");
  const out = await waitFor(w.t, w.bots, "Alpha", { timeoutSec: 6 });
  assert.match(out, /has not started on your message after \d+s/);
  // The transcript is only re-read on the first poll or when the bot's last activity moves.
  assert.equal(w.m.counts.ListGrokBotAgentStatuses, 4);
  assert.equal(w.m.counts.ListGrokBotTranscriptEntries, 2, "send lookup and the first-poll check only");
});

test("wait: nothing sent from this server and the bot is idle -> returns at once", async () => {
  const w = world(() => idle());
  const out = await waitFor(w.t, w.bots, "Alpha", { after: 0 });
  assert.match(out, /^"Alpha" is idle \(no turn running\)\./);
  assert.match(out, /you \(#1\): earlier/);
  assert.equal(w.m.counts.ListGrokBotAgentStatuses, 1);
  assert.equal(await waitFor(w.t, w.bots, "Alpha", {}), '"Alpha" is idle (no turn running). Earlier messages: grokbot_history.');
});

test("wait: bot asks a question -> returns 'waiting for you' with the question", async () => {
  const w = world(
    (n) => (n === 1 ? running() : { agentId: "id-1", live: { agentId: "id-1", isRunning: true, awaiting: { kind: "question" } } }),
    {},
    (n, tr) => {
      if (n === 2) tr.push({ kind: "send-message", id: "q", message: { type: "widget", widget: { prompt: "Which store?", options: [{ label: "A" }] } }, timestampMs: 1795296100100, seq: 3 });
    },
  );
  await send(w.t, w.bots, "Alpha", "buy it");
  const out = await waitFor(w.t, w.bots, "Alpha", {});
  assert.match(out, /^"Alpha" is waiting for you/);
  assert.match(out, /\[question\] Which store\?/);
});

test("wait: failed turn is reported", async () => {
  const w = world((n, nonce) => (n === 1 ? running() : settled(nonce, "error")));
  await send(w.t, w.bots, "Alpha", "hi");
  assert.match(await waitFor(w.t, w.bots, "Alpha", {}), /finished with an error/);
});

test("wait: a settlement for someone else's message does not end the wait early", async () => {
  const w = world((n, nonce) => (n === 1 ? settled("other-nonce") : n === 2 ? running() : settled(nonce)));
  await send(w.t, w.bots, "Alpha", "hi");
  const out = await waitFor(w.t, w.bots, "Alpha", {});
  assert.match(out, /finished after/);
  assert.equal(w.m.counts.ListGrokBotAgentStatuses, 3);
});

test("wait: status RPC down -> falls back to the box roster", async () => {
  let down = false;
  let fallbackReads = 0;
  const w = world(() => idle(), {
    ListGrokBotAgentStatuses: () => {
      down = true;
      return json(503, { code: "unavailable", message: "busy" });
    },
    // Running on the first fallback read, idle after.
    listAgents: () => json(200, [agent("id-1", "Alpha", { isRunningTurn: down && ++fallbackReads === 1 })]),
  });
  await send(w.t, w.bots, "Alpha", "hi");
  const out = await waitFor(w.t, w.bots, "Alpha", {});
  assert.match(out, /finished after/);
  const tries = w.m.counts.ListGrokBotAgentStatuses!;
  assert.ok(tries >= 1 && tries <= 3, `api2 status is not retried on every poll (${tries})`);
});

test("wait: budget is clamped by GROKBOT_WAIT_MAX_SEC (default 50)", () => {
  assert.equal(waitBudgetMs(), 45_000);
  assert.equal(waitBudgetMs(600), 50_000);
  process.env.GROKBOT_WAIT_MAX_SEC = "900";
  try {
    assert.equal(waitBudgetMs(600), 600_000);
  } finally {
    delete process.env.GROKBOT_WAIT_MAX_SEC;
  }
});

test("grokbot_send waitSec: receipt plus the reply in one call; wait errors never hide the receipt", async () => {
  const w = world((n, nonce) => (n === 1 ? running() : settled(nonce)), {}, (n, tr) => {
    if (n === 2) tr.push(reply(3, "pong"));
  });
  const server = new McpServer({ name: "grokbot-mcp", version: "test" });
  registerTools(server, w.t, "test");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r: any = await client.callTool({ name: "grokbot_send", arguments: { bot: "Alpha", message: "ping", waitSec: 30 } });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /^Delivered to "Alpha"/);
  assert.match(r.content[0].text, /"Alpha" finished after/);
  assert.match(r.content[0].text, /#3\): pong/);

  const w2 = world(() => idle(), { ListGrokBotAgentStatuses: () => json(200, {}), ListGrokBotTranscriptEntries: () => json(401, { code: "unauthenticated" }) });
  const s2 = new McpServer({ name: "grokbot-mcp", version: "test" });
  registerTools(s2, w2.t, "test");
  const [a2, b2] = InMemoryTransport.createLinkedPair();
  const c2 = new Client({ name: "test", version: "0" });
  await Promise.all([s2.connect(a2), c2.connect(b2)]);
  const r2: any = await c2.callTool({ name: "grokbot_send", arguments: { bot: "Alpha", message: "ping", waitSec: 30 } });
  assert.ok(!r2.isError);
  assert.match(r2.content[0].text, /^Delivered to "Alpha"/);
  assert.match(r2.content[0].text, /Wait failed: .*Use grokbot_wait\./);
});
