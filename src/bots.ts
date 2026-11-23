import crypto from "node:crypto";
import { GrokError, errorText } from "./errors.ts";
import { unifiedDiff } from "./diff.ts";
import { log } from "./log.ts";
import { localTime, timeZone } from "./time.ts";
import type { Transport } from "./transport.ts";

export const AVATAR_SHAPES = ["blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder", "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf"] as const;
export const AVATAR_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const;

/** The app truncates instructions to 20,000 chars (renderer `Fu=2e4`, `ace()`); we reject instead. */
export const MAX_INSTRUCTIONS = 20_000;
/** The app truncates name and title to 255 chars (`ace()`). */
export const MAX_NAME = 255;

export const SERVER_UPDATE_ENDPOINT = "api2 GrokBotService/UpdateGrokBotAgent";

/** Where a bot's name/instructions/title/avatar were read from. */
export type BotSource = "server" | "box" | "box-mirror (server unreachable)" | "box-mirror (not in server list)";

export interface Bot {
  id: string;
  name: string;
  title: string;
  instructions: string;
  avatarShape: string;
  avatarColor: string;
  notifyOnUpdates: boolean;
  hiddenFromSidebar: boolean;
  isGroup: boolean;
  memberIds: string[];
  harness?: string;
  origin?: string;
  createdAt?: number;
  /** Box `updatedAt`. It tracks last activity, not the last edit. */
  updatedAt?: number;
  lastActivityAt?: number;
  isRunningTurn?: boolean;
  unreadCount?: number;
  awaitingUserResponse?: boolean;
  lastMessagePreview?: string;
  /** api2 GrokBotAgent row id (e.g. "28922618"); UpdateGrokBotAgent needs it. Only known from the server list. */
  serverRowId?: string;
  viewerIsOwner?: boolean;
  /** Server `updatedAtMs`: when the profile/instructions were last written. */
  serverUpdatedAt?: number;
  source?: BotSource;
  /** Server-run bots: the box mirror's instructions equal the server's. */
  mirrorInSync?: boolean;
}

/** Fields grokbot_update_bot can change; the etag covers exactly these. */
export interface Editable {
  name: string;
  instructions: string;
  title: string;
  avatarShape: string;
  avatarColor: string;
  notifyOnUpdates: boolean;
  hiddenFromSidebar: boolean;
}

export const EDITABLE_KEYS = ["name", "instructions", "title", "avatarShape", "avatarColor", "notifyOnUpdates", "hiddenFromSidebar"] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

/** Profile fields (server-held for server-run bots) and their wire names (api2 and box use the same ones). */
const PROFILE_FIELD: Partial<Record<EditableKey, string>> = {
  name: "name",
  instructions: "description",
  title: "title",
  avatarShape: "avatarShape",
  avatarColor: "avatarColor",
};
const isProfileKey = (k: EditableKey) => PROFILE_FIELD[k] !== undefined;

/** Connect codes for which the server write will not work, so the documented chat method is the way. */
const REFUSED_CODES = new Set(["permission_denied", "unimplemented", "not_found"]);

/**
 * Live (2026-11-23): for server-run bots the server folds any title write (create or UpdateGrokBotAgent) into the
 * name ("Name · Title") and leaves the title empty, so a separate title can't be set. We refuse instead of renaming.
 */
export function titleFoldError(name: string, title: string): GrokError {
  return new GrokError(
    "invalid",
    `Server-run bots have no separate title: the server folds it into the name ("${name} · ${title}") and leaves the title empty. Leave title out, or put it in the name. Nothing written.`,
  );
}

export const CHAT_METHOD_HINT = "Use the documented chat method: ask the bot to replace its description with UpdateProfile and quote it back.";

