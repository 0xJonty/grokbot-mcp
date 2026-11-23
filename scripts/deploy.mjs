// Build and copy the bundle to the folder Claude Desktop launches it from.
// Default target: %USERPROFILE%\grokbot-mcp on Windows. From WSL it resolves the *Windows*
// user profile (the WSL and Windows user names can differ). Override with GROKBOT_MCP_DEPLOY_DIR.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function isWsl() {
  try {
    return process.platform === "linux" && /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function windowsProfileFromWsl() {
  // cmd.exe warns when started from a Linux cwd, so run it from /mnt/c.
  const win = execFileSync("cmd.exe", ["/d", "/c", "echo %USERPROFILE%"], { cwd: "/mnt/c", encoding: "utf8" }).trim();
  if (!/^[A-Za-z]:\\/.test(win)) throw new Error(`Could not read the Windows user profile (got "${win}"). Set GROKBOT_MCP_DEPLOY_DIR.`);
  return execFileSync("wslpath", ["-u", win], { encoding: "utf8" }).trim();
}

function targetDir() {
  if (process.env.GROKBOT_MCP_DEPLOY_DIR) return process.env.GROKBOT_MCP_DEPLOY_DIR;
  if (process.platform === "win32") return path.join(process.env.USERPROFILE || os.homedir(), "grokbot-mcp");
  if (isWsl()) return path.join(windowsProfileFromWsl(), "grokbot-mcp");
  throw new Error("This server runs on Windows. Set GROKBOT_MCP_DEPLOY_DIR to choose a folder.");
}

execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" });
const dir = targetDir();
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, "grokbot-mcp.mjs");
// Write to a temp name then rename, so a running server never sees a half-written file.
fs.copyFileSync(path.join(root, "dist", "grokbot-mcp.mjs"), dest + ".tmp");
fs.renameSync(dest + ".tmp", dest);
console.log(`deployed to ${dest}`);
if (isWsl()) console.log(`Windows path: ${execFileSync("wslpath", ["-w", dest], { encoding: "utf8" }).trim()}`);
