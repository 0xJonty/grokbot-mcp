import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AVATAR_COLORS, AVATAR_SHAPES, Bots, formatBotFull, resolveBot, type Editable } from "./bots.ts";
import { errorText } from "./errors.ts";
import { history, send, truncate } from "./history.ts";
import { log } from "./log.ts";
import { status } from "./status.ts";
import type { Transport } from "./transport.ts";
import { usage } from "./usage.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: "text", text }] });

async function run(name: string, fn: () => Promise<string>): Promise<Result> {
  const t0 = Date.now();
  try {
    const text = await fn();
    log("info", `${name} ok ${Date.now() - t0}ms`);
    return ok(text);
  } catch (err) {
    const msg = errorText(err);
    log("warn", `${name} failed ${Date.now() - t0}ms: ${msg}`);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

const bot = z.string().describe("Bot id or exact name");
const shape = z.enum(AVATAR_SHAPES).optional();
const color = z.enum(AVATAR_COLORS).optional();

export function registerTools(server: McpServer, t: Transport, version: string): void {
  const bots = new Bots(t);
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "grokbot_status",
    { description: "Grok Bot health: app, sign-in, box awake/asleep.", inputSchema: {}, annotations: ro },
    () => run("status", () => status(t, version)),
  );

  server.registerTool(
    "grokbot_list_bots",
    { description: "List Grok bots (id, name, instructions preview).", inputSchema: { query: z.string().optional().describe("Filter by name/instructions substring") }, annotations: ro },
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
    { description: "Full bot config incl. instructions and etag (needed for update).", inputSchema: { bot }, annotations: ro },
    ({ bot: ref }) => run("get_bot", async () => formatBotFull(resolveBot(await bots.list(), ref))),
  );

  server.registerTool(
    "grokbot_create_bot",
    {
      description: "Create a bot. confirm=false (default) previews only.",
      inputSchema: {
        name: z.string(),
        instructions: z.string(),
        title: z.string().optional(),
        avatarShape: shape,
        avatarColor: color,
        confirm: z.boolean().default(false),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    (a) =>
      run("create_bot", async () => {
        const input = { name: a.name, instructions: a.instructions, title: a.title, avatarShape: a.avatarShape, avatarColor: a.avatarColor };
        if (!a.confirm) return bots.previewCreate(input);
        const r = await bots.create(input);
        return `Created "${r.bot.name}" (${r.bot.id}).${r.verified ? " Verified." : " WARNING: could not verify fields; check grokbot_get_bot."} etag: ${r.etag}`;
      }),
  );

  server.registerTool(
    "grokbot_update_bot",
    {
      description: "Edit bot fields. Needs etag from grokbot_get_bot. confirm=false (default) shows a diff only.",
      inputSchema: {
        bot,
        etag: z.string(),
        name: z.string().optional(),
        instructions: z.string().optional(),
        title: z.string().optional(),
        avatarShape: shape,
        avatarColor: color,
        notifyOnUpdates: z.boolean().optional(),
        hiddenFromSidebar: z.boolean().optional(),
        confirm: z.boolean().default(false),
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
      description: "Bot chat history, newest last. Cursors: before/after = entry # from a previous result.",
      inputSchema: {
        bot,
        limit: z.number().int().min(1).max(100).default(20),
        before: z.number().int().optional(),
        after: z.number().int().optional(),
        full: z.boolean().default(false).describe("Untruncated text"),
      },
      annotations: ro,
    },
    (a) => run("history", () => history(t, bots, a.bot, { limit: a.limit, before: a.before, after: a.after, full: a.full })),
  );

  server.registerTool(
    "grokbot_send",
    {
      description: "Send a message to a bot. Returns a delivery receipt; never auto-resent.",
      inputSchema: { bot, message: z.string() },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      run("send", async () => {
        const r = await send(t, bots, a.bot, a.message);
        const id = r.entryId ? `entry ${r.entryId}${r.seq !== undefined ? ` (#${r.seq})` : ""}` : "entry id not yet visible";
        return r.delivery === "accepted"
          ? `Delivered to "${r.bot}" at ${r.sentAt} Sydney — ${id}. Read replies with grokbot_history${r.seq !== undefined ? ` after=${r.seq}` : ""}.`
          : `Sent to "${r.bot}" at ${r.sentAt} but receipt not confirmed (${id}). Check grokbot_history before resending.`;
      }),
  );

  server.registerTool(
    "grokbot_usage",
    { description: "Grok usage used/limit and reset time.", inputSchema: {}, annotations: ro },
    () => run("usage", () => usage(t, bots)),
  );
}
