// Build dist/grokbot-mcp-<version>.mcpb: a one-click Claude Desktop extension (MCP Bundle).
// Stages manifest + icon + the single-file server into dist/mcpb/, validates, then packs.
// The mcpb CLI is pinned and fetched with npx so its dev-only dependencies stay out of package-lock.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" });

const stage = path.join(root, "dist", "mcpb");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "server"), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(root, "mcpb", "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`mcpb/manifest.json version ${manifest.version} != package.json ${pkg.version}; update the manifest.`);
  process.exit(1);
}
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.copyFileSync(path.join(root, "mcpb", "icon.png"), path.join(stage, "icon.png"));
fs.copyFileSync(path.join(root, "dist", "grokbot-mcp.mjs"), path.join(stage, "server", "grokbot-mcp.mjs"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));

const out = path.join(root, "dist", `grokbot-mcp-${pkg.version}.mcpb`);
fs.rmSync(out, { force: true });
// npx is a .cmd shim on Windows, so go through the shell there.
const npx = (args) => execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", MCPB_CLI, ...args], { stdio: "inherit", shell: process.platform === "win32" });
npx(["validate", path.join(stage, "manifest.json")]);
npx(["pack", stage, out]);
console.log(`packed ${path.relative(root, out)}`);
