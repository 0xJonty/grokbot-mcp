// Bundle src/index.ts into a single self-contained ESM file: dist/grokbot-mcp.mjs
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/grokbot-mcp.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Keep identifiers readable for stack traces; drop whitespace to cut load time.
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: "none",
  define: { __VERSION__: JSON.stringify(pkg.version) },
  banner: {
    // Some CJS deps call require(); give the ESM bundle one.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