export function toBot(a: any): Bot | null {
  const id = a?.id || a?.agentId;
  if (typeof id !== "string" || !id) return null;
  const memberIds = Array.isArray(a.memberIds) ? a.memberIds : Array.isArray(a.memberAgentIds) ? a.memberAgentIds : [];
  return {
    id,
    name: String(a.name ?? ""),
    title: String(a.title ?? ""),
    instructions: String(a.description ?? ""),
    avatarShape: String(a.avatarShape ?? ""),
    avatarColor: String(a.avatarColor ?? ""),
    notifyOnUpdates: Boolean(a.notifyOnUpdatesEnabled ?? a.notifyOnAgentUpdates ?? false),
    hiddenFromSidebar: Boolean(a.isHiddenFromSidebar ?? a.hiddenFromSidebar ?? false),
    isGroup: a.isGroup === true || (a.isGroup == null && memberIds.length > 0),
    memberIds,
    harness: typeof a.harness === "string" && a.harness ? a.harness : undefined,
    origin: typeof a.origin === "string" ? a.origin : undefined,
    createdAt: typeof a.createdAt === "number" ? a.createdAt : undefined,
    updatedAt: typeof a.updatedAt === "number" ? a.updatedAt : undefined,
    lastActivityAt: typeof a.lastActivityAt === "number" ? a.lastActivityAt : undefined,
    isRunningTurn: typeof a.isRunningTurn === "boolean" ? a.isRunningTurn : undefined,
    unreadCount: typeof a.unreadCount === "number" ? a.unreadCount : undefined,
    awaitingUserResponse: a.awaitingUserResponse != null ? true : undefined,
    lastMessagePreview: typeof a.lastMessagePreview === "string" ? a.lastMessagePreview : undefined,
  };
}

export function editable(b: Bot): Editable {
  return {
    name: b.name,
    instructions: b.instructions,
    title: b.title,
    avatarShape: b.avatarShape,
    avatarColor: b.avatarColor,
    notifyOnUpdates: b.notifyOnUpdates,
    hiddenFromSidebar: b.hiddenFromSidebar,
  };
}

export function etagOf(b: Bot | Editable): string {
  const e = "instructions" in b && "id" in b ? editable(b as Bot) : (b as Editable);
  const canonical = JSON.stringify(EDITABLE_KEYS.map((k) => [k, e[k]]));
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function resolveBot(bots: Bot[], ref: string): Bot {
  const needle = String(ref ?? "").trim().toLowerCase();
  if (!needle) throw new GrokError("invalid", "Bot name or id is required.");
  const byId = bots.find((b) => b.id.toLowerCase() === needle);
  if (byId) return byId;
  const matches = bots.filter((b) => b.name.trim().toLowerCase() === needle);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new GrokError("ambiguous", `"${ref}" matches ${matches.length} bots; use an id: ` + matches.map((b) => `${b.name} (${b.id})`).join(", "));
  }
  const names = bots.map((b) => b.name).slice(0, 30).join(", ");
  throw new GrokError("not_found", `No bot named "${ref}". Bots: ${names || "(none)"}`);
}

/** The "(detail)" from a transport "X outcome unknown (detail)." error, else the whole message. */
function unknownWhy(err: GrokError): string {
  return /outcome unknown \((.*)\)\./.exec(err.message)?.[1] ?? err.message;
}

const msOf = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** api2 GrokBotAgent -> Bot. Its `id` is the server row id (kept as serverRowId); the bot id everywhere else is `agentId`. */
export function serverAgentToBot(a: any): Bot | null {
  if (!a || typeof a.agentId !== "string" || !a.agentId) return null;
  const b = toBot({ ...a, id: a.agentId, createdAt: msOf(a.createdAtMs), updatedAt: undefined });
  if (!b) return null;
  if (a.id != null && a.id !== "") b.serverRowId = String(a.id);
  if (typeof a.viewerIsOwner === "boolean") b.viewerIsOwner = a.viewerIsOwner;
  b.serverUpdatedAt = msOf(a.updatedAtMs);
  b.source = "server";
  return b;
}

/** A server-run bot: profile (name, instructions, title, avatar) from the server row, box-only state from the box row. */
export function mergeServerRow(box: Bot, server: Bot): Bot {
  return {
    ...box,
    name: server.name,
    instructions: server.instructions,
    title: server.title,
    avatarShape: server.avatarShape,
    avatarColor: server.avatarColor,
    harness: server.harness ?? box.harness,
    createdAt: server.createdAt ?? box.createdAt,
    serverRowId: server.serverRowId,
    viewerIsOwner: server.viewerIsOwner,
    serverUpdatedAt: server.serverUpdatedAt,
    source: "server",
    mirrorInSync: box.instructions === server.instructions,
  };
}

