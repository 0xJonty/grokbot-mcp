import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AVATAR_COLORS, AVATAR_SHAPES, Bots, botFull, formatBotFull, resolveBot, type Editable } from "./bots.ts";
import { errorText } from "./errors.ts";
import { history, send, truncate } from "./history.ts";
import { log } from "./log.ts";
import { status } from "./status.ts";
import { timeZone } from "./time.ts";
import type { Transport } from "./transport.ts";
import { usage } from "./usage.ts";

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Output = string | { text: string; structured: Record<string, unknown> };

const ok = (out: Output): Result =>
  typeof out === "string" ? { content: [{ type: "text", text: out }] } : { content: [{ type: "text", text: out.text }], structuredContent: out.structured };

async function run(name: string, fn: () => Promise<Output>): Promise<Result> {
  const t0 = Date.now();
  try {
    const out = await fn();
    log("info", `${name} ok ${Date.now() - t0}ms`);
    return ok(out);
  } catch (err) {
    const msg = errorText(err);
    log("warn", `${name} failed ${Date.now() - t0}ms: ${msg}`);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

// Bounds are generous sanity limits (the app publishes none); bots.ts does the semantic checks.
const bot = z.string().min(1).max(200).describe("Bot id or exact name");
const confirm = z.boolean().default(false).describe("false = preview only; true = write");
const shape = z.enum(AVATAR_SHAPES).optional();
const color = z.enum(AVATAR_COLORS).optional();
const name = z.string().min(1).max(200);
const title = z.string().max(200).describe("Subtitle shown under the name");
const instructions = z.string().max(200_000).describe("The bot's system instructions");

// Shape of grokbot_get_bot's structuredContent (mirrors botFull in bots.ts).
const botOutput = {
  id: z.string(),
  name: z.string(),
  title: z.string(),
  kind: z.enum(["bot", "group"]),
  memberIds: z.array(z.string()).optional(),
  avatarShape: z.string(),
  avatarColor: z.string(),
  notifyOnUpdates: z.boolean(),
  hiddenFromSidebar: z.boolean(),
  harness: z.string().optional(),
  origin: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  etag: z.string(),
  instructions: z.string(),
};

/** Sent once at initialize; clients may add it to the model's context. Keep it short. */
export const SERVER_INSTRUCTIONS =
  "Manages the user's Grok Bots. Address a bot by id or exact name. " +
  "create_bot and update_bot are two-step: call with confirm=false to preview, show the user, then confirm=true. " +
  "update_bot needs the etag from a fresh grokbot_get_bot. " +
  "grokbot_send is never retried automatically: if delivery is unknown, check grokbot_history before sending again. " +
  "There is no delete or approval tool; those are done in the Grok Bot app.";

export function registerTools(server: McpServer, t: Transport, version: string): void {
  const bots = new Bots(t);
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "grokbot_status",
    { title: "Grok Bot status", description: "Grok Bot health: app, sign-in, box awake/asleep.", inputSchema: {}, annotations: ro },
    () => run("status", () => status(t, version)),
  );

  server.registerTool(
    "grokbot_list_bots",
    { title: "List bots", description: "List Grok bots (id, name, instructions preview).", inputSchema: { query: z.string().max(200).optional().describe("Filter by name/instructions substring") }, annotations: ro },
    ({ query }) =>
      run("list_bots", async () => {
        let list = await bots.list();
        const q = query?.trim().toLowerCase();
        if (q) list = list.filter((b) => b.name.toLowerCase().includes(q) || b.instructions.toLowerCase().includes(q));
        if (!list.length) return q ? `No bots match "${query}".` : "No bots.";
        return list
          .map((b) => {
            const preview = b.instructions.replace(/\s+/g, " ").trim();
            const flags = [b.isGroup ? "group" : null, b.isRunningTurn ? "working" : null, b.unreadCount ? `${b.unreadCount} unread` : null, b.awaitingUserResponse ? "awaiting you" : null].filter(Boolean).join(", ");
            return `${b.name} | ${b.id}${flags ? ` | ${flags}` : ""} | ${preview ? truncate(preview, 80) : "(no instructions)"}`;
          })
          .join("\n");
      }),
  );

  server.registerTool(
    "grokbot_get_bot",
    { title: "Get bot", description: "Full bot config incl. instructions and etag (needed for update).", inputSchema: { bot }, outputSchema: botOutput, annotations: ro },
    ({ bot: ref }) =>
      run("get_bot", async () => {
        const b = resolveBot(await bots.list(), ref);
        return { text: formatBotFull(b), structured: botFull(b) };
      }),
  );

  server.registerTool(
    "grokbot_create_bot",
    {
      title: "Create bot",
      description: "Create a bot. confirm=false (default) previews only.",
      inputSchema: {
        name: name.describe("Unique bot name"),
        instructions,
        title: title.optional(),
        avatarShape: shape,
        avatarColor: color,
        confirm,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    (a) =>
      run("create_bot", async () => {
        const input = { name: a.name, instructions: a.instructions, title: a.title, avatarShape: a.avatarShape, avatarColor: a.avatarColor };
        if (!a.confirm) return bots.previewCreate(input);
        const r = await bots.create(input);
        const note = r.listed ? "" : " Not in the bot list yet; it may take a moment to appear.";
        return `Created "${r.bot.name}" (${r.bot.id}).${r.verified ? " Verified." : " WARNING: could not verify fields; check grokbot_get_bot."}${note} etag: ${r.etag}`;
      }),
  );

  server.registerTool(
    "grokbot_update_bot",
    {
      title: "Update bot",
      description: "Edit bot fields. Needs etag from grokbot_get_bot. confirm=false (default) shows a diff only.",
      inputSchema: {
        bot,
        etag: z.string().min(1).max(128).describe("From grokbot_get_bot; rejects the edit if the bot changed since"),
        name: name.optional(),
        instructions: instructions.optional(),
        title: title.optional(),
        avatarShape: shape,
        avatarColor: color,
        notifyOnUpdates: z.boolean().optional(),
        hiddenFromSidebar: z.boolean().optional(),
        confirm,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (a) =>
      run("update_bot", async () => {
        const patch: Partial<Editable> = {
          name: a.name,
          instructions: a.instructions,
          title: a.title,
          avatarShape: a.avatarShape,
          avatarColor: a.avatarColor,
          notifyOnUpdates: a.notifyOnUpdates,
          hiddenFromSidebar: a.hiddenFromSidebar,
        };
        return bots.update(a.bot, patch, a.etag, a.confirm);
      }),
  );

  server.registerTool(
    "grokbot_history",
    {
      title: "Bot chat history",
      description: "Bot chat history, newest last. Cursors: before/after = entry # from a previous result.",
      inputSchema: {
        bot,
        limit: z.number().int().min(1).max(100).default(20).describe("Max entries"),
        before: z.number().int().min(0).optional().describe("Entries older than this #"),
        after: z.number().int().min(0).optional().describe("Entries newer than this #"),
        full: z.boolean().default(false).describe("Untruncated text"),
      },
      annotations: ro,
    },
    (a) => run("history", () => history(t, bots, a.bot, { limit: a.limit, before: a.before, after: a.after, full: a.full })),
  );

  server.registerTool(
    "grokbot_send",
    {
      title: "Send message",
      description: "Send a message to a bot. Returns a delivery receipt; never auto-resent.",
      inputSchema: { bot, message: z.string().min(1).max(100_000).refine((m) => m.trim().length > 0, "Message is empty").describe("Message text") },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      run("send", async () => {
        const r = await send(t, bots, a.bot, a.message);
        const id = r.entryId ? `entry ${r.entryId}${r.seq !== undefined ? ` (#${r.seq})` : ""}` : "entry id not yet visible";
        const after = r.seq !== undefined ? ` after=${r.seq}` : "";
        if (r.delivery === "accepted") return `Delivered to "${r.bot}" at ${r.sentAt} ${timeZone()} — ${id}. Read replies with grokbot_history${after}.`;
        if (r.delivery === "pending") return `Accepted by the server for "${r.bot}" at ${r.sentAt} ${timeZone()}, still pending (${id}). Check grokbot_history${after}; do not resend.`;
        return `Sent to "${r.bot}" at ${r.sentAt} ${timeZone()} but receipt not confirmed (${id}). Check grokbot_history before resending.`;
      }),
  );

  server.registerTool(
    "grokbot_usage",
    { title: "Grok usage", description: "Grok usage used/limit and reset time.", inputSchema: {}, annotations: ro },
    () => run("usage", () => usage(t, bots)),
  );
}
