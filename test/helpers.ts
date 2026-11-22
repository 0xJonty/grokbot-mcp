import type { Credentials, DesktopStatus, Route, SessionSource } from "../src/session.ts";
import { routeFingerprint } from "../src/session.ts";
import { Transport } from "../src/transport.ts";

process.env.GROKBOT_MCP_TEST = "1";

export const SECRET_ACCESS = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SECRETSIGNATUREvalue1234567890";

export class FakeSession implements SessionSource {
  credCalls = 0;
  forcedCredCalls = 0;
  accessToken = SECRET_ACCESS;
  expMs: number | undefined = Date.now() + 86_400_000;
  app: Route | null = null;
  signedOut = false;
  async credentials(opts: { force?: boolean } = {}): Promise<Credentials> {
    this.credCalls++;
    if (opts.force) this.forcedCredCalls++;
    if (this.signedOut) {
      const { GrokError } = await import("../src/errors.ts");
      throw new GrokError("signed_out", "Grok Bot app is signed out. Open Grok Bot and sign in.");
    }
    return { accessToken: this.accessToken, accountKey: "acct", expMs: this.expMs, email: "someone@example.com", name: "Tester" };
  }
  async appRoute(): Promise<Route | null> {
    return this.app;
  }
  desktopStatus(): DesktopStatus | null {
    return { appVersion: "1.2.3", signedIn: true };
  }
  appVersion() {
    return "1.2.3";
  }
}

export function appRoute(url = "https://stale.us14.cursorvm.com", token = "staletoken"): Route {
  const headers = { "x-anyrun-port-token": "staleport" };
  return { gatewayUrl: url, gatewayToken: token, headers, source: "app", fingerprint: routeFingerprint(url, token, headers) };
}

export interface Call {
  url: string;
  method: string; // last path segment
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call, n: number) => Response | Promise<Response> | Error;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function netErr(code: string): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: { code } });
}

export const hibernated = () => new Response("", { status: 417, headers: { "x-anyrun-error-source": "anyrun-proxy", "x-anyrun-failure-reason": "pod_hibernated" } });

/** Mock fetch routing by method name; records every call. */
export function mockFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const fn = (async (input: any, init: any) => {
    const url = String(input);
    const method = url.split("/").pop()!;
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const call: Call = { url, method, headers, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    counts[method] = (counts[method] ?? 0) + 1;
    const h = handlers[method];
    if (!h) return json(404, { error: `unknown gateway method: ${method}`, failureCode: "gateway/unknown-method" });
    const r = await h(call, counts[method]!);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls, counts };
}

export const ensureRunning = (n = 1) =>
  json(200, {
    runState: "SAND_BOX_RUN_STATE_RUNNING",
    gatewayUrl: `https://fresh${n}.us14.cursorvm.com/`,
    gatewayToken: `freshtoken${n}`,
    networkToken: "",
    gatewayPortToken: `freshport${n}`,
    credentialsRefreshAfterSeconds: 32808,
  });

export function makeTransport(session: FakeSession, fetchFn: typeof fetch, budgetMs = 90_000) {
  let clock = Date.now();
  const t = new Transport({
    session,
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    budgetMs,
  });
  return { t, advance: (ms: number) => (clock += ms), now: () => clock };
}

export const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `Instructions for ${name}\nline two\nline three`,
  title: "",
  avatarShape: "cloud",
  avatarColor: "green",
  notifyOnUpdatesEnabled: true,
  isHiddenFromSidebar: false,
  isGroup: false,
  memberIds: [],
  harness: "temporal",
  ...extra,
});
