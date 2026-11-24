import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AVATAR_COLORS, AVATAR_SHAPES, Bots, INSTRUCTIONS_LABEL, MAX_INSTRUCTIONS, MAX_NAME, botFull, formatBotFull, resolveBot, type Editable } from "./bots.ts";
import { errorText } from "./errors.ts";
import { history, send, truncate } from "./history.ts";
import { log } from "./log.ts";
import { routines } from "./routines.ts";
import { status } from "./status.ts";
import { timeZone } from "./time.ts";
import type { Transport } from "./transport.ts";
import { usage } from "./usage.ts";
import { WAIT_DEFAULT_SEC, waitBudgetMs, waitFor } from "./wait.ts";

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

// Name/title match the app's 255-char cap. Instructions get a generous sanity bound here; bots.ts enforces the
// app's 20,000-char cap after stripping trailing whitespace, with a clearer message.
const bot = z.string().min(1).max(MAX_NAME).describe("Bot id or exact name");
const confirm = z.boolean().default(false).describe("false = preview only; true = write");
const shape = z.enum(AVATAR_SHAPES).optional();
const color = z.enum(AVATAR_COLORS).optional();
const name = z.string().min(1).max(MAX_NAME);
const title = z.string().max(MAX_NAME).describe("Subtitle under the name (box-run bots only)");
const waitSec = z.number().int().min(0).max(3600).default(0).describe("After sending, wait up to this many seconds for the reply (0 = don't wait)");
const instructions = z.string().max(200_000).describe(`Bot instructions (hidden description), max ${MAX_INSTRUCTIONS} chars`);

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
  source: z.string().optional(),
  mirrorInSync: z.boolean().optional(),
  createdAt: z.number().optional(),
  serverUpdatedAt: z.number().optional(),
  lastActivityAt: z.number().optional(),
  profileFile: z.string().optional(),
  etag: z.string(),
  [INSTRUCTIONS_LABEL]: z.string(),
};

