import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { GrokError } from "./errors.ts";
import { log } from "./log.ts";

/** Decrypted credentials of the active Grok Bot account. Never log or return these. */
export interface Credentials {
  accessToken: string;
  accountKey: string;
  teamId?: string;
  expMs?: number;
  email?: string;
  name?: string;
}

/** A gateway route: base URL + bearer token + routing headers (port/network token). */
export interface Route {
  gatewayUrl: string;
  gatewayToken: string;
  headers: Record<string, string>;
  source: "app" | "ensure";
  /** When this route should be considered expired (ms epoch), if known. */
  expiresAtMs?: number;
  fingerprint: string;
}

export interface DesktopStatus {
  appVersion?: string;
  signedIn?: boolean;
  pid?: number;
  startedAtMs?: number;
}

/** Abstract session source so tests can inject fakes. */
export interface SessionSource {
  credentials(opts?: { force?: boolean }): Promise<Credentials>;
  appRoute(opts?: { force?: boolean }): Promise<Route | null>;
  desktopStatus(): DesktopStatus | null;
  appVersion(): string;
}

export type Unprotect = (blob: Buffer) => Promise<Buffer>;

export function routeFingerprint(url: string, token: string, headers: Record<string, string>): string {
  return crypto.createHash("sha256").update(url + "\n" + token + "\n" + JSON.stringify(headers)).digest("hex").slice(0, 16);
}

/** DPAPI unwrap via Windows PowerShell (CurrentUser scope). Async so it never blocks the event loop. */
export const unprotectWithPowerShell: Unprotect = (blob) =>
  new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new GrokError("decrypt", "Decrypting the Grok Bot session needs Windows (DPAPI). Run this server with Windows node.exe."));
      return;
    }
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script =
      "Add-Type -AssemblyName System.Security; " +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
    const child = execFile(
      ps,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 30_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new GrokError("decrypt", "Could not unlock the Grok Bot session key (DPAPI/PowerShell failed). Are you running as the same Windows user as the app?"));
          return;
        }
        const key = Buffer.from(String(stdout).trim(), "base64");
        if (key.length !== 32) {
          reject(new GrokError("decrypt", "Grok Bot session key has an unexpected size."));
          return;
        }
        resolve(key);
      },
    );
    child.stdin?.end(blob.toString("base64"));
  });

/** Chromium os_crypt v10 AES-256-GCM. */
export function decryptV10(b64: string, key: Buffer): string {
  const e = Buffer.from(b64, "base64");
  if (e.length < 31 || e.subarray(0, 3).toString("latin1") !== "v10") {
    throw new GrokError("decrypt", "Unsupported Grok Bot Safe Storage format.");
  }
  const d = crypto.createDecipheriv("aes-256-gcm", key, e.subarray(3, 15));
  d.setAuthTag(e.subarray(-16));
  return Buffer.concat([d.update(e.subarray(15, -16)), d.final()]).toString("utf8");
}

/** Test helper: inverse of decryptV10. */
export function encryptV10(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from("v10"), iv, body, c.getAuthTag()]).toString("base64");
}

function jwtExpMs(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function defaultAppDataDir(): string {
  if (process.env.GROKBOT_APPDATA_DIR) return process.env.GROKBOT_APPDATA_DIR;
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME || "", "AppData", "Roaming");
  return path.join(appData, "Grok Bot");
}

interface Stamp {
  mtimeMs: number;
  size: number;
}

function stamp(p: string): Stamp | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

const sameStamp = (a: Stamp | null, b: Stamp | null) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw new GrokError("decrypt", `Could not read Grok Bot file ${path.basename(p)} (it may be mid-write; retry).`);
  }
}

/**
 * Reads the Grok Bot desktop app session lazily. Nothing touches disk until a method is called.
 * Results are cached and re-read when the underlying files change (mtime/size) or on `force`.
 */
export class AppSession implements SessionSource {
  dir: string;
  private unprotect: Unprotect;
  private key: { encryptedKey: string; key: Buffer } | null = null;
  private keyPending: Promise<Buffer> | null = null;
  private creds: { stamp: Stamp | null; lsStamp: Stamp | null; value: Credentials } | null = null;
  private route: { stamp: Stamp | null; accountKey: string; value: Route | null } | null = null;

  constructor(opts: { dir?: string; unprotect?: Unprotect } = {}) {
    this.dir = opts.dir ?? defaultAppDataDir();
    this.unprotect = opts.unprotect ?? unprotectWithPowerShell;
  }

  private file(name: string) {
    return path.join(this.dir, name);
  }

  desktopStatus(): DesktopStatus | null {
    const j = readJsonSafe(this.file("desktop-status.json"));
    return j && typeof j === "object" ? j : null;
  }

  appVersion(): string {
    const v = process.env.SAND_CLIENT_VERSION || this.desktopStatus()?.appVersion;
    return typeof v === "string" && /^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/.test(v) ? v : "1.2.3";
  }

