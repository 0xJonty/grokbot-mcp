// Server-run ("temporal") bots: the server copy is authoritative; the box holds a mirror.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSession, SECRET_ACCESS, agent, ensureRunning, json, makeTransport, mockFetch } from "./helpers.ts";
import { Bots, CHAT_METHOD_HINT, MAX_INSTRUCTIONS, botFull, etagOf, toBot } from "../src/bots.ts";
import { formatRoutine, routines } from "../src/routines.ts";

type Handler = Parameters<typeof mockFetch>[0][string];

const row = (id: string, agentId: string, name: string, description: string, extra: Record<string, unknown> = {}) => ({
  id,
  agentId,
  name,
  description,
  title: "",
  avatarShape: "cloud",
  avatarColor: "green",
  harness: "temporal",
  viewerIsOwner: true,
  createdAtMs: "1795296000000",
  updatedAtMs: "1795296000000",
  ...extra,
});

/** Box mirror + server store. Alpha's mirror lags the server; Beta's is in sync. */
function temporalWorld(over: Record<string, Handler> = {}) {
  const box: any[] = [agent("id-1", "Alpha"), agent("id-2", "Beta")];
  const server: any[] = [row("28922618", "id-1", "Alpha", "Server instructions for Alpha"), row("28922619", "id-2", "Beta", box[1]!.description)];
  let clock = 1795300000000;
  let rowSeq = 30000000;
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    GetGrokBotRuntimeCapabilities: () => json(200, { capabilities: { temporalCreationEnabled: true } }),
    listAgents: () => json(200, box),
    ListGrokBotAgents: () => json(200, { agents: server }),
    UpdateGrokBotAgent: (c) => {
      const r = server.find((x) => x.id === c.body.id);
      if (!r) return json(404, { code: "not_found", message: "agent not found" });
      for (const k of ["name", "description", "title", "avatarShape", "avatarColor"]) if (c.body[k] !== undefined) r[k] = c.body[k];
      r.updatedAtMs = String((clock += 1000));
      return json(200, { agent: { ...r } });
    },
    updateAgent: (c) => {
      // The mirror only takes server-held values.
      const a = box.find((x) => x.id === c.body.id)!;
      if (c.body.serverHeldFields?.length) Object.assign(a, c.body.profile);
      return json(200, {});
    },
    setAgentNotifyOnUpdates: (c) => {
      box.find((x) => x.id === c.body.id)!.notifyOnUpdatesEnabled = c.body.isEnabled;
      return json(200, {});
    },
    CreateGrokBotTemporalAgent: (c) => {
      // Live behaviour: a title passed at creation is folded into the name and the title is left empty.
      const name = c.body.title ? `${c.body.name} · ${c.body.title}` : c.body.name;
      const r = row(String(rowSeq++), c.body.agentId, name, c.body.description, { avatarShape: c.body.avatarShape, avatarColor: c.body.avatarColor });
      server.push(r);
      return json(200, { agent: { ...r } });
    },
    DeleteGrokBotAgent: (c) => {
      const i = server.findIndex((x) => x.agentId === c.body.id);
      if (i < 0) return json(404, { code: "not_found", message: "gone" });
      server.splice(i, 1);
      return json(200, {});
    },
    deleteAgents: (c) => {
      for (const id of c.body.ids) {
        const i = box.findIndex((x) => x.id === id);
        if (i >= 0) box.splice(i, 1);
      }
      return json(200, {});
    },
    ...over,
  });
  const session = new FakeSession();
  const { t } = makeTransport(session, m.fn);
  return { box, server, m, t, session, bots: new Bots(t) };
}

const idx = (m: ReturnType<typeof mockFetch>, method: string) => m.calls.findIndex((c) => c.method === method);

// ---------------------------------------------------------------- list / get

