import fs from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 256 * 1024;

/** Redact anything that looks like a credential. Applied to every log line and error message. */
export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : input instanceof Error ? input.message : String(input);
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer <redacted>");
  s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "<jwt>");
  s = s.replace(/((?:token|authorization|secret|password|cookie|key)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1<redacted>");
  s = s.replace(/[A-Za-z0-9_+\/=-]{40,}/g, "<redacted>");
  return s;
}

function logFilePath(): string | null {
  if (process.env.GROKBOT_MCP_LOG === "0") return null;
  const base = process.env.LOCALAPPDATA;
  if (!base || process.platform !== "win32") return process.env.GROKBOT_MCP_LOG_FILE || null;
  return process.env.GROKBOT_MCP_LOG_FILE || path.join(base, "grokbot-mcp", "log.txt");
}

let fileReady: string | null | undefined;

function writeFile(line: string): void {
  try {
    if (fileReady === undefined) {
      const p = logFilePath();
      if (p) fs.mkdirSync(path.dirname(p), { recursive: true });
      fileReady = p;
    }
    if (!fileReady) return;
    try {
      if (fs.statSync(fileReady).size > MAX_LOG_BYTES) fs.renameSync(fileReady, fileReady.replace(/\.txt$/, "") + ".old.txt");
    } catch {}
    fs.appendFileSync(fileReady, line + "\n");
  } catch {
    fileReady = null;
  }
}

export type Level = "debug" | "info" | "warn" | "error";

/** Logs go to stderr (and the optional file), never stdout. `file:false` keeps startup disk-free. */
export function log(level: Level, msg: string, opts: { file?: boolean } = {}): void {
  if (level === "debug" && !process.env.GROKBOT_MCP_DEBUG) return;
  const line = `${new Date().toISOString()} ${level} ${redact(msg)}`;
  try {
    process.stderr.write(line + "\n");
  } catch {}
  if (opts.file !== false && !process.env.GROKBOT_MCP_TEST) writeFile(line);
}