/**
 * Box roster + server roster. For server-run ("temporal") bots the server copy is what runs read, so its profile
 * wins. A box row for a server-run bot the server no longer has is a stale mirror and is dropped, unless the server
 * list failed (kept, labelled) or was truncated. Server-only bots (not yet mirrored) are added.
 */
export function mergeRosters(box: Bot[], server: { bots: Bot[]; truncated: boolean } | null): Bot[] {
  const byId = new Map((server?.bots ?? []).map((b) => [b.id, b]));
  const out: Bot[] = [];
  for (const b of box) {
    const s = byId.get(b.id);
    const harness = s?.harness ?? b.harness;
    if (harness !== "temporal") {
      out.push({ ...b, source: "box" });
    } else if (s) {
      out.push(mergeServerRow(b, s));
    } else if (!server) {
      out.push({ ...b, source: "box-mirror (server unreachable)" });
    } else if (server.truncated) {
      out.push({ ...b, source: "box-mirror (not in server list)" });
    }
    // else: the server dropped it (e.g. just deleted) -> stale mirror, skip.
  }
  const ids = new Set(box.map((b) => b.id));
  for (const s of server?.bots ?? []) if (!ids.has(s.id)) out.push(s.harness === "temporal" ? { ...s, mirrorInSync: false } : s);
  return out;
}

function checkAvatar(kind: "shape" | "color", v: string | undefined): void {
  if (v === undefined || v === "") return;
  const allowed: readonly string[] = kind === "shape" ? AVATAR_SHAPES : AVATAR_COLORS;
  if (!allowed.includes(v)) throw new GrokError("invalid", `Unknown avatar ${kind} "${v}". Use one of: ${allowed.join(" ")}`);
}

/** Trailing whitespace is stripped: the box mirror trims trailing newlines, so keeping them makes the two copies differ. */
export function cleanInstructions(s: string): string {
  return s.replace(/\s+$/u, "");
}

function checkLengths(f: { name?: string; title?: string; instructions?: string }): void {
  if (f.instructions !== undefined && f.instructions.length > MAX_INSTRUCTIONS) {
    throw new GrokError("invalid", `Instructions are ${f.instructions.length} chars; the limit is ${MAX_INSTRUCTIONS} (the app cuts off anything longer). Shorten them.`);
  }
  if (f.name !== undefined && f.name.length > MAX_NAME) throw new GrokError("invalid", `Name is ${f.name.length} chars; the limit is ${MAX_NAME}.`);
  if (f.title !== undefined && f.title.length > MAX_NAME) throw new GrokError("invalid", `Title is ${f.title.length} chars; the limit is ${MAX_NAME}.`);
}

/** Connect code from a backend error ("X failed: 403 [permission_denied] ..."), else one implied by the HTTP status. */
function backendCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /\[([a-z_]+)\]/.exec(msg)?.[1];
  if (m) return m;
  const status = err instanceof GrokError ? err.status : undefined;
  return status === 404 ? "not_found" : status === 501 ? "unimplemented" : "";
}

/** A failed UpdateGrokBotAgent as a user-facing error. Nothing has been sent to the box at this point. */
function serverUpdateError(err: unknown): GrokError {
  if (err instanceof GrokError && (err.code === "auth" || err.code === "signed_out")) return err;
  const code = backendCode(err);
  if (REFUSED_CODES.has(code)) return new GrokError("backend", `Server update refused (${code}). Nothing was written. ${CHAT_METHOD_HINT}`, (err as GrokError)?.status);
  const why = errorText(err);
  return new GrokError(err instanceof GrokError ? err.code : "backend", `Server update failed (${why}). Nothing written to the box mirror; re-read with grokbot_get_bot before retrying.`);
}

const at = (ms: number | undefined) => (ms ? ` at ${localTime(ms)} ${timeZone()}` : "");

export class Bots {
  private t: Transport;
  /** Last successful list (used for name lookups by usage without waking the box). */
  cache: { at: number; bots: Bot[] } | null = null;

  constructor(t: Transport) {
    this.t = t;
  }

