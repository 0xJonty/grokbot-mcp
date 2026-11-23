import { GrokError } from "./errors.ts";
import { log, redact } from "./log.ts";
import { routeFingerprint, type Credentials, type Route, type SessionSource } from "./session.ts";

export type FetchFn = typeof fetch;

export interface TransportDeps {
  session: SessionSource;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Total recovery budget per call (ms). */
  budgetMs?: number;
  /** Per-request timeout (ms). */
  requestTimeoutMs?: number;
  backendBase?: string;
}

export type RunState = "RUNNING" | "HIBERNATED" | "STARTING" | "ABSENT" | "UNSPECIFIED" | "UNKNOWN";

export interface BoxState {
  runState: RunState;
  route?: Route;
}

const RUN_STATE_PREFIX = "SAND_BOX_RUN_STATE_";

/** Outcome classes for a failed gateway request. */
type Failure =
  | { kind: "route_dead"; delivered: false; detail: string } // proxy says box asleep/unroutable, DNS, refused
  | { kind: "auth"; delivered: false; detail: string } // 401/403: request rejected
  | { kind: "transient"; delivered: "unknown"; detail: string } // 5xx, reset, timeout
  | { kind: "rejected"; delivered: false; status: number; detail: string }; // other 4xx: final

function isCursorBackend(u: URL) {
  const h = u.hostname.toLowerCase();
  return u.protocol === "https:" && (h === "cursor.sh" || h.endsWith(".cursor.sh") || h === "cursor.com" || h.endsWith(".cursor.com"));
}

function isGatewayHost(u: URL) {
  const h = u.hostname.toLowerCase();
  if (process.env.GROKBOT_MCP_TEST && (h === "127.0.0.1" || h === "localhost" || h.endsWith(".test"))) return true;
  return u.protocol === "https:" && (h.endsWith(".cursorvm.com") || h.endsWith(".cursor.sh") || h.endsWith(".cursor.com"));
}

function userAgentOs(): string {
  switch (process.platform) {
    case "win32":
      return "(Windows NT 10.0; Win64; x64)";
    case "darwin":
      return "(Macintosh; Intel Mac OS X 10_15_7)";
    case "linux":
      return "(X11; Linux x86_64)";
    default:
      return `(compatible; ${process.platform})`;
  }
}

function errCode(err: any): string {
  return String(err?.cause?.code ?? err?.code ?? err?.name ?? "");
}

/** Network-level failure that guarantees the request never reached the box. */
function isPreDelivery(err: any): boolean {
  const c = errCode(err);
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED"].includes(c);
}

function shortDetail(data: any, fallback: string): string {
  const d = data?.message || data?.error || data?.raw || fallback;
  return redact(String(d)).slice(0, 200);
}

/**
 * Connect codes that mean "the server refused the request", not "it may have run".
 * The box reports upstream Connect errors as HTTP 500 with a "[code] message" detail
 * (e.g. "[permission_denied] A Sand box session is not permitted on this endpoint.").
 */
const DEFINITE_CONNECT_CODES = new Set([
  "invalid_argument",
  "not_found",
  "already_exists",
  "permission_denied",
  "failed_precondition",
  "out_of_range",
  "unimplemented",
  "unauthenticated",
  "resource_exhausted",
]);

