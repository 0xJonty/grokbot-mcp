import crypto from "node:crypto";
import { GrokError } from "./errors.ts";
import { unifiedDiff } from "./diff.ts";
import type { Transport } from "./transport.ts";

export const AVATAR_SHAPES = ["blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder", "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf"] as const;
export const AVATAR_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const;

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
  updatedAt?: number;
  lastActivityAt?: number;
  isRunningTurn?: boolean;
  unreadCount?: number;
  awaitingUserResponse?: boolean;
  lastMessagePreview?: string;
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
    harness: typeof a.harness === "string" ? a.harness : undefined,
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

function checkAvatar(kind: "shape" | "color", v: string | undefined): void {
  if (v === undefined || v === "") return;
  const allowed: readonly string[] = kind === "shape" ? AVATAR_SHAPES : AVATAR_COLORS;
  if (!allowed.includes(v)) throw new GrokError("invalid", `Unknown avatar ${kind} "${v}". Use one of: ${allowed.join(" ")}`);
}

export class Bots {
  private t: Transport;
  /** Last successful list (used for name lookups by usage without waking the box). */
  cache: { at: number; bots: Bot[] } | null = null;

  constructor(t: Transport) {
    this.t = t;
  }

  async list(): Promise<Bot[]> {
    const data = await this.t.gateway("listAgents", {}, { idempotent: true });
    const raw = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : [];
    const bots = raw.map(toBot).filter((b: Bot | null): b is Bot => !!b);
    this.cache = { at: Date.now(), bots };
    return bots;
  }

  async resolve(ref: string): Promise<Bot> {
    return resolveBot(await this.list(), ref);
  }

  // ------------------------------------------------------------- create

  previewCreate(input: CreateInput): string {
    validateCreate(input);
    return [
      "PREVIEW — nothing created. Call again with confirm=true to create.",
      `name: ${input.name.trim()}`,
      input.title ? `title: ${input.title}` : null,
      input.avatarShape ? `avatarShape: ${input.avatarShape}` : null,
      input.avatarColor ? `avatarColor: ${input.avatarColor}` : null,
      `instructions (${input.instructions.length} chars):`,
      input.instructions,
    ].filter((l) => l !== null).join("\n");
  }

  async create(input: CreateInput): Promise<{ bot: Bot; verified: boolean; etag: string }> {
    validateCreate(input);
    const existing = await this.list();
    if (existing.some((b) => b.name.trim().toLowerCase() === input.name.trim().toLowerCase())) {
      throw new GrokError("invalid", `A bot named "${input.name.trim()}" already exists. Pick another name or update that bot.`);
    }
    const body: Record<string, unknown> = {
      name: input.name.trim(),
      description: input.instructions,
      title: input.title ?? "",
      avatarShape: input.avatarShape ?? "",
      avatarColor: input.avatarColor ?? "",
      origin: "user",
      clientNonce: crypto.randomUUID(),
    };
    let data: any;
    try {
      data = await this.t.gateway("createAgent", body, { idempotent: false });
    } catch (err) {
      if (err instanceof GrokError && err.code === "delivery_unknown") {
        throw new GrokError("delivery_unknown", "Create outcome unknown. Run grokbot_list_bots to check whether it exists before retrying.");
      }
      throw err;
    }
    const created = toBot(data?.agent ?? data);
    const fresh = await this.list().catch(() => null);
    const found = fresh?.find((b) => (created ? b.id === created.id : b.name === body.name)) ?? null;
    const bot = found ?? created;
    if (!bot) throw new GrokError("gateway", "createAgent returned no bot. Run grokbot_list_bots to check.");
    const verified = !!found && found.name === body.name && found.instructions === input.instructions;
    return { bot, verified, etag: etagOf(bot) };
  }

  // ------------------------------------------------------------- update

  async update(ref: string, patch: Partial<Editable>, etag: string, confirm: boolean): Promise<string> {
    if (!etag) throw new GrokError("invalid", "etag is required; get it from grokbot_get_bot.");
    const keys = EDITABLE_KEYS.filter((k) => patch[k] !== undefined);
    if (keys.length === 0) throw new GrokError("invalid", "Nothing to update: pass at least one field.");
    if (patch.name !== undefined && !patch.name.trim()) throw new GrokError("invalid", "Name cannot be blank.");
    checkAvatar("shape", patch.avatarShape);
    checkAvatar("color", patch.avatarColor);
    const bot = await this.resolve(ref);
    const current = editable(bot);
    const liveTag = etagOf(current);
    if (liveTag !== etag) {
      throw new GrokError("stale", `Bot "${bot.name}" changed since your grokbot_get_bot (etag ${etag} ≠ live ${liveTag}). Re-read it and redo the edit.`);
    }
    const next: Editable = { ...current };
    for (const k of keys) (next as any)[k] = k === "name" ? String(patch.name).trim() : patch[k];
    const changed = EDITABLE_KEYS.filter((k) => next[k] !== current[k]);
    if (changed.length === 0) return `No changes: "${bot.name}" already has those values. etag: ${liveTag}`;

    if (!confirm) {
      const parts = [`PREVIEW for "${bot.name}" (${bot.id}) — nothing written. Call again with confirm=true and etag=${etag} to apply.`];
      for (const k of changed) {
        if (k === "instructions") parts.push(unifiedDiff("instructions", current.instructions, next.instructions));
        else parts.push(`${k}: ${JSON.stringify(current[k])} -> ${JSON.stringify(next[k])}`);
      }
      return parts.join("\n");
    }

    const profileKeys = changed.filter((k) => ["name", "instructions", "title", "avatarShape", "avatarColor"].includes(k));
    if (profileKeys.length) {
      const profile: Record<string, string> = { name: next.name, description: next.instructions };
      if (changed.includes("title")) profile.title = next.title;
      if (changed.includes("avatarShape")) profile.avatarShape = next.avatarShape;
      if (changed.includes("avatarColor")) profile.avatarColor = next.avatarColor;
      await this.t.gateway("updateAgent", { id: bot.id, profile }, { idempotent: true });
    }
    if (changed.includes("notifyOnUpdates")) {
      await this.t.gateway("setAgentNotifyOnUpdates", { id: bot.id, isEnabled: next.notifyOnUpdates }, { idempotent: true });
    }
    if (changed.includes("hiddenFromSidebar")) {
      await this.t.gateway("setAgentHiddenFromSidebar", { id: bot.id, isHidden: next.hiddenFromSidebar }, { idempotent: true });
    }
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
}

export interface CreateInput {
  name: string;
  instructions: string;
  title?: string;
  avatarShape?: string;
  avatarColor?: string;
}

function validateCreate(input: CreateInput) {
  if (!input.name?.trim()) throw new GrokError("invalid", "Name cannot be blank.");
  if (typeof input.instructions !== "string") throw new GrokError("invalid", "instructions must be a string.");
  checkAvatar("shape", input.avatarShape);
  checkAvatar("color", input.avatarColor);
}

export function formatBotFull(b: Bot): string {
  return JSON.stringify(
    {
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
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      etag: etagOf(b),
      instructions: b.instructions,
    },
    null,
    1,
  );
}