test("list: server-run bots take profile fields from the server row, box-only state from the box", async () => {
  const w = temporalWorld();
  w.box[0]!.notifyOnUpdatesEnabled = false;
  w.box[0]!.unreadCount = 3;
  const [alpha, beta] = await w.bots.list();
  assert.equal(alpha!.instructions, "Server instructions for Alpha");
  assert.equal(alpha!.source, "server");
  assert.equal(alpha!.serverRowId, "28922618");
  assert.equal(alpha!.viewerIsOwner, true);
  assert.equal(alpha!.serverUpdatedAt, 1795296000000);
  assert.equal(alpha!.mirrorInSync, false);
  assert.equal(alpha!.notifyOnUpdates, false);
  assert.equal(alpha!.unreadCount, 3);
  assert.equal(beta!.mirrorInSync, true);
  // The etag covers the server values, so the mirror's etag is stale.
  assert.notEqual(etagOf(alpha!), etagOf(toBot(w.box[0])!));
});

test("list: server list down -> box mirror rows, labelled", async () => {
  const w = temporalWorld({ ListGrokBotAgents: () => json(400, { code: "invalid_argument", message: "x" }) });
  const [alpha] = await w.bots.list();
  assert.equal(alpha!.source, "box-mirror (server unreachable)");
  assert.equal(alpha!.instructions, w.box[0]!.description);
  assert.equal(alpha!.serverRowId, undefined);
});

test("get_bot payload: labelled instructions, source, server edit time, last activity, mirror file", async () => {
  const w = temporalWorld();
  w.box[0]!.updatedAt = 1795299999000;
  const alpha = (await w.bots.list())[0]!;
  const p = botFull(alpha);
  assert.equal(p["instructions (hidden description)"], "Server instructions for Alpha");
  assert.equal(p.source, "server");
  assert.equal(p.mirrorInSync, false);
  assert.equal(p.serverUpdatedAt, 1795296000000);
  assert.equal(p.lastActivityAt, 1795299999000);
  assert.equal("updatedAt" in p, false);
  assert.equal("instructions" in p, false);
  assert.equal(p.profileFile, "/home/box/agent-data/agents/id-1/profile.json (box mirror, may be stale)");
  assert.equal(p.etag, etagOf(alpha));
});

// ---------------------------------------------------------------- update

async function liveTag(w: ReturnType<typeof temporalWorld>, i = 0) {
  return etagOf((await w.bots.list())[i]!);
}

test("update (server-run): server first, then box updateAgent with serverHeldFields; verified on the server", async () => {
  const w = temporalWorld();
  const etag = await liveTag(w);
  const preview = await w.bots.update("alpha", { instructions: "New rules" }, etag, false);
  assert.match(preview, /PREVIEW/);
  assert.match(preview, /server copy/);
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);

  const out = await w.bots.update("alpha", { instructions: "New rules" }, etag, true);
  const up = w.m.calls.find((c) => c.method === "UpdateGrokBotAgent")!;
  assert.deepEqual(up.body, { id: "28922618", partialUpdate: true, description: "New rules" });
  const mirror = w.m.calls.find((c) => c.method === "updateAgent")!;
  assert.ok(idx(w.m, "UpdateGrokBotAgent") < idx(w.m, "updateAgent"), "server write must come first");
  assert.deepEqual(mirror.body, {
    id: "id-1",
    profile: { name: "Alpha", description: "New rules" },
    editedFields: ["description"],
    serverHeldFields: ["description"],
    serverSavedAtMs: Number(w.server[0].updatedAtMs),
  });
  assert.equal(w.server[0].description, "New rules");
  assert.match(out, /^Updated "Alpha" \(id-1\) on server at 2026-\d\d-\d\d \d\d:\d\d Australia\/Sydney: instructions \(Verified on server; mirror in sync\)\. Takes effect from the bot's next turn or routine run\. New etag: [0-9a-f]{16}$/);
  assert.equal(out.match(/New etag: (\w+)/)![1], await liveTag(w));
});

