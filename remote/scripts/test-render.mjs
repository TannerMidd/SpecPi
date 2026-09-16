#!/usr/bin/env node
// Real browser render check.
//
// Kept out of `npm test` deliberately: this package has no runtime or test
// dependencies, and Playwright is a repository-root devDependency. Run it with
// `npm run test:render` when the client changes. The suite in tests/ stays
// dependency-free and covers the daemon.
//
// It exists because the daemon suite cannot see the DOM, and the first version
// of this client shipped with both slide-over panels stuck open: `.panel` set
// `display: flex`, which beats the user-agent's `[hidden]` rule, so the hidden
// attribute did nothing. Every assertion below is about that class of bug --
// what is actually visible on screen.

import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcBridge } from "../src/rpc-bridge.js";
import { RemoteServer } from "../src/server.js";
import { TokenAuth } from "../src/auth.js";

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require(
        path.join(fileURLToPath(new URL("../../", import.meta.url)), "node_modules", "playwright"),
    ));
} catch {
    process.stderr.write("Playwright not found at the repository root. Run npm install there first.\n");
    process.exit(1);
}

const fixture = fileURLToPath(new URL("../tests/fixtures/fake-pi.mjs", import.meta.url));
const TOKEN = "render-check-token";

const checks = [];
function check(name, condition, detail = "") {
    checks.push({ name, ok: Boolean(condition), detail });
}

const agentDir = await mkdtemp(path.join(tmpdir(), "specpi-render-"));
const bridge = new RpcBridge({
    command: process.execPath,
    args: [fixture],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
});
const auth = new TokenAuth({ token: TOKEN });
const server = new RemoteServer({ bridge, auth, port: 0, logger: { log() {}, error() {} } });
bridge.start();
const address = await server.listen();
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
const failures = [];
try {
    for (const viewport of [
        { name: "phone", width: 390, height: 844 },
        { name: "desktop", width: 1440, height: 900 },
    ]) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        page.on("pageerror", (error) => failures.push(`${viewport.name}: page error: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() === "error") {
                failures.push(`${viewport.name}: console error: ${message.text()}`);
            }
        });

        await page.goto(`${base}/?t=${TOKEN}`, { waitUntil: "networkidle" });

        const visible = async (selector) => page.locator(selector).isVisible();

        // The exact regression: panels must start closed.
        check(`${viewport.name}: sessions panel closed on load`, !(await visible("#sessions-panel")));
        check(`${viewport.name}: usage panel closed on load`, !(await visible("#usage-panel")));
        check(`${viewport.name}: scrim hidden on load`, !(await visible("#scrim")));
        check(`${viewport.name}: extension strip hidden when empty`, !(await visible("#extensions")));
        check(`${viewport.name}: attachment strip hidden when empty`, !(await visible("#attachments")));

        // The chrome that must be reachable.
        check(`${viewport.name}: menu button visible`, await visible("#open-sessions"));
        check(`${viewport.name}: composer visible`, await visible("#input"));
        check(`${viewport.name}: send visible`, await visible("#send"));
        check(`${viewport.name}: model picker visible`, await visible("#model"));

        // Nothing may overlap the header, which is what the stuck panel did.
        const header = await page.locator(".bar").boundingBox();
        const menu = await page.locator("#open-sessions").boundingBox();
        // On a wide window the app is a centred column, so the header is not
        // viewport-wide. What matters is that it sits at the top and fills the
        // column, and that the menu is at its left edge.
        const columnWidth = Math.min(viewport.width, 880);
        check(
            `${viewport.name}: header sits at the top of the column`,
            header && header.y < 80 && header.width > columnWidth * 0.8,
            header ? `y=${Math.round(header.y)} w=${Math.round(header.width)}` : "no box",
        );
        check(
            `${viewport.name}: menu button at the header's left edge`,
            menu && header && menu.x - header.x < 80,
            menu && header ? `offset=${Math.round(menu.x - header.x)}` : "no box",
        );

        // The page must not scroll sideways at phone width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(`${viewport.name}: no horizontal overflow`, overflow <= 1, `overflow=${overflow}px`);

        // Opening and closing the drawer actually toggles it.
        await page.locator("#open-sessions").click();
        await page.waitForTimeout(150);
        check(`${viewport.name}: sessions panel opens`, await visible("#sessions-panel"));
        check(`${viewport.name}: scrim appears with the panel`, await visible("#scrim"));
        await page.locator("#close-sessions").click();
        await page.waitForTimeout(150);
        check(`${viewport.name}: sessions panel closes again`, !(await visible("#sessions-panel")));

        await page.locator("#open-usage").click();
        await page.waitForTimeout(150);
        check(`${viewport.name}: usage panel opens`, await visible("#usage-panel"));
        check(`${viewport.name}: usage panel has rows`, (await page.locator(".usage-row").count()) > 0);
        await page.locator("#close-usage").click();
        await page.waitForTimeout(150);
        check(`${viewport.name}: usage panel closes again`, !(await visible("#usage-panel")));

        // A full turn: the reply must render, and the composer must return to
        // its idle state. Both of these shipped broken -- message_end drew
        // nothing when no deltas streamed, and the optimistic running flag was
        // set after the await, so it landed after agent_settled and stuck.
        await page.locator("#input").fill("hello");
        await page.locator("#send").click();
        await page.waitForTimeout(600);
        const roles = await page.locator(".entry .role").allTextContents();
        check(`${viewport.name}: the assistant reply renders`, roles.includes("assistant"), roles.join("|"));
        check(
            `${viewport.name}: composer returns to Send once settled`,
            (await page.locator("#send").textContent()) === "Send",
        );
        check(`${viewport.name}: stop disabled once settled`, await page.locator("#stop").isDisabled());

        // An approval must render as a card with its options as real buttons.
        await page.locator("#input").fill("DIALOG:select");
        await page.locator("#send").click();
        await page.waitForTimeout(700);
        check(`${viewport.name}: approval card renders`, (await page.locator(".approval").count()) === 1);
        const options = await page.locator(".approval .actions button").allTextContents();
        check(
            `${viewport.name}: approval offers the agent's options plus Cancel`,
            options.includes("Allow") && options.includes("Block") && options.includes("Cancel"),
            options.join(","),
        );

        await page.screenshot({ path: path.join(agentDir, `${viewport.name}.png`), fullPage: false });
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
    await bridge.stop();
}

let failed = failures.length > 0;
for (const item of checks) {
    if (!item.ok) {
        failed = true;
    }

    process.stdout.write(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}\n`);
}

for (const failure of failures) {
    process.stdout.write(`FAIL  ${failure}\n`);
}

process.stdout.write(`\n${checks.filter((item) => item.ok).length}/${checks.length} checks passed.\n`);
await rm(agentDir, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
