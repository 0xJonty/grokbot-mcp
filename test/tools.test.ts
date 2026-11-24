import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeSession, agent, ensureRunning, json, makeTransport, mockFetch } from "./helpers.ts";
import { registerTools, SERVER_INSTRUCTIONS } from "../src/tools.ts";
import { envFlag } from "../src/log.ts";
import { localTime, timeZone, timeZoneOverrideInvalid, systemTimeZone } from "../src/time.ts";

const manifest = JSON.parse(fs.readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8"));
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function connect() {
  const m = mockFetch({
    EnsureSandBox: () => ensureRunning(),
    listAgents: () => json(200, [agent("id-1", "Alpha", { harness: "box" })]),
  });
  const { t } = makeTransport(new FakeSession(), m.fn);
  const server = new McpServer({ name: "grokbot-mcp", title: "Grok Bot", version: "test" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, t, "test");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server, m };
}

test("tools/list: every tool has a title, annotations and described params; matches the MCPB manifest", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    manifest.tools.map((t: any) => t.name),
    "mcpb/manifest.json tools must list the registered tools in order",
  );
  for (const tool of tools) {
    const m = manifest.tools.find((x: any) => x.name === tool.name);
    assert.equal(m.description, tool.description, `manifest description drift for ${tool.name}`);
    assert.ok(tool.title, `${tool.name} has no title`);
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    for (const [k, v] of Object.entries<any>(tool.inputSchema.properties ?? {})) {
      if (k === "avatarShape" || k === "avatarColor" || k === "notifyOnUpdates" || k === "hiddenFromSidebar" || k === "name") continue;
      assert.ok(v.description, `${tool.name}.${k} has no description`);
    }
  }
  const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(ro, ["grokbot_get_bot", "grokbot_history", "grokbot_list_bots", "grokbot_routines", "grokbot_status", "grokbot_usage", "grokbot_wait"]);
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  assert.equal(client.getServerVersion()?.title, "Grok Bot");
});

test("get_bot: structuredContent matches the text JSON and the declared outputSchema", async () => {
  const { client } = await connect();
  const r: any = await client.callTool({ name: "grokbot_get_bot", arguments: { bot: "alpha" } });
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text));
  assert.equal(r.structuredContent.name, "Alpha");
  assert.match(r.structuredContent.etag, /^[0-9a-f]{16,}$/);
  assert.equal(typeof r.structuredContent["instructions (hidden description)"], "string");
  assert.equal(r.structuredContent.source, "box");
  assert.equal("updatedAt" in r.structuredContent, false);
});

test("input bounds: blank message and empty bot are rejected before any network call", async () => {
  const { client, m } = await connect();
  const before = m.calls.length;
  for (const args of [{ bot: "alpha", message: "   " }, { bot: "", message: "hi" }]) {
    const r: any = await client.callTool({ name: "grokbot_send", arguments: args }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(m.calls.length, before);
});

test("manifest version tracks package.json", () => {
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.compatibility.platforms, ["win32"]);
});

test("time zone: GROKBOT_TZ honoured; invalid or placeholder falls back to the system zone", () => {
  const saved = process.env.GROKBOT_TZ;
  const ts = Date.UTC(2026, 10, 22, 0, 30); // 2026-11-22 00:30 UTC
  try {
    process.env.GROKBOT_TZ = "UTC";
    assert.equal(localTime(ts), "2026-11-22 00:30");
    process.env.GROKBOT_TZ = "Australia/Sydney";
    assert.equal(localTime(ts), "2026-11-22 11:30");
    process.env.GROKBOT_TZ = "America/New_York";
    assert.equal(localTime(ts), "2026-11-21 19:30");
    process.env.GROKBOT_TZ = "Not/AZone";
    assert.equal(timeZone(), systemTimeZone());
    assert.equal(timeZoneOverrideInvalid(), true);
    process.env.GROKBOT_TZ = "${user_config.timezone}";
    assert.equal(timeZone(), systemTimeZone());
    assert.equal(timeZoneOverrideInvalid(), false);
    process.env.GROKBOT_TZ = "";
    assert.equal(timeZone(), systemTimeZone());
  } finally {
    process.env.GROKBOT_TZ = saved;
  }
});

test("envFlag: MCPB booleans and placeholders parse safely", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on"]) assert.equal(envFlag(v), true, v);
  for (const v of [undefined, "", "0", "false", "no", "off", "${user_config.debug}"]) assert.equal(envFlag(v), false, String(v));
});