test("update (server-run): only changed profile fields are sent; name + avatar map to the right names", async () => {
  const w = temporalWorld();
  const out = await w.bots.update("alpha", { name: " Alpha Two ", avatarColor: "blue", notifyOnUpdates: false }, await liveTag(w), true);
  assert.deepEqual(w.m.calls.find((c) => c.method === "UpdateGrokBotAgent")!.body, { id: "28922618", partialUpdate: true, name: "Alpha Two", avatarColor: "blue" });
  const mirror = w.m.calls.find((c) => c.method === "updateAgent")!.body;
  assert.deepEqual(mirror.profile, { name: "Alpha Two", description: "Server instructions for Alpha", avatarColor: "blue" });
  assert.deepEqual(mirror.serverHeldFields, ["name", "avatarColor"]);
  assert.deepEqual(mirror.editedFields, ["name", "avatarColor"]);
  assert.deepEqual(w.m.calls.find((c) => c.method === "setAgentNotifyOnUpdates")!.body, { id: "id-1", isEnabled: false });
  assert.match(out, /Updated "Alpha Two" .*name, avatarColor, notifyOnUpdates \(Verified on server/);
});

test("update (server-run): title is refused before any write (the server folds it into the name)", async () => {
  const w = temporalWorld();
  const etag = await liveTag(w);
  for (const confirm of [false, true]) {
    await assert.rejects(w.bots.update("alpha", { title: "Scout" }, etag, confirm), (e: any) => e.code === "invalid" && /Alpha · Scout/.test(e.message) && /Nothing written/.test(e.message));
  }
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
  assert.equal(w.m.counts.updateAgent ?? 0, 0);
});

test("update (server-run): refused server write -> chat-method message, nothing sent to the box", async () => {
  for (const [status, code] of [[403, "permission_denied"], [404, "unimplemented"], [404, "not_found"]] as const) {
    const w = temporalWorld({ UpdateGrokBotAgent: () => json(status, { code, message: "nope" }) });
    const etag = await liveTag(w);
    await assert.rejects(
      w.bots.update("alpha", { instructions: "x" }, etag, true),
      (e: any) => e.message.startsWith(`Server update refused (${code}).`) && e.message.includes(CHAT_METHOD_HINT),
    );
    assert.equal(w.m.counts.updateAgent ?? 0, 0, code);
    assert.equal(w.m.counts.UpdateGrokBotAgent, 1, `${code} is final, not retried`);
    assert.equal(w.session.forcedCredCalls, 0, "permission_denied is not treated as a sign-in failure");
  }
});

test("update (server-run): other server failure is reported and nothing is written to the box", async () => {
  const w = temporalWorld({ UpdateGrokBotAgent: () => json(400, { code: "invalid_argument", message: "description too long" }) });
  await assert.rejects(w.bots.update("alpha", { instructions: "x" }, await liveTag(w), true), (e: any) => /^Server update failed \(.*description too long/.test(e.message) && /Nothing written to the box mirror/.test(e.message));
  assert.equal(w.m.counts.updateAgent ?? 0, 0);
});

test("update (server-run): never falls back to a box-only write when the server copy is unavailable", async () => {
  const w = temporalWorld({ ListGrokBotAgents: () => json(400, { code: "invalid_argument", message: "x" }) });
  const etag = etagOf((await w.bots.list())[0]!);
  for (const patch of [{ instructions: "x" }, { name: "Alpha2" }, { avatarShape: "egg" }]) {
    await assert.rejects(w.bots.update("alpha", patch, etag, true), (e: any) => /could not be read/.test(e.message) && /Nothing written/.test(e.message));
  }
  assert.equal(w.m.counts.updateAgent ?? 0, 0);
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
});

test("update (server-run): box-only flags still work without the server copy", async () => {
  const w = temporalWorld({ ListGrokBotAgents: () => json(400, { code: "invalid_argument", message: "x" }) });
  const etag = etagOf((await w.bots.list())[0]!);
  const out = await w.bots.update("alpha", { notifyOnUpdates: false }, etag, true);
  assert.match(out, /Verified/);
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
});

test("update (server-run): not the owner -> refused before any write", async () => {
  const w = temporalWorld();
  w.server[0].viewerIsOwner = false;
  await assert.rejects(w.bots.update("alpha", { instructions: "x" }, await liveTag(w), false), (e: any) => /don't own/.test(e.message));
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
});

test("update (server-run): box mirror failure is a warning; verification still uses the server", async () => {
  const w = temporalWorld({ updateAgent: () => json(500, { error: "[failed_precondition] mirror busy" }) });
  const out = await w.bots.update("alpha", { instructions: "New rules" }, await liveTag(w), true);
  assert.match(out, /Verified on server; mirror lagging/);
  assert.match(out, /box mirror not updated \(.*mirror busy/);
  assert.equal(w.server[0].description, "New rules");
});

test("update (server-run): mirror that ignores the write does not fail verification", async () => {
  const w = temporalWorld({ updateAgent: () => json(200, {}) });
  const out = await w.bots.update("alpha", { instructions: "New rules" }, await liveTag(w), true);
  assert.match(out, /Verified on server; mirror lagging/);
});

test("update (server-run): server that did not apply the write fails verification", async () => {
  const w = temporalWorld({ UpdateGrokBotAgent: (c) => json(200, { agent: { ...w.server.find((x) => x.id === c.body.id), updatedAtMs: "1795300001000" } }) });
  const out = await w.bots.update("alpha", { instructions: "New rules" }, await liveTag(w), true);
  assert.match(out, /^WARNING: server accepted the update at .* but verification failed for: instructions/);
});

test("update (server-run): the mirror's etag is stale; only the server-value etag is accepted", async () => {
  const w = temporalWorld();
  const mirrorTag = etagOf(toBot(w.box[0])!);
  await assert.rejects(w.bots.update("alpha", { instructions: "x" }, mirrorTag, true), (e: any) => e.code === "stale");
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
});

// ---------------------------------------------------------------- input rules

test("input: trailing whitespace is stripped from instructions before sending", async () => {
  const w = temporalWorld();
  await w.bots.update("alpha", { instructions: "Line one\nLine two – “quoted” …\n\n  \t" }, await liveTag(w), true);
  assert.equal(w.m.calls.find((c) => c.method === "UpdateGrokBotAgent")!.body.description, "Line one\nLine two – “quoted” …");
  assert.equal(w.server[0].description, "Line one\nLine two – “quoted” …");
});

test("input: instructions over 20,000 chars and name/title over 255 are rejected before any write", async () => {
  const w = temporalWorld();
  const etag = await liveTag(w);
  await assert.rejects(w.bots.update("alpha", { instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }, etag, false), (e: any) => e.code === "invalid" && /20000/.test(e.message));
  await assert.rejects(w.bots.update("alpha", { name: "n".repeat(256) }, etag, false), (e: any) => e.code === "invalid");
  await assert.rejects(w.bots.update("alpha", { title: "t".repeat(256) }, etag, false), (e: any) => e.code === "invalid" && /255/.test(e.message));
  await assert.rejects(w.bots.create({ name: "N", instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }), (e: any) => e.code === "invalid");
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
  assert.equal(w.m.counts.CreateGrokBotTemporalAgent ?? 0, 0);
  // Exactly at the cap after stripping is fine.
  const ok = await w.bots.update("alpha", { instructions: "x".repeat(MAX_INSTRUCTIONS) + "\n\n" }, etag, false);
  assert.match(ok, /PREVIEW/);
});

// ---------------------------------------------------------------- create

test("create (server-run): title is refused before any write (the server folds it into the name)", async () => {
  const w = temporalWorld();
  await assert.rejects(w.bots.previewCreate({ name: "Gamma", instructions: "x", title: "Clip scout" }), (e: any) => e.code === "invalid" && /Gamma · Clip scout/.test(e.message));
  await assert.rejects(w.bots.create({ name: "Gamma", instructions: "x", title: "Clip scout" }), (e: any) => e.code === "invalid" && /no separate title/.test(e.message));
  assert.equal(w.m.counts.CreateGrokBotTemporalAgent ?? 0, 0);
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
});

test("create (server-run): sends title \"\", strips trailing whitespace, verifies name/title/instructions on the server", async () => {
  const w = temporalWorld();
  assert.match(await w.bots.previewCreate({ name: "Gamma", instructions: "do things" }), /PREVIEW/);
  const r = await w.bots.create({ name: "Gamma", instructions: "do things\n\n", avatarColor: "blue" });
  const cr = w.m.calls.find((c) => c.method === "CreateGrokBotTemporalAgent")!.body;
  assert.equal(cr.title, "");
  assert.equal(cr.name, "Gamma");
  assert.equal(cr.description, "do things");
  assert.equal(cr.harness, "GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL");
  assert.equal(w.m.counts.createAgent ?? 0, 0);
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
  assert.equal(r.bot.id, cr.agentId);
  assert.equal(r.bot.name, "Gamma");
  assert.ok(r.verified, "verified against the server row");
  assert.ok(r.listed);
});

test("create (server-run): server row that differs (e.g. folded name) is not verified", async () => {
  const w = temporalWorld({
    CreateGrokBotTemporalAgent: (c) => {
      const r = row("31000000", c.body.agentId, `${c.body.name} · x`, c.body.description);
      w.server.push(r);
      return json(200, { agent: r });
    },
  });
  const r = await w.bots.create({ name: "Gamma", instructions: "do things" });
  assert.equal(r.verified, false);
});

// ---------------------------------------------------------------- delete

test("delete: preview, exact confirmName required, then server delete + box mirror cleanup", async () => {
  const w = temporalWorld();
  assert.match(await w.bots.delete("beta", false), /PREVIEW — nothing deleted.*confirmName="Beta"/);
  await assert.rejects(w.bots.delete("beta", true), (e: any) => e.code === "invalid" && /exact name/.test(e.message));
  await assert.rejects(w.bots.delete("beta", true, "beta"), (e: any) => e.code === "invalid");
  assert.equal(w.m.counts.DeleteGrokBotAgent ?? 0, 0);
  assert.equal(w.m.counts.deleteAgents ?? 0, 0);
  const out = await w.bots.delete("beta", true, "Beta");
  assert.deepEqual(w.m.calls.find((c) => c.method === "DeleteGrokBotAgent")!.body, { id: "id-2" });
  assert.deepEqual(w.m.calls.find((c) => c.method === "deleteAgents")!.body, { ids: ["id-2"] });
  assert.ok(idx(w.m, "DeleteGrokBotAgent") < idx(w.m, "deleteAgents"));
  assert.match(out, /^Deleted "Beta" \(id-2\) on the server and the box mirror\. Verified/);
});

test("delete: server failure removes nothing from the box", async () => {
  const w = temporalWorld({ DeleteGrokBotAgent: () => json(403, { code: "permission_denied", message: "no" }) });
  await assert.rejects(w.bots.delete("beta", true, "Beta"), (e: any) => /Server delete failed/.test(e.message));
  assert.equal(w.m.counts.deleteAgents ?? 0, 0);
});

// ---------------------------------------------------------------- transport

test("backend 403 permission_denied is a refusal with its reason, not a sign-in error", async () => {
  const s = new FakeSession();
  const m = mockFetch({ UpdateGrokBotAgent: () => json(403, { code: "permission_denied", message: "not your bot" }) });
  const { t } = makeTransport(s, m.fn);
  await assert.rejects(t.backend("GrokBotService", "UpdateGrokBotAgent", {}), (e: any) => e.code === "backend" && /\[permission_denied\] not your bot/.test(e.message) && !e.message.includes(SECRET_ACCESS));
  assert.equal(m.counts.UpdateGrokBotAgent, 1);
  assert.equal(s.forcedCredCalls, 0);
});

// ---------------------------------------------------------------- routines

const routineRow = (record: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  automationId: "auto-1",
  routineId: "r-1",
  name: "Review clips",
  triggerDescription: "Daily at 7:30, 11:30, 15:30",
  schedule: "CRON_TZ=Australia/Sydney 30 7,11,15 * * *",
  isEnabled: true,
  nextRunAtMs: "1795339800000",
  createdAtMs: "1795296000000",
  recordJson: JSON.stringify({
    id: "r-1",
    name: "Review clips",
    prompt: "Review every new clip. ".repeat(40),
    trigger: { type: "cron", schedule: "CRON_TZ=Australia/Sydney 30 7,11,15 * * *", window: { earlyMinutes: 2, lateMinutes: 5 }, timing: "flexible" },
    schedule: "CRON_TZ=Australia/Sydney 30 7,11,15 * * *",
    triggerDescription: "Daily",
    isEnabled: true,
    createdAt: 1795296000000,
    filePath: "/home/box/sand-data/agents/id-1/automations/r-1/automation.json",
    runs: [
      { id: "run1", startedAt: 1795296000000, finishedAt: 1795296060000, status: "ok", reportedOutcome: { kind: "done", reason: "Reviewed 3 clips" } },
      { id: "run2", startedAt: 1795310400000, status: "error", error: "Automation run rate limit exceeded" },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `old${i}`, startedAt: 1795200000000 + i, status: "ok" })),
    ],
    ...record,
  }),
  ...extra,
});