  /** Box roster merged with the server roster (see mergeRosters). Server list failures fall back to the box rows. */
  async list(): Promise<Bot[]> {
    const [data, server] = await Promise.all([
      this.t.gateway("listAgents", {}, { idempotent: true }),
      this.serverRoster().catch((err) => {
        log("warn", `server bot list failed, using box mirror: ${errorText(err)}`);
        return null;
      }),
    ]);
    const raw = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : [];
    const box: Bot[] = raw.map(toBot).filter((b: Bot | null): b is Bot => !!b);
    const bots = mergeRosters(box, server);
    this.cache = { at: Date.now(), bots };
    return bots;
  }

  async resolve(ref: string): Promise<Bot> {
    return resolveBot(await this.list(), ref);
  }

  // ------------------------------------------------------------- create

  /** No network unless a title is given (then the creation route decides whether a title is possible). */
  async previewCreate(input: CreateInput): Promise<string> {
    const c = validateCreate(input);
    if (c.title && (await this.creationRoute()) === "temporal") throw titleFoldError(c.name, c.title);
    return [
      "PREVIEW — nothing created. Call again with confirm=true to create.",
      `name: ${c.name}`,
      c.title ? `title: ${c.title}` : null,
      c.avatarShape ? `avatarShape: ${c.avatarShape}` : null,
      c.avatarColor ? `avatarColor: ${c.avatarColor}` : null,
      `instructions (${c.instructions.length} chars):`,
      c.instructions,
    ].filter((l) => l !== null).join("\n");
  }

  /**
   * Where the app creates bots: "temporal" (server-owned, api2 CreateGrokBotTemporalAgent) when the
   * account's runtime capabilities say so, else "box" (gateway createAgent). Mirrors the app's
   * resolveAgentCreation; with temporal creation on, the box refuses createAgent with permission_denied.
   */
  async creationRoute(): Promise<"temporal" | "box"> {
    const data = await this.t.backend("GrokBotService", "GetGrokBotRuntimeCapabilities", {}, { timeoutMs: 20_000 });
    return data?.capabilities?.temporalCreationEnabled === true ? "temporal" : "box";
  }

  /** Server-side roster (authoritative for temporal bots). Box ids are the server's `agentId`. */
  async serverList(): Promise<Bot[]> {
    return (await this.serverRoster()).bots;
  }

  private async serverRoster(): Promise<{ bots: Bot[]; truncated: boolean }> {
    const data = await this.t.backend("GrokBotService", "ListGrokBotAgents", {});
    const raw = Array.isArray(data?.agents) ? data.agents : [];
    return { bots: raw.map(serverAgentToBot).filter((b: Bot | null): b is Bot => !!b), truncated: data?.truncated === true };
  }

  async create(input: CreateInput): Promise<{ bot: Bot; verified: boolean; listed: boolean; etag: string }> {
    const c = validateCreate(input);
    const existing = await this.list();
    if (existing.some((b) => b.name.trim().toLowerCase() === c.name.toLowerCase())) {
      throw new GrokError("invalid", `A bot named "${c.name}" already exists. Pick another name or update that bot.`);
    }
    const nonce = crypto.randomUUID();
    const route = await this.creationRoute();
    if (route === "temporal" && c.title) throw titleFoldError(c.name, c.title);
    const created = route === "temporal" ? await this.createTemporal(c, nonce) : await this.createOnBox(c, nonce);

    const fresh = await this.list().catch(() => null);
    const listed = fresh?.find((b) => b.id === created.id) ?? null;
    let check: Bot | null = listed;
    // Server-run bots are verified against the server row, never the mirror.
    if (route === "temporal" && listed?.source !== "server") check = (await this.serverList().catch(() => null))?.find((b) => b.id === created.id) ?? null;
    const verified = !!check && check.name === c.name && check.instructions === c.instructions && check.title === (c.title ?? "");
    const bot = listed ?? check ?? created;
    return { bot, verified, listed: !!listed, etag: etagOf(bot) };
  }