  private async safeStorageKey(): Promise<Buffer> {
    const ls = readJson(this.file("Local State"));
    if (!ls) throw new GrokError("not_installed", "Grok Bot app data not found. Install the Grok Bot app and sign in.");
    const encryptedKey = ls?.os_crypt?.encrypted_key;
    if (typeof encryptedKey !== "string") throw new GrokError("decrypt", "Grok Bot Local State has no Safe Storage key. Open the Grok Bot app once.");
    if (this.key && this.key.encryptedKey === encryptedKey) return this.key.key;
    if (!this.keyPending) {
      const blob = Buffer.from(encryptedKey, "base64");
      if (blob.subarray(0, 5).toString("latin1") !== "DPAPI") {
        throw new GrokError("decrypt", "Grok Bot Safe Storage key is not DPAPI-wrapped.");
      }
      this.keyPending = this.unprotect(blob.subarray(5))
        .then((key) => {
          this.key = { encryptedKey, key };
          return key;
        })
        .finally(() => {
          this.keyPending = null;
        });
    }
    return this.keyPending;
  }

  private activeAccount(): { key: string; account: Record<string, string> } {
    const stored = readJson(this.file("sand-secrets.json"));
    if (!stored) throw new GrokError("signed_out", "Grok Bot app is not signed in (no saved session). Open Grok Bot and sign in.");
    if (stored.version != null && stored.version !== 1) throw new GrokError("decrypt", "Unsupported Grok Bot account storage version; update grokbot-mcp.");
    let accounts: any = null;
    try {
      accounts = JSON.parse(stored["cursor-accounts"] ?? "null");
    } catch {}
    const active = accounts?.active;
    if (typeof active !== "string" || !accounts?.accounts || !Object.hasOwn(accounts.accounts, active)) {
      throw new GrokError("signed_out", "Grok Bot app is signed out. Open Grok Bot and sign in.");
    }
    return { key: active, account: accounts.accounts[active] };
  }

  async credentials(opts: { force?: boolean } = {}): Promise<Credentials> {
    const st = stamp(this.file("sand-secrets.json"));
    const lsSt = stamp(this.file("Local State"));
    if (!opts.force && this.creds && sameStamp(this.creds.stamp, st) && sameStamp(this.creds.lsStamp, lsSt)) return this.creds.value;
    if (opts.force) this.key = null;
    const { key: accountKey, account } = this.activeAccount();
    const enc = account["cursor-access-token"];
    if (typeof enc !== "string" || !enc) throw new GrokError("signed_out", "Grok Bot account has no access token. Open Grok Bot and sign in again.");
    const key = await this.safeStorageKey();
    let accessToken: string;
    try {
      accessToken = decryptV10(enc, key).trim();
    } catch {
      // Key may have rotated under us: retry once with a fresh DPAPI unwrap.
      this.key = null;
      accessToken = decryptV10(enc, await this.safeStorageKey()).trim();
    }
    if (!accessToken) throw new GrokError("signed_out", "Grok Bot account has no access token. Open Grok Bot and sign in again.");
    let teamId: string | undefined;
    if (typeof account["cursor-selected-team-id"] === "string" && account["cursor-selected-team-id"]) {
      const t = decryptV10(account["cursor-selected-team-id"], key).trim();
      if (/^[1-9][0-9]*$/.test(t)) teamId = t;
    }
    let email: string | undefined, name: string | undefined;
    if (typeof account["cursor-account-profile"] === "string") {
      try {
        const p = JSON.parse(decryptV10(account["cursor-account-profile"], key));
        email = typeof p.email === "string" ? p.email : undefined;
        name = typeof p.name === "string" ? p.name : undefined;
      } catch {}
    }
    const value: Credentials = { accessToken, accountKey, teamId, expMs: jwtExpMs(accessToken), email, name };
    this.creds = { stamp: st, lsStamp: lsSt, value };
    log("debug", "credentials loaded");
    return value;
  }

  /** The app's own cached gateway route (may be stale if the box slept). */
  async appRoute(opts: { force?: boolean } = {}): Promise<Route | null> {
    const p = this.file("gateway-descriptor.json");
    const st = stamp(p);
    if (!st) return null;
    const { key: accountKey } = this.activeAccount();
    if (!opts.force && this.route && this.route.accountKey === accountKey && sameStamp(this.route.stamp, st)) return this.route.value;
    const wrapped = readJson(p);
    let encrypted: unknown;
    if (wrapped?.version === 2 || wrapped?.version === 3) encrypted = wrapped.entries?.[accountKey]?.encrypted;
    else if (wrapped?.version == null || wrapped?.version === 1) encrypted = wrapped?.encrypted;
    let value: Route | null = null;
    if (typeof encrypted === "string" && encrypted) {
      try {
        const d = JSON.parse(decryptV10(encrypted, await this.safeStorageKey()));
        if (d?.baseUrl && d?.token) {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(d.headers ?? {})) if (typeof v === "string" && v) headers[k.toLowerCase()] = v;
          const gatewayUrl = String(d.baseUrl).replace(/\/+$/, "");
          value = { gatewayUrl, gatewayToken: String(d.token), headers, source: "app", fingerprint: routeFingerprint(gatewayUrl, String(d.token), headers) };
        }
      } catch (err) {
        log("warn", "could not decrypt app gateway descriptor: " + (err as Error).message);
      }
    }
    this.route = { stamp: st, accountKey, value };
    return value;
  }
}

function readJsonSafe(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