function connectCode(data: any, detail: string): string {
  if (typeof data?.code === "string") return data.code;
  return /^\[([a-z_]+)\]/.exec(detail)?.[1] ?? "";
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  if (text.length > 4 * 1024 * 1024) throw new GrokError("gateway", "Gateway response too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

export class Transport {
  session: SessionSource;
  private fetchFn: FetchFn;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  budgetMs: number;
  requestTimeoutMs: number;
  backendBase: string;

  /** Fresh route from our own EnsureSandBox, preferred over the app descriptor. */
  private route: Route | null = null;
  /** Fingerprints of routes known to be dead, so a stale app descriptor is not retried. */
  private deadRoutes = new Set<string>();
  private wakePending: Promise<Route> | null = null;
  lastRunState: RunState | null = null;
  lastWakeAt: number | null = null;

  constructor(deps: TransportDeps) {
    this.session = deps.session;
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.budgetMs = deps.budgetMs ?? 90_000;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 30_000;
    this.backendBase = (deps.backendBase ?? process.env.CURSOR_API_BASE_URL ?? "https://api2.cursor.sh").replace(/\/+$/, "");
  }

  // ---------------------------------------------------------------- backend (api2.cursor.sh)

  private async usableCredentials(force = false): Promise<Credentials> {
    let creds = await this.session.credentials({ force });
    if (creds.expMs !== undefined && creds.expMs < this.now() + 60_000 && !force) {
      creds = await this.session.credentials({ force: true });
    }
    if (creds.expMs !== undefined && creds.expMs < this.now()) {
      throw new GrokError("auth", "Grok Bot sign-in has expired. Open the Grok Bot app (it renews sign-in itself), then retry.");
    }
    return creds;
  }

  /**
   * Connect-JSON unary call to api2. Retries once with re-read credentials on 401/403.
   * `idempotent=false` (creates): only retries failures that guarantee non-delivery; a reset,
   * timeout or 5xx gives `delivery_unknown` and is never retried.
   */
  async backend(service: string, method: string, body: object = {}, opts: { timeoutMs?: number; idempotent?: boolean; headers?: Record<string, string> } = {}): Promise<any> {
    const idempotent = opts.idempotent ?? true;
    const url = new URL(`${this.backendBase}/aiserver.v1.${service}/${method}`);
    if (!isCursorBackend(url) && !process.env.GROKBOT_MCP_TEST) throw new GrokError("backend", "Refusing to send credentials to a non-Cursor backend URL.");
    for (let attempt = 0; ; attempt++) {
      const creds = await this.usableCredentials(attempt > 0);
      const version = this.session.appVersion();
      const headers: Record<string, string> = {
        // Per-call extras first so they can never override auth or client identity.
        ...(opts.headers ?? {}),
        "content-type": "application/json",
        "connect-protocol-version": "1",
        authorization: "Bearer " + creds.accessToken,
        // Same client identity as the desktop app (main-core.cjs `function Kpe(`).
        "user-agent": `Mozilla/5.0 ${userAgentOs()} AppleWebKit/537.36 (KHTML, like Gecko) Sand/${version} Safari/537.36`,
        "x-cursor-client-type": "sand",
        "x-cursor-client-version": version,
        "x-cursor-client-os": process.platform,
        "x-cursor-client-source": "sand-desktop",
        "x-sand-box-namespace": process.env.SAND_BOX_NAMESPACE || "prod",
        "x-ghost-mode": "true",
      };
      if (creds.teamId) headers["x-cursor-team-id"] = creds.teamId;
      let res: Response;
      let data: any;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs),
        });
        data = await readBody(res);
      } catch (err: any) {
        if (err instanceof GrokError) throw err;
        const c = errCode(err);
        if (attempt < 2 && (isPreDelivery(err) || (idempotent && (c === "ECONNRESET" || c === "UND_ERR_SOCKET")))) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        if (!idempotent && !isPreDelivery(err)) {
          throw new GrokError("delivery_unknown", `${method} outcome unknown (${c === "TimeoutError" ? "timeout" : c || "network error"}).`);
        }
        throw new GrokError(
          c === "TimeoutError" ? "timeout" : "backend",
          c === "TimeoutError" ? `Cursor backend timed out (${method}).` : `Cannot reach Cursor backend (${method}: ${c || "network error"}). Check internet connection.`,
        );
      }
      if (res.ok) return data;
      // Connect maps permission_denied to HTTP 403: the sign-in worked but the action is not allowed. That is a
      // definite refusal (shown with its reason below), not an auth failure.
      const authFailed = (res.status === 401 || res.status === 403 || data?.code === "unauthenticated") && data?.code !== "permission_denied";
      if (authFailed && attempt === 0) {
        log("info", `${method}: ${res.status}, re-reading app credentials`);
        continue;
      }
      if (authFailed) {
        throw new GrokError("auth", "Cursor rejected the Grok Bot sign-in. Open the Grok Bot app and make sure you are signed in, then retry.", res.status);
      }
      const detail = shortDetail(data, res.statusText);
      const code = connectCode(data, detail);
      const definite = res.status < 500 || DEFINITE_CONNECT_CODES.has(code);
      if (!definite && idempotent && attempt < 2) {
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      if (!definite && !idempotent) {
        throw new GrokError("delivery_unknown", `${method} outcome unknown (${res.status}${code ? " " + code : ""} ${detail}).`, res.status);
      }
      throw new GrokError("backend", `${method} failed: ${res.status}${code ? " [" + code + "]" : ""} ${detail}`, res.status);
    }
  }

  // ---------------------------------------------------------------- box lifecycle

  private routeFromEnsure(data: any): Route | null {
    const gatewayUrl = typeof data?.gatewayUrl === "string" ? data.gatewayUrl.replace(/\/+$/, "") : "";
    const gatewayToken = typeof data?.gatewayToken === "string" ? data.gatewayToken : "";
    if (!gatewayUrl || !gatewayToken) return null;
    const headers: Record<string, string> = {};
    const network = typeof data.networkToken === "string" ? data.networkToken : "";
    const port = typeof data.gatewayPortToken === "string" ? data.gatewayPortToken : "";
    // Mirrors the app (main-app.cjs `function uJ(`): port token when no network token.
    if (!network && port) headers["x-anyrun-port-token"] = port;
    else if (network) headers["x-anyrun-network-token"] = network;
    const refreshS = Number(data.credentialsRefreshAfterSeconds);
    const expiresAtMs = Number.isFinite(refreshS) && refreshS > 0 ? this.now() + Math.max(60, refreshS - 120) * 1000 : undefined;
    return { gatewayUrl, gatewayToken, headers, source: "ensure", expiresAtMs, fingerprint: routeFingerprint(gatewayUrl, gatewayToken, headers) };
  }

  private static runState(data: any): RunState {
    const s = String(data?.runState ?? "").replace(RUN_STATE_PREFIX, "");
    return (["RUNNING", "HIBERNATED", "STARTING", "ABSENT", "UNSPECIFIED"].includes(s) ? s : "UNKNOWN") as RunState;
  }

  /** Box state without waking it. */
  async boxState(): Promise<BoxState> {
    const data = await this.backend("GrokBotService", "EnsureSandBox", { wake: false, supportsAsleepBox: true }, { timeoutMs: 20_000 });
    const runState = Transport.runState(data);
    this.lastRunState = runState;
    const route = this.routeFromEnsure(data) ?? undefined;
    if (route && runState === "RUNNING") this.route = route;
    return { runState, route };
  }

  /** Wake the box and obtain a fresh route. Single-flight: concurrent callers share one wake-up. */
  wake(deadline: number): Promise<Route> {
    if (!this.wakePending) {
      this.wakePending = this.doWake(deadline).finally(() => {
        this.wakePending = null;
      });
    }
    return this.wakePending;
  }

  private async doWake(deadline: number): Promise<Route> {
    const started = this.now();
    log("info", "waking box via EnsureSandBox");
    for (let i = 0; ; i++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new GrokError("timeout", "Grok Bot cloud computer did not wake within 90s. Try again in a minute.");
      const data = await this.backend("GrokBotService", "EnsureSandBox", { wake: true, supportsAsleepBox: true }, { timeoutMs: Math.min(60_000, remaining) });
      const runState = Transport.runState(data);
      this.lastRunState = runState;
      const route = this.routeFromEnsure(data);
      if (route && (runState === "RUNNING" || runState === "UNKNOWN" || runState === "UNSPECIFIED")) {
        this.route = route;
        this.deadRoutes.delete(route.fingerprint);
        this.lastWakeAt = this.now();
        log("info", `box ready (${runState}) after ${this.now() - started}ms`);
        return route;
      }
      if (runState === "ABSENT" && i > 3) {
        throw new GrokError("route", "Grok Bot cloud computer is not provisioned. Open the Grok Bot app to set it up.");
      }
      await this.sleep(Math.min(3000, Math.max(0, deadline - this.now())));
    }
  }

  /** Best known route without network: our fresh one, else the app's descriptor unless known-dead. */
  private async knownRoute(): Promise<Route | null> {
    if (this.route && (!this.route.expiresAtMs || this.route.expiresAtMs > this.now()) && !this.deadRoutes.has(this.route.fingerprint)) return this.route;
    this.route = null;
    const app = await this.session.appRoute();
    if (app && !this.deadRoutes.has(app.fingerprint)) return app;
    return null;
  }

  /** Wait using the injected clock (tests advance a fake clock instead of sleeping). */
  pause(ms: number): Promise<void> {
    return this.sleep(ms);
  }

  hasRoute(): boolean {
    return !!this.route && (!this.route.expiresAtMs || this.route.expiresAtMs > this.now());
  }

  private markDead(route: Route) {
    this.deadRoutes.add(route.fingerprint);
    if (this.route?.fingerprint === route.fingerprint) this.route = null;
    if (this.deadRoutes.size > 50) this.deadRoutes = new Set([...this.deadRoutes].slice(-20));
  }

  // ---------------------------------------------------------------- gateway calls

  private async attempt(route: Route, method: string, body: object, timeoutMs: number): Promise<{ ok: true; data: any } | { ok: false; failure: Failure }> {
    const url = new URL(route.gatewayUrl + "/api/" + method);
    if (!isGatewayHost(url)) throw new GrokError("route", "Refusing to send credentials to unexpected gateway host.");
    let res: Response;
    let data: any;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: "Bearer " + route.gatewayToken, ...route.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await readBody(res);
    } catch (err: any) {
      if (err instanceof GrokError) throw err;
      const c = errCode(err);
      if (isPreDelivery(err)) return { ok: false, failure: { kind: "route_dead", delivered: false, detail: c } };
      return { ok: false, failure: { kind: "transient", delivered: "unknown", detail: c || "network error" } };
    }
    if (res.ok) return { ok: true, data };
    const proxy = res.headers.get("x-anyrun-error-source");
    const reason = res.headers.get("x-anyrun-failure-reason") || "";
    const detail = shortDetail(data, res.statusText);
    if (res.status === 417 || (proxy && reason) || (res.status === 404 && /could not be routed|no route|not routable/i.test(detail))) {
      return { ok: false, failure: { kind: "route_dead", delivered: false, detail: `${res.status} ${reason || detail}` } };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, failure: { kind: "auth", delivered: false, detail: String(res.status) } };
    if (res.status >= 500 && !proxy && DEFINITE_CONNECT_CODES.has(connectCode(data, detail))) {
      // Box-side refusal reported as 500 (e.g. upstream permission_denied): final, not transient.
      return { ok: false, failure: { kind: "rejected", delivered: false, status: res.status, detail } };
    }
    if (res.status >= 500) {
      // Proxy-level 502/503/504 mean the box did not answer.
      const kind = proxy ? "route_dead" : "transient";
      return kind === "route_dead"
        ? { ok: false, failure: { kind, delivered: false, detail: `${res.status} ${detail}` } }
        : { ok: false, failure: { kind, delivered: "unknown", detail: `${res.status} ${detail}` } };
    }
    return { ok: false, failure: { kind: "rejected", delivered: false, status: res.status, detail } };
  }

  /**
   * Call a box gateway method, transparently recovering from a sleeping box, stale routes,
   * expired route tokens and transient errors within the budget.
   * `idempotent=false` (create/send): only retries failures that guarantee non-delivery.
   */
  async gateway(method: string, body: object = {}, opts: { idempotent?: boolean } = {}): Promise<any> {
    const idempotent = opts.idempotent ?? true;
    const deadline = this.now() + this.budgetMs;
    let transientStreak = 0;
    let lastDetail = "";
    for (let n = 0; ; n++) {
      let route = await this.knownRoute();
      if (!route) route = await this.wake(deadline);
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      const r = await this.attempt(route, method, body, Math.min(this.requestTimeoutMs, remaining));
      if (r.ok) return r.data;
      const f = r.failure;
      lastDetail = f.detail;
      log("info", `${method} attempt ${n + 1} failed: ${f.kind} ${f.detail}`);
      if (f.kind === "rejected") throw new GrokError("gateway", `${method} failed: ${f.status} ${f.detail}`, f.status);
      if (f.kind === "transient" && !idempotent) {
        throw new GrokError("delivery_unknown", `${method} outcome unknown (${f.detail}). It may or may not have gone through; check before retrying.`);
      }
      if (f.kind === "route_dead" || f.kind === "auth") {
        this.markDead(route);
        transientStreak = 0;
        if (f.kind === "auth" && route.source === "app") await this.session.appRoute({ force: true }).catch(() => null);
      } else {
        transientStreak++;
        if (transientStreak >= 2) this.markDead(route);
      }
      const backoff = Math.min(8000, 500 * 2 ** Math.min(n, 4));
      if (this.now() + backoff >= deadline) break;
      // Route-dead failures go straight to wake (EnsureSandBox) on the next loop; no need to wait first.
      if (f.kind === "transient" || n > 1) await this.sleep(backoff);
    }
    throw new GrokError("timeout", `Grok Bot cloud computer unreachable after 90s (${method}: ${lastDetail}). Try again shortly; if it persists, open the Grok Bot app.`);
  }
}