  private async createTemporal(c: CreateInput, nonce: string): Promise<Bot> {
    // Same request the app sends (main-app.cjs G9e.create): agentId = clientNonce, no kickstart, no intro.
    // Title is always "": the server folds a title into the name (see titleFoldError), so create() refuses one.
    const req = {
      agentId: nonce,
      name: c.name,
      description: c.instructions,
      title: "",
      avatarShape: c.avatarShape ?? "",
      avatarColor: c.avatarColor ?? "",
      harness: "GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL",
      kickstartRequested: false,
      introductionSuppressed: true,
    };
    let data: any;
    try {
      data = await this.t.backend("GrokBotService", "CreateGrokBotTemporalAgent", req, { timeoutMs: 45_000, idempotent: false });
    } catch (err) {
      if (!(err instanceof GrokError) || (err.code !== "delivery_unknown" && err.code !== "timeout")) throw err;
      // The id is ours, so an unknown outcome can be settled exactly by looking it up.
      const found = (await this.serverList().catch(() => null))?.find((b) => b.id === nonce);
      if (found) return found;
      throw new GrokError("delivery_unknown", `Create outcome unknown (${unknownWhy(err)}) and the bot is not on the server yet. Run grokbot_list_bots before retrying.`);
    }
    const bot = serverAgentToBot(data?.agent);
    if (!bot || bot.id !== nonce) throw new GrokError("backend", "Server did not confirm the new bot. Run grokbot_list_bots to check.");
    return bot;
  }

  private async createOnBox(c: CreateInput, nonce: string): Promise<Bot> {
    const body: Record<string, unknown> = {
      name: c.name,
      description: c.instructions,
      title: c.title ?? "",
      avatarShape: c.avatarShape ?? "",
      avatarColor: c.avatarColor ?? "",
      origin: "user",
      clientNonce: nonce,
    };
    let data: any;
    try {
      data = await this.t.gateway("createAgent", body, { idempotent: false });
    } catch (err) {
      if (err instanceof GrokError && err.code === "delivery_unknown") {
        throw new GrokError("delivery_unknown", `Create outcome unknown (${unknownWhy(err)}). Run grokbot_list_bots to check whether it exists before retrying.`);
      }
      throw err;
    }
    const created = toBot(data?.agent ?? data);
    if (created) return created;
    const found = (await this.list().catch(() => null))?.find((b) => b.name === c.name);
    if (!found) throw new GrokError("gateway", "createAgent returned no bot. Run grokbot_list_bots to check.");
    return found;
  }

  // ------------------------------------------------------------- update

  async update(ref: string, patch: Partial<Editable>, etag: string, confirm: boolean): Promise<string> {
    if (!etag) throw new GrokError("invalid", "etag is required; get it from grokbot_get_bot.");
    const keys = EDITABLE_KEYS.filter((k) => patch[k] !== undefined);
    if (keys.length === 0) throw new GrokError("invalid", "Nothing to update: pass at least one field.");
    const clean: Partial<Editable> = { ...patch };
    if (patch.name !== undefined) {
      clean.name = patch.name.trim();
      if (!clean.name) throw new GrokError("invalid", "Name cannot be blank.");
    }
    if (patch.instructions !== undefined) clean.instructions = cleanInstructions(patch.instructions);
    checkLengths(clean);
    checkAvatar("shape", patch.avatarShape);
    checkAvatar("color", patch.avatarColor);
    const bot = await this.resolve(ref);
    const current = editable(bot);
    const liveTag = etagOf(current);
    if (liveTag !== etag) {
      throw new GrokError("stale", `Bot "${bot.name}" changed since your grokbot_get_bot (etag ${etag} ≠ live ${liveTag}). Re-read it and redo the edit.`);
    }
    const next: Editable = { ...current };
    for (const k of keys) (next as any)[k] = clean[k];
    const changed = EDITABLE_KEYS.filter((k) => next[k] !== current[k]);
    if (changed.length === 0) return `No changes: "${bot.name}" already has those values. etag: ${liveTag}`;
    const serverRun = bot.harness === "temporal";
    const profileKeys = changed.filter(isProfileKey);
    if (serverRun && changed.includes("title")) throw titleFoldError(next.name, next.title);
    if (serverRun && profileKeys.length) this.assertServerWritable(bot);

    if (!confirm) {
      const parts = [`PREVIEW for "${bot.name}" (${bot.id}) — nothing written. Call again with confirm=true and etag=${etag} to apply.`];
      if (serverRun && profileKeys.length) parts.push("Writes the server copy (what runs read), then the box mirror. Takes effect from the bot's next turn.");
      for (const k of changed) {
        if (k === "instructions") parts.push(unifiedDiff("instructions", current.instructions, next.instructions));
        else parts.push(`${k}: ${JSON.stringify(current[k])} -> ${JSON.stringify(next[k])}`);
      }
      return parts.join("\n");
    }
    if (serverRun) return this.updateServerRun(bot, next, changed);

    // Box-run bot: the box holds the authoritative copy.
    if (profileKeys.length) {
      const profile: Record<string, string> = { name: next.name, description: next.instructions };
      if (changed.includes("title")) profile.title = next.title;
      if (changed.includes("avatarShape")) profile.avatarShape = next.avatarShape;
      if (changed.includes("avatarColor")) profile.avatarColor = next.avatarColor;
      await this.t.gateway("updateAgent", { id: bot.id, profile }, { idempotent: true });
    }
    await this.setBoxFlags(bot.id, changed, next);
    const after = (await this.list()).find((b) => b.id === bot.id);
    if (!after) throw new GrokError("gateway", `Update sent but "${bot.name}" no longer appears in the bot list.`);
    const live = editable(after);
    const mismatched = changed.filter((k) => live[k] !== next[k]);
    const newTag = etagOf(live);
    if (mismatched.length) {
      return `WARNING: update sent but verification failed for: ${mismatched.join(", ")}. Live values differ; re-read with grokbot_get_bot. etag: ${newTag}`;
    }
    return `Updated "${after.name}" (${after.id}): ${changed.join(", ")}. Verified. New etag: ${newTag}`;
  }