/** Sent once at initialize; clients may add it to the model's context. Keep it short. */
export const SERVER_INSTRUCTIONS =
  "Manages the user's Grok Bots. Address a bot by id or exact name. " +
  "create_bot and update_bot are two-step: call with confirm=false to preview, show the user, then confirm=true. " +
  "update_bot needs the etag from a fresh grokbot_get_bot. " +
  "grokbot_send is never retried automatically: if delivery is unknown, check grokbot_history before sending again. " +
  "To get a bot's reply, call grokbot_wait (it returns the moment the bot finishes) instead of sleeping and polling history. " +
  "delete_bot also needs confirmName = the exact bot name. " +
  "There is no tool for approvals, memory or routine edits: do those through the bot or the Grok Bot app.";

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
            const flags = [
              b.isGroup ? "group" : null,
              b.isRunningTurn ? "working" : null,
              b.unreadCount ? `${b.unreadCount} unread` : null,
              b.awaitingUserResponse ? "awaiting you" : null,
              b.source?.startsWith("box-mirror") ? b.source : null,
            ].filter(Boolean).join(", ");
            return `${b.name} | ${b.id}${flags ? ` | ${flags}` : ""} | ${preview ? truncate(preview, 80) : "(no instructions)"}`;
          })
          .join("\n");
      }),
  );

  server.registerTool(
    "grokbot_get_bot",
    { title: "Get bot", description: "Full bot config incl. instructions (hidden description) and etag (needed for update).", inputSchema: { bot }, outputSchema: botOutput, annotations: ro },
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
        if (!a.confirm) return await bots.previewCreate(input);
        const r = await bots.create(input);
        const note = r.listed ? "" : " Not in the bot list yet; it may take a moment to appear.";
        return `Created "${r.bot.name}" (${r.bot.id}).${r.verified ? " Verified." : " WARNING: could not verify fields; check grokbot_get_bot."}${note} etag: ${r.etag}`;
      }),
  );

  server.registerTool(
    "grokbot_update_bot",
    {
      title: "Update bot",
      description: "Edit bot fields. Needs etag from grokbot_get_bot. confirm=false (default) shows a diff only. Server-run bots are written via an internal app endpoint that may change.",
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
    "grokbot_delete_bot",
    {
      title: "Delete bot",
      description: "Permanently delete a bot. confirm=false (default) previews; confirm=true also needs confirmName.",
      inputSchema: {
        bot,
        confirmName: z.string().max(MAX_NAME).optional().describe("The bot's exact name; required with confirm=true"),
        confirm,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (a) => run("delete_bot", () => bots.delete(a.bot, a.confirm, a.confirmName)),
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
    "grokbot_routines",
    {
      title: "Bot routines",
      description: "A bot's routines: schedule, next run, prompt, last 5 runs. Read-only.",
      inputSchema: { bot, full: z.boolean().default(false).describe("Untruncated routine prompts") },
      annotations: ro,
    },
    (a) => run("routines", () => routines(t, bots, a.bot, { full: a.full })),
  );

  server.registerTool(
    "grokbot_send",
    {
      title: "Send message",
      description: "Send a message to a bot. Returns a delivery receipt; never auto-resent. waitSec>0 also waits for the reply.",
      inputSchema: {
        bot,
        message: z.string().min(1).max(100_000).refine((m) => m.trim().length > 0, "Message is empty").describe("Message text"),
        waitSec,
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a, extra) =>
      run("send", async () => {
        const t0 = t.clock();
        const r = await send(t, bots, a.bot, a.message);
        const id = r.entryId ? `entry ${r.entryId}${r.seq !== undefined ? ` (#${r.seq})` : ""}` : "entry id not yet visible";
        const after = r.seq !== undefined ? ` after=${r.seq}` : "";
        let text: string;
        if (r.delivery === "accepted") text = `Delivered to "${r.bot}" at ${r.sentAt} ${timeZone()} — ${id}. Get the reply with grokbot_wait${after}.`;
        else if (r.delivery === "pending") text = `Accepted by the server for "${r.bot}" at ${r.sentAt} ${timeZone()}, still pending (${id}). Get the reply with grokbot_wait${after}; do not resend.`;
        else return `Sent to "${r.bot}" at ${r.sentAt} ${timeZone()} but receipt not confirmed (${id}). Check grokbot_history before resending.`;
        if (!a.waitSec) return text;
        // The wait shares the call's budget with the send. A wait failure never hides the receipt.
        const left = Math.floor((waitBudgetMs(a.waitSec) - (t.clock() - t0)) / 1000);
        if (left < 1) return `${text}\nNo time left to wait in this call.`;
        try {
          return `${text}\n\n${await waitFor(t, bots, r.botId, { after: r.seq, timeoutSec: left, signal: extra.signal })}`;
        } catch (err) {
          return `${text}\nWait failed: ${errorText(err)} Use grokbot_wait.`;
        }
      }),
  );

  server.registerTool(
    "grokbot_wait",
    {
      title: "Wait for bot",
      description: `Block until a bot finishes its turn, then return its new messages. Returns within ${WAIT_DEFAULT_SEC}s by default; if still working, call again.`,
      inputSchema: {
        bot,
        after: z.number().int().min(0).optional().describe("Entry # to read after (from grokbot_send); default: your last send"),
        timeoutSec: z.number().int().min(1).max(3600).optional().describe(`Max seconds to block (default ${WAIT_DEFAULT_SEC}; server caps it, Claude Desktop ends calls at 60)`),
        full: z.boolean().default(false).describe("Untruncated text"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a, extra) => run("wait", () => waitFor(t, bots, a.bot, { after: a.after, timeoutSec: a.timeoutSec, full: a.full, signal: extra.signal })),
  );

  server.registerTool(
    "grokbot_usage",
    { title: "Grok usage", description: "Grok usage used/limit and reset time.", inputSchema: {}, annotations: ro },
    () => run("usage", () => usage(t, bots)),
  );
}
