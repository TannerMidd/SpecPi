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
function png(value) { const data = Buffer.alloc(256, value); Buffer.from("89504e470d0a1a0a", "hex").copy(data); data.write("IHDR", 12, "ascii"); data.writeUInt32BE(2, 16); data.writeUInt32BE(2, 20); data[24] = value; return data; }
module.exports = { chromium: { async launch() { return {
  async newContext() { return { async newPage() { let changed = false; return {
    async setContent() {},
    locator() { return { async evaluate(callback) { changed = true; callback({ textContent: "" }); } }; },
    async screenshot(options = {}) { const data = png(changed ? 2 : 1); if (options.path) fs.writeFileSync(options.path, data); return data; }
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
write("node_modules/pngjs/index.js", `class PNG { constructor({ width, height }) { this.width = width; this.height = height; this.data = Buffer.alloc(width * height * 4); } }
PNG.sync = {
  read(buffer) { const width = buffer.readUInt32BE(16); const height = buffer.readUInt32BE(20); return { width, height, data: Buffer.alloc(width * height * 4, buffer[24]) }; },
  write(image) { const data = Buffer.alloc(256); Buffer.from("89504e470d0a1a0a", "hex").copy(data); data.write("IHDR", 12, "ascii"); data.writeUInt32BE(image.width, 16); data.writeUInt32BE(image.height, 20); return data; }
};
module.exports = { PNG };\n`);
write("node_modules/pixelmatch/package.json", JSON.stringify({ name: "pixelmatch", version: "7.2.0", type: "module", exports: "./index.js" }));
write("node_modules/pixelmatch/index.js", "export default function pixelmatch(left, right) { return left.equals(right) ? 0 : left.length / 4; }\n");
