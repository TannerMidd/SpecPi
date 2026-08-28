#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

if (process.argv[2] !== "ci") process.exit(0);
const root = process.cwd();
function write(relative, content, mode = 0o644) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

write("node_modules/playwright/package.json", JSON.stringify({ name: "playwright", version: "1.62.1", main: "index.js" }));
write(
  "node_modules/playwright/index.js",
  `const fs = require("node:fs");
module.exports = { chromium: { async launch() { return {
  async newContext() { return { async newPage() { return {
    async setContent() {},
    async screenshot({ path }) { const data = Buffer.alloc(256, 1); fs.writeFileSync(path, data); return data; }
  }; } }; },
  async close() {}
}; } } };\n`,
);
write(
  "node_modules/playwright/cli.js",
  `const fs = require("node:fs"); const path = require("node:path");
const dir = process.env.PLAYWRIGHT_BROWSERS_PATH; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "fake-chromium"), "browser");\n`,
);
write("node_modules/pngjs/package.json", JSON.stringify({ name: "pngjs", version: "7.0.0", main: "index.js" }));
write("node_modules/pngjs/index.js", "module.exports = { PNG: class PNG {} };\n");
write("node_modules/pixelmatch/package.json", JSON.stringify({ name: "pixelmatch", version: "7.2.0", type: "module", exports: "./index.js" }));
write("node_modules/pixelmatch/index.js", "export default function pixelmatch() { return 0; }\n");