test("routines: schedule, window, next run, truncated prompt, last 5 runs newest first, rate limit flagged", async () => {
  const w = temporalWorld({ ListGrokBotAgentRoutines: () => json(200, { routines: [routineRow({})] }) });
  const out = await routines(w.t, w.bots, "alpha");
  const req = w.m.calls.find((c) => c.method === "ListGrokBotAgentRoutines")!.body;
  assert.deepEqual(req, { agentId: "id-1", timeZone: "Australia/Sydney" });
  assert.match(out, /^Routines for "Alpha" \(1\); times in Australia\/Sydney:/);
  assert.match(out, /1\. Review clips \[enabled\]/);
  assert.match(out, /schedule: CRON_TZ=Australia\/Sydney 30 7,11,15 \* \* \* \(Daily at 7:30/);
  assert.match(out, /window -2\/\+5 min, timing flexible/);
  assert.match(out, /next run: 2026-11-2\d \d\d:\d\d/);
  assert.match(out, /prompt: Review every new clip\..*… \[\+\d+ chars\]/);
  assert.match(out, /last runs \(5 of 7, newest first\):\n {3}- .* failed RATE LIMITED \(Automation run rate limit exceeded; failed runs are not retried\)\n {3}- .* -> .* done: Reviewed 3 clips/);
  assert.ok(out.trimEnd().endsWith("This tool is read-only."));
  assert.equal(w.m.counts.UpdateGrokBotAgent ?? 0, 0);
  const full = formatRoutine(routineRow({}), 0, true).join("\n");
  assert.ok(full.includes("Review every new clip. ".repeat(40).trimEnd()));
});

test("routines: none and paused", async () => {
  const w = temporalWorld({ ListGrokBotAgentRoutines: () => json(200, { routines: [] }) });
  assert.match(await routines(w.t, w.bots, "alpha"), /\(none\)/);
  const lines = formatRoutine(routineRow({ runs: [] }, { isEnabled: false, nextRunAtMs: undefined }), 0, false).join("\n");
  assert.match(lines, /\[paused\]/);
  assert.match(lines, /runs: none recorded/);
});