  /** Server-run profile edits need the server row and ownership (the app's `CVr`); there is no box-only fallback. */
  private assertServerWritable(bot: Bot): void {
    if (!bot.serverRowId) {
      throw new GrokError(
        "backend",
        `"${bot.name}" runs on the server, but its server copy could not be read (${bot.source ?? "no server row"}). Nothing written: a box-only edit never reaches the bot. Retry shortly.`,
      );
    }
    if (bot.viewerIsOwner === false) {
      throw new GrokError("invalid", `You don't own "${bot.name}", so its profile can't be changed from here. Nothing written. ${CHAT_METHOD_HINT}`);
    }
  }

  private async setBoxFlags(id: string, changed: readonly EditableKey[], next: Editable, warnings?: string[]): Promise<Set<EditableKey>> {
    const failed = new Set<EditableKey>();
    const calls: [EditableKey, string, object][] = [
      ["notifyOnUpdates", "setAgentNotifyOnUpdates", { id, isEnabled: next.notifyOnUpdates }],
      ["hiddenFromSidebar", "setAgentHiddenFromSidebar", { id, isHidden: next.hiddenFromSidebar }],
    ];
    for (const [k, method, body] of calls) {
      if (!changed.includes(k)) continue;
      try {
        await this.t.gateway(method, body, { idempotent: true });
      } catch (err) {
        if (!warnings) throw err;
        failed.add(k);
        warnings.push(`${k} not changed (${errorText(err)})`);
      }
    }
    return failed;
  }

