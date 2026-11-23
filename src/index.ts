import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "./log.ts";
import { AppSession } from "./session.ts";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.ts";
import { Transport } from "./transport.ts";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

// Startup does no disk or network work: AppSession/Transport are lazy.
process.on("uncaughtException", (err) => log("error", "uncaught: " + (err?.stack ?? err)));
process.on("unhandledRejection", (err: any) => log("error", "unhandled rejection: " + (err?.stack ?? err)));

const transport = new Transport({ session: new AppSession() });
const server = new McpServer({ name: "grokbot-mcp", title: "Grok Bot", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
registerTools(server, transport, VERSION);

await server.connect(new StdioServerTransport());
log("info", `grokbot-mcp ${VERSION} ready (stdio)`, { file: false });
