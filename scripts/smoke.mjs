// Smoke test: spawn dist/grokbot-mcp.mjs over stdio with this node, list tools, call READ-ONLY tools.
// Run with Windows node from WSL:
//   "/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w scripts/smoke.mjs)" [botName]
// Never performs live create/update/send (previews only, confirm=false).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.env.GROKBOT_MCP_BIN || path.join(here, "..", "dist", "grokbot-mcp.mjs");
const wantBot = process.argv[2];

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GROKBOT_MCP_LOG: process.env.GROKBOT_MCP_LOG ?? "1" } });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("NON-JSON ON STDOUT (protocol violation):", line.slice(0, 200));
      process.exitCode = 1;
      continue;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
}

const results = [];
async function call(name, args = {}, show = (t) => t) {
  const t0 = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r.error);
  const ok = !r.error && !r.result?.isError;
  results.push({ name, ok, ms });
  console.log(`\n=== ${name} ${JSON.stringify(args)} — ${ok ? "OK" : "ERROR"} in ${ms}ms`);
  console.log(show(text));
  return { ok, text };
}

const t0 = Date.now();
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } }, 15_000);
console.log(`initialize: ${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version} in ${Date.now() - t0}ms`);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = await rpc("tools/list", {});
const names = tools.result.tools.map((t) => t.name);
const descChars = tools.result.tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
console.log(`tools (${names.length}, ${descChars} chars of schema): ${names.join(", ")}`);

await call("grokbot_status");
const list = await call("grokbot_list_bots");
let target = wantBot;
if (!target && list.ok) target = list.text.split("\n")[0]?.split(" | ")[1];
if (target) {
  const got = await call("grokbot_get_bot", { bot: target }, (t) => {
    try {
      const j = JSON.parse(t);
      return JSON.stringify({ ...j, instructions: `<${j.instructions.length} chars>` }, null, 1);
    } catch {
      return t;
    }
  });
  await call("grokbot_history", { bot: target, limit: 5 }, (t) => t.split("\n").map((l) => (l.length > 160 ? l.slice(0, 160) + "…" : l)).join("\n"));
  if (got.ok) {
    const etag = JSON.parse(got.text).etag;
    await call("grokbot_update_bot", { bot: target, etag, title: "smoke-preview-title", confirm: false });
  }
}
await call("grokbot_create_bot", { name: "Smoke Preview Bot", instructions: "preview only", confirm: false });
await call("grokbot_usage");
await call("grokbot_status");

child.stdin.end();
await new Promise((r) => child.on("exit", r));
const leaked = /eyJ[A-Za-z0-9_-]{10,}\.|Bearer [A-Za-z0-9]/.test(stderr);
console.log(`\nsummary: ${results.map((r) => `${r.name}=${r.ok ? "ok" : "ERR"}(${r.ms}ms)`).join(" ")}`);
console.log(`stderr lines: ${stderr.split("\n").filter(Boolean).length}; secret-like strings in stderr: ${leaked ? "YES (BUG)" : "none"}`);
if (results.some((r) => !r.ok) || leaked) process.exitCode = 1;