  /**
   * Server-run ("temporal") bot, the app's save path (renderer `et`/`tt`, main-app.cjs `updateIdentity`):
   * 1. api2 UpdateGrokBotAgent {id: rowId, partialUpdate: true, <changed profile fields>}; a failure stops here.
   * 2. box updateAgent with serverHeldFields + serverSavedAtMs so the mirror takes the server's values (a warning if it fails).
   * 3. notify/hidden (box-only state) via the box setters.
   * 4. verify against the server reply and a fresh ListGrokBotAgents, never the mirror.
   */
  private async updateServerRun(bot: Bot, next: Editable, changed: readonly EditableKey[]): Promise<string> {
    const profileKeys = changed.filter(isProfileKey);
    const warnings: string[] = [];
    let reply: Bot | null = null;
    let savedAtMs: number | undefined;
    if (profileKeys.length) {
      const req: Record<string, unknown> = { id: bot.serverRowId, partialUpdate: true };
      for (const k of profileKeys) req[PROFILE_FIELD[k]!] = next[k];
      let data: any;
      try {
        data = await this.t.backend("GrokBotService", "UpdateGrokBotAgent", req, { idempotent: true, timeoutMs: 30_000 });
      } catch (err) {
        throw serverUpdateError(err);
      }
      reply = serverAgentToBot(data?.agent);
      savedAtMs = reply?.serverUpdatedAt;
      const fields = profileKeys.map((k) => PROFILE_FIELD[k]!);
      const profile: Record<string, string> = { name: next.name, description: next.instructions };
      if (changed.includes("title")) profile.title = next.title;
      if (changed.includes("avatarShape")) profile.avatarShape = next.avatarShape;
      if (changed.includes("avatarColor")) profile.avatarColor = next.avatarColor;
      try {
        await this.t.gateway(
          "updateAgent",
          { id: bot.id, profile, editedFields: fields, serverHeldFields: fields, ...(savedAtMs && savedAtMs > 0 ? { serverSavedAtMs: savedAtMs } : {}) },
          { idempotent: true },
        );
      } catch (err) {
        warnings.push(`box mirror not updated (${errorText(err)}); it re-syncs from the server`);
      }
    }
    // With a server write done, flag failures are warnings; with nothing else written they are errors.
    const flagFailed = await this.setBoxFlags(bot.id, changed, next, profileKeys.length ? warnings : undefined);

    const fresh = await this.list().catch(() => null);
    const after = fresh?.find((b) => b.id === bot.id) ?? null;
    let serverRow = after?.source === "server" ? after : null;
    if (!serverRow && profileKeys.length) serverRow = (await this.serverList().catch(() => null))?.find((b) => b.id === bot.id) ?? null;
    const mismatched: string[] = [];
    for (const k of profileKeys) {
      const replyWrong = reply !== null && editable(reply)[k] !== next[k];
      const listWrong = serverRow !== null && editable(serverRow)[k] !== next[k];
      if (replyWrong || listWrong || (!reply && !serverRow)) mismatched.push(k);
    }
    const flagKeys = changed.filter((k) => !isProfileKey(k) && !flagFailed.has(k));
    if (flagKeys.length && !after) warnings.push(`could not re-read ${flagKeys.join(", ")} from the box`);
    for (const k of flagKeys) if (after && editable(after)[k] !== next[k]) mismatched.push(k);
    if (profileKeys.length && !serverRow) warnings.push("fresh server read failed; verified against the server reply only");

    const live: Editable | null = after?.source === "server" ? editable(after) : serverRow ? { ...editable(serverRow), notifyOnUpdates: next.notifyOnUpdates, hiddenFromSidebar: next.hiddenFromSidebar } : null;
    const tag = live ? etagOf(live) : null;
    const notes = warnings.length ? ` Note: ${warnings.join("; ")}.` : "";
    const name = serverRow?.name ?? next.name;
    if (mismatched.length) {
      const what = profileKeys.length ? `server accepted the update${at(savedAtMs)}` : "update sent";
      return `WARNING: ${what} but verification failed for: ${mismatched.join(", ")}. Re-read with grokbot_get_bot.${notes}${tag ? ` etag: ${tag}` : ""}`;
    }
    const tagText = tag ? `New etag: ${tag}` : "Re-read with grokbot_get_bot for a new etag.";
    if (!profileKeys.length) return `Updated "${name}" (${bot.id}): ${changed.join(", ")}. Verified.${notes} ${tagText}`;
    const mirror = after?.mirrorInSync === true ? "in sync" : after ? "lagging" : "unknown";
    return (
      `Updated "${name}" (${bot.id}) on server${at(savedAtMs)}: ${changed.join(", ")} (Verified on server; mirror ${mirror}). ` +
      `Takes effect from the bot's next turn or routine run.${notes} ${tagText}`
    );
  }

  // ------------------------------------------------------------- delete

  /**
   * Delete like the app: api2 DeleteGrokBotAgent {id: agentId} (not_found = already gone), then box
   * deleteAgents {ids} to drop the mirror. Box-run bots are deleted on the box only.
   */
  async delete(ref: string, confirm: boolean, confirmName?: string): Promise<string> {
    const bot = await this.resolve(ref);
    const serverRun = bot.harness === "temporal";
    if (serverRun && bot.source !== "server") {
      throw new GrokError("backend", `Can't delete "${bot.name}" now: its server copy could not be read (${bot.source}). Nothing deleted; retry shortly.`);
    }
    if (bot.viewerIsOwner === false) throw new GrokError("invalid", `You don't own "${bot.name}"; only its owner can delete it.`);
    if (!confirm) {
      return (
        `PREVIEW — nothing deleted. Deleting "${bot.name}" (${bot.id}) is permanent: its chat, memory and routines go; files on the shared computer stay. ` +
        `To delete, call again with confirm=true and confirmName="${bot.name}".`
      );
    }
    if (confirmName !== bot.name) throw new GrokError("invalid", `confirmName must be the bot's exact name ("${bot.name}"). Nothing deleted.`);
    const notes: string[] = [];
    if (serverRun) {
      try {
        await this.t.backend("GrokBotService", "DeleteGrokBotAgent", { id: bot.id }, { idempotent: true, timeoutMs: 60_000 });
      } catch (err) {
        if (backendCode(err) !== "not_found") throw new GrokError(err instanceof GrokError ? err.code : "backend", `Server delete failed (${errorText(err)}). Nothing removed from the box mirror.`);
        notes.push("the server had already deleted it");
      }
    }
    try {
      await this.t.gateway("deleteAgents", { ids: [bot.id] }, { idempotent: true });
    } catch (err) {
      if (!serverRun) throw err;
      notes.push(`box mirror not cleared (${errorText(err)}); it drops the bot when it next syncs`);
    }
    const still = (await this.list().catch(() => null))?.find((b) => b.id === bot.id);
    const tail = notes.length ? ` Note: ${notes.join("; ")}.` : "";
    if (still) return `WARNING: delete sent for "${bot.name}" (${bot.id}) but it is still listed (source: ${still.source}). Check grokbot_list_bots.${tail}`;
    return `Deleted "${bot.name}" (${bot.id})${serverRun ? " on the server and the box mirror" : ""}. Verified: no longer listed.${tail}`;
  }
}

export interface CreateInput {
  name: string;
  instructions: string;
  title?: string;
  avatarShape?: string;
  avatarColor?: string;
}

/** Validated, normalised create input: trimmed name, instructions without trailing whitespace. */
function validateCreate(input: CreateInput): CreateInput {
  if (!input.name?.trim()) throw new GrokError("invalid", "Name cannot be blank.");
  if (typeof input.instructions !== "string") throw new GrokError("invalid", "instructions must be a string.");
  const c: CreateInput = { ...input, name: input.name.trim(), instructions: cleanInstructions(input.instructions) };
  checkLengths(c);
  checkAvatar("shape", c.avatarShape);
  checkAvatar("color", c.avatarColor);
  return c;
}

/** Key for the instructions in grokbot_get_bot output: personal bots no longer show this field in the app. */
export const INSTRUCTIONS_LABEL = "instructions (hidden description)";

/** The grokbot_get_bot payload (also its structuredContent). Undefined fields are dropped. */
export function botFull(b: Bot): Record<string, unknown> {
  const serverRun = b.harness === "temporal";
  return JSON.parse(
    JSON.stringify({
      id: b.id,
      name: b.name,
      title: b.title,
      kind: b.isGroup ? "group" : "bot",
      ...(b.isGroup ? { memberIds: b.memberIds } : {}),
      avatarShape: b.avatarShape,
      avatarColor: b.avatarColor,
      notifyOnUpdates: b.notifyOnUpdates,
      hiddenFromSidebar: b.hiddenFromSidebar,
      harness: b.harness,
      origin: b.origin,
      source: b.source,
      mirrorInSync: serverRun ? b.mirrorInSync : undefined,
      createdAt: b.createdAt,
      serverUpdatedAt: b.serverUpdatedAt,
      lastActivityAt: b.lastActivityAt || b.updatedAt || undefined,
      profileFile: serverRun ? `/home/box/agent-data/agents/${b.id}/profile.json (box mirror, may be stale)` : undefined,
      etag: etagOf(b),
      [INSTRUCTIONS_LABEL]: b.instructions,
    }),
  );
}

export function formatBotFull(b: Bot): string {
  return JSON.stringify(botFull(b), null, 1);
}
