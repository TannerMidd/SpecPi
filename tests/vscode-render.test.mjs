import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";
import { loadBrowserRuntime } from "../extensions/browser/core.mjs";

const require = createRequire(import.meta.url);
const { getWebviewHtml } = require("../vscode/src/webview.js");
const { formatPrompt } = require("../vscode/src/context.js");
const { createState, applyEvent } = require("../vscode/src/chat-state.js");
const { decodeDelegates, delegateCompletionText } = require("../vscode/src/delegates.js");
const root = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.env.SPECPI_VSCODE_BROWSER_TESTS === "1" || process.env.SPECPI_BROWSER_TESTS === "1";
const directory = path.join(root, ".specpi-test", "vscode", "render");
const screenshots = path.join(root, ".specpi-test", "vscode", "screenshots");
const submissionIds = new WeakMap();
const imagePng =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAa0lEQVR4AcXBQRUCQQxEwU+/PccNDuImJjARNyMEHWMAHPS1q17vz/eHMV04ey7OdOGIMBEmwkSYCBNhIuyZLpw9F2e6cPZcHBEmwkSYCBNhIkyEPXsuznTh7Lk404UjwkSYCBNhIkyEibA/i9gSffRPkXoAAAAASUVORK5CYII=";
const themes = {
    dark: {
        className: "vscode-dark",
        colorScheme: "dark",
        surface: "#181818",
        editor: "#1f1f1f",
        foreground: "#cccccc",
        muted: "#9d9d9d",
        border: "#454545",
        accent: "#4daafc",
        button: "#0078d4",
        buttonForeground: "#ffffff",
    },
    light: {
        className: "vscode-light",
        colorScheme: "light",
        surface: "#f8f8f8",
        editor: "#ffffff",
        foreground: "#333333",
        muted: "#616161",
        border: "#cecece",
        accent: "#005fb8",
        button: "#005fb8",
        buttonForeground: "#ffffff",
    },
    highcontrast: {
        className: "vscode-high-contrast",
        colorScheme: "dark",
        surface: "#000000",
        editor: "#000000",
        foreground: "#ffffff",
        muted: "#ffffff",
        border: "#6fc3df",
        accent: "#21a6ff",
        button: "#000000",
        buttonForeground: "#ffffff",
    },
};

function readyState(overrides = {}) {
    return {
        status: "ready",
        workspace: { name: "sidebar-fixture", path: "/synthetic/sidebar-fixture" },
        title: "A deliberate change",
        messages: [],
        attachments: [],
        models: [
            { provider: "fixture", id: "reasoning-model", name: "Fixture Reasoning" },
            { provider: "fixture", id: "fast-model", name: "Fixture Fast" },
        ],
        model: { provider: "fixture", id: "reasoning-model", name: "Fixture Reasoning" },
        thinkingLevels: ["off", "low", "medium", "high"],
        thinkingLevel: "medium",
        commands: [
            { name: "plan", description: "Plan a concrete change" },
            { name: "review", description: "Review the current diff" },
        ],
        tokens: { total: 1240 },
        cost: 0.01234,
        contextToken: "fixture-context-1",
        ...overrides,
    };
}

function sampleDelegates() {
    return decodeDelegates([
        JSON.stringify({
            version: 1,
            enabled: true,
            active: 1,
            concurrency: 2,
            calls: 3,
            callLimit: 256,
            jobs: [
                {
                    id: "review-api",
                    batchId: "batch-1",
                    attemptId: "attempt-1",
                    mode: "review",
                    state: "running",
                    settling: true,
                    calls: 2,
                    tools: 4,
                    elapsedMs: 65000,
                    disposition: null,
                    task: "Review the API changes and report concrete defects with source evidence.",
                    provider: "fixture",
                    model: "Fixture Reasoning",
                    error: null,
                },
                {
                    id: "review-tests",
                    batchId: "batch-1",
                    attemptId: "attempt-2",
                    mode: "review",
                    state: "complete",
                    settling: false,
                    calls: 1,
                    tools: 2,
                    elapsedMs: 32000,
                    disposition: null,
                    task: "Check the regression tests without changing files.",
                    provider: "fixture",
                    model: "Fixture Reasoning",
                    error: null,
                },
            ],
        }),
    ]);
}

function sampleMessages() {
    return [
        { id: "user-1", role: "user", text: "Help me improve the sidebar while preserving the workspace safeguards." },
        {
            id: "assistant-1",
            role: "assistant",
            text: '## A small, testable change\n\nThe sidebar can keep **your context** visible while a reply streams.\n\n- [x] Inspect the current behavior\n- [ ] Verify narrow layouts\n\n```js\nconst status = "Ready when you are";\n```\n\n| Check | Result |\n| --- | --- |\n| Keyboard | Ready |\n\n[Read the plan](https://example.invalid/plan)',
            thinking: "I will inspect the behavior before proposing the smallest useful change.",
        },
        {
            id: "tool-1",
            role: "tool",
            toolName: "read",
            input: '{ "path": "src/sidebar.js" }',
            text: "Synthetic fixture output: sidebar entry point found.",
            isRunning: false,
        },
    ];
}

function sampleHistory() {
    const now = Date.now();

    return [
        { id: "history-a", title: "Improve the conversation picker", updatedAt: now, status: "busy", isActive: true },
        { id: "history-b", title: "Review workspace changes", updatedAt: now - 4 * 3600000, status: "needs-input" },
        {
            id: "history-c",
            title: "Trace startup behavior",
            updatedAt: now - 28 * 3600000,
            status: "ready",
            unread: true,
        },
        { id: "history-d", title: "Plan image support", updatedAt: now - 3 * 86400000, status: "saved" },
        {
            id: "history-e",
            title: "Archived investigation",
            updatedAt: now - 9 * 86400000,
            status: "saved",
            archived: true,
        },
    ];
}

function imageFixture(overrides = {}) {
    return {
        data: imagePng,
        mimeType: "image/png",
        width: 32,
        height: 24,
        byteLength: Buffer.from(imagePng, "base64").length,
        name: "synthetic-image.png",
        ...overrides,
    };
}

function imageAttachment(overrides = {}) {
    return {
        ...imageFixture(),
        id: "image-1",
        kind: "image",
        label: "Synthetic image",
        detail: "32 × 24 · synthetic fixture",
        ...overrides,
    };
}

function paddedPng(byteLength) {
    const original = Buffer.from(imagePng, "base64");
    const dataLength = byteLength - original.length - 12;
    const chunk = Buffer.alloc(dataLength + 12, 97);
    chunk.writeUInt32BE(dataLength, 0);
    chunk.write("tEXt", 4, "ascii");
    chunk.write("fixture\0", 8, "ascii");
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);

    return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]).toString("base64");
}

function visionModel(input = ["text", "image"]) {
    return { provider: "fixture", id: "vision-model", name: "Fixture Vision", input };
}

async function assertImageLoaded(locator) {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate((image) => image.decode());
    assert.deepEqual(await locator.evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight })), {
        width: 32,
        height: 24,
    });
    assert.match(await locator.getAttribute("src"), /^data:image\/png;base64,/u);
}

async function imageMessage(page, type) {
    await page.waitForFunction((type) => window.specpiFixtureMessages.some((message) => message.type === type), type);
    const messages = await takeMessages(page);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, type);
    assert.equal(typeof messages[0].requestId, "string");
    assert.ok(messages[0].requestId.length > 0);

    return messages[0];
}

async function writeFixture(themeName) {
    const theme = themes[themeName];
    const stylePath = path.join(directory, `${themeName}.css`);
    const productionStyle = pathToFileURL(path.join(root, "vscode", "media", "chat.css")).href;
    await fs.writeFile(
        stylePath,
        `@import url("${productionStyle}");
:root {
    --vscode-sideBar-background: ${theme.surface};
    --vscode-editor-background: ${theme.editor};
    --vscode-input-background: ${theme.editor};
    --vscode-foreground: ${theme.foreground};
    --vscode-input-foreground: ${theme.foreground};
    --vscode-descriptionForeground: ${theme.muted};
    --vscode-widget-border: ${theme.border};
    --vscode-contrastBorder: ${theme.border};
    --vscode-textLink-foreground: ${theme.accent};
    --vscode-focusBorder: ${theme.accent};
    --vscode-button-background: ${theme.button};
    --vscode-button-foreground: ${theme.buttonForeground};
    --vscode-font-family: system-ui, sans-serif;
    --vscode-font-size: 13px;
}
`,
        "utf8",
    );
    const html = getWebviewHtml({
        cspSource: "file:",
        scriptUri: pathToFileURL(path.join(root, "vscode", "media", "chat.js")).href,
        styleUri: pathToFileURL(stylePath).href,
        extrasScriptUri: pathToFileURL(path.join(root, "vscode", "media", "chat-extras.js")).href,
        extrasStyleUri: pathToFileURL(path.join(root, "vscode", "media", "chat-extras.css")).href,
        historyScriptUri: pathToFileURL(path.join(root, "vscode", "media", "chat-picker.js")).href,
        historyStyleUri: pathToFileURL(path.join(root, "vscode", "media", "chat-picker.css")).href,
        nonce: "specpi-render-fixture-37064d6a9f204b48",
    }).replace("<body>", `<body class="${theme.className}">`);
    const htmlPath = path.join(directory, `${themeName}.html`);
    await fs.writeFile(htmlPath, html, "utf8");

    return pathToFileURL(htmlPath).href;
}

async function sendHost(page, message) {
    await page.evaluate((value) => window.postMessage(value, "*"), message);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setState(page, overrides = {}) {
    await sendHost(page, { type: "state", state: readyState(overrides) });
}

async function takeMessages(page, { acknowledgeSends = true } = {}) {
    const messages = await page.evaluate(() => window.specpiFixtureMessages.splice(0));
    for (const message of messages) {
        if (message.type === "send") {
            assert.equal(typeof message.requestId, "string", "Every submission needs a host acknowledgment identifier");
            assert.ok(message.requestId.length > 0);
            const seen = submissionIds.get(page) || new Set();
            assert.equal(seen.has(message.requestId), false, "Submission identifiers must not be reused");
            seen.add(message.requestId);
            submissionIds.set(page, seen);
            if (acknowledgeSends) {
                await sendHost(page, { type: "sendResult", requestId: message.requestId, accepted: true });
                delete message.requestId;
            }
        }
    }

    return messages;
}

async function transferFiles(page, method, files, uriList = "", extraData = {}) {
    return page.evaluate(
        ({ method, files, uriList, extraData, imagePng }) => {
            const transfer = new DataTransfer();
            for (const specification of files) {
                const bytes = Uint8Array.from(atob(imagePng), (character) => character.charCodeAt(0));
                const contents = specification.size === undefined ? bytes : new Uint8Array(specification.size);
                if (specification.size !== undefined) {
                    contents.set(bytes.subarray(0, Math.min(bytes.length, contents.length)));
                }

                transfer.items.add(
                    new File([contents], specification.name || "synthetic-image.png", {
                        type: specification.type || "image/png",
                    }),
                );
            }

            if (uriList) {
                transfer.setData("text/uri-list", uriList);
            }

            for (const [type, value] of Object.entries(extraData)) {
                transfer.setData(type, value);
            }

            const event =
                method === "paste"
                    ? new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })
                    : new DragEvent(method, { bubbles: true, cancelable: true, dataTransfer: transfer });
            document.getElementById("composer-input").dispatchEvent(event);

            return event.defaultPrevented;
        },
        { method, files, uriList, extraData, imagePng },
    );
}

async function composerMetrics(page) {
    return page.evaluate(() => {
        const composer = document.getElementById("composer");
        const input = document.getElementById("composer-input");

        return {
            composerHeight: composer.getBoundingClientRect().height,
            inputHeight: input.getBoundingClientRect().height,
            inputScrollHeight: input.scrollHeight,
            inputClientHeight: input.clientHeight,
            footerHeight: document.querySelector(".footer").getBoundingClientRect().height,
        };
    });
}

async function assertLayout(page, width) {
    const layout = await page.evaluate(() => {
        const app = document.querySelector(".app");
        const composer = document.getElementById("composer");
        const composerRect = composer.getBoundingClientRect();
        const input = document.getElementById("composer-input").getBoundingClientRect();
        const send = document.getElementById("send-button").getBoundingClientRect();
        const scroll = document.getElementById("scroll-area");

        return {
            documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
            appWidth: app.getBoundingClientRect().width,
            composerOverflow: composer.scrollWidth - composer.clientWidth,
            composerLeft: composerRect.left,
            composerRight: composerRect.right,
            composerBottom: composerRect.bottom,
            inputWidth: input.width,
            inputBottom: input.bottom,
            sendTop: send.top,
            sendRight: send.right,
            scrollHeight: scroll.clientHeight,
            height: window.innerHeight,
            bodyBackground: getComputedStyle(document.body).backgroundColor,
        };
    });
    assert.ok(layout.documentOverflow <= 1, `Horizontal document overflow: ${JSON.stringify(layout)}`);
    assert.equal(layout.appWidth, width);
    assert.ok(layout.composerOverflow <= 1, `Composer controls overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.composerLeft >= 0 && layout.composerRight <= width);
    assert.ok(layout.sendRight <= layout.composerRight && layout.sendTop >= layout.inputBottom);
    assert.ok(layout.composerBottom <= layout.height && layout.scrollHeight > 80);
    assert.ok(layout.inputWidth > 200);

    return layout;
}

async function withPage(browser, fixtures, options, operation) {
    const themeName = options.theme ?? "dark";
    const context = await browser.newContext({
        viewport: { width: options.width ?? 390, height: options.height ?? 900 },
        colorScheme: themes[themeName].colorScheme,
        reducedMotion: "reduce",
        serviceWorkers: "block",
    });
    const diagnostics = [];
    const unexpectedRequests = [];
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") {
            diagnostics.push(message.text());
        }
    });
    await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).protocol !== "file:") {
            unexpectedRequests.push(route.request().url());
            await route.abort();

            return;
        }

        await route.continue();
    });
    await page.addInitScript(() => {
        window.specpiFixtureMessages = [];
        window.specpiFixtureStateWrites = 0;
        window.specpiFixtureFileReads = [];
        window.specpiFixtureCompletedReads = 0;
        window.specpiFixtureHoldImageReads = false;
        window.specpiFixtureReadReleases = [];
        const NativeFileReader = window.FileReader;
        window.FileReader = class extends NativeFileReader {
            constructor() {
                super();
                this.addEventListener("loadend", () => {
                    window.specpiFixtureCompletedReads += 1;
                });
            }

            readAsDataURL(blob) {
                window.specpiFixtureFileReads.push({ size: blob.size, type: blob.type });
                if (window.specpiFixtureHoldImageReads) {
                    window.specpiFixtureReadReleases.push(() => super.readAsDataURL(blob));
                } else {
                    super.readAsDataURL(blob);
                }
            }
        };
        window.acquireVsCodeApi = () => ({
            postMessage(message) {
                window.specpiFixtureMessages.push(message);
            },
            getState() {
                return undefined;
            },
            setState() {
                window.specpiFixtureStateWrites += 1;
            },
        });
    });
    try {
        await page.goto(fixtures[themeName], { waitUntil: "load" });
        await page.waitForFunction(() => window.specpiFixtureMessages.some((message) => message.type === "ready"));
        assert.deepEqual(await takeMessages(page), [{ type: "ready" }]);
        await operation(page);
        assert.deepEqual(unexpectedRequests, [], "The rendered chat must not initiate remote requests");
        assert.deepEqual(diagnostics, [], "The real webview must run without script or CSP errors");
        assert.equal(
            await page.evaluate(() => window.specpiFixtureStateWrites),
            0,
            "Chat contents must not be persisted in webview state",
        );
    } catch (error) {
        if (diagnostics.length) {
            error.message += `\nBrowser diagnostics: ${diagnostics.join("\n")}`;
        }

        await page
            .screenshot({ path: path.join(screenshots, `${options.name}-failure.png`), timeout: 5000 })
            .catch(() => undefined);
        throw error;
    } finally {
        await context.close();
    }
}

test(
    "SpecPi Chat renders and handles real browser interactions with a local-only fixture",
    { skip: !enabled, timeout: 180000 },
    async (t) => {
        await fs.mkdir(directory, { recursive: true });
        await fs.mkdir(screenshots, { recursive: true });
        const fixtures = {};
        for (const theme of Object.keys(themes)) {
            fixtures[theme] = await writeFixture(theme);
        }

        const { playwright } = await loadBrowserRuntime(
            process.env.SPECPI_BROWSER_RUNTIME ?? path.join(root, ".specpi-test", "browser-runtime"),
        );
        const browser = await playwright.chromium.launch({ headless: true });
        try {
            for (const theme of Object.keys(themes)) {
                for (const width of [280, 390, 768, 1200]) {
                    const name = `${theme}-${width}`;
                    await t.test(`viewport ${name}: welcome, content, and composer stay usable`, async () => {
                        await withPage(browser, fixtures, { theme, width, name }, async (page) => {
                            assert.equal(await page.locator("#welcome").isVisible(), true);
                            assert.equal(await page.locator("#connection-label").textContent(), "Offline");
                            assert.equal(await page.locator("#send-button").isDisabled(), true);
                            await assertLayout(page, width);
                            await page.screenshot({ path: path.join(screenshots, `${name}-welcome.png`) });
                            await setState(page, {
                                messages: sampleMessages(),
                                attachments: [
                                    {
                                        id: "context-1",
                                        label: "sidebar.js:10–24",
                                        detail: "Synthetic editor selection",
                                    },
                                ],
                            });
                            assert.equal(await page.locator("#welcome").isVisible(), false);
                            assert.equal(await page.locator(".message").count(), 3);
                            assert.equal(await page.locator("#token-status").textContent(), "1.2k · $0.0123");
                            await page.locator("#composer-input").fill("Keep the change focused and testable.");
                            assert.equal(await page.locator("#send-button").isEnabled(), true);
                            await assertLayout(page, width);
                            await page.screenshot({ path: path.join(screenshots, `${name}-conversation.png`) });
                            const selected = Array.from({ length: 8 }, (_, index) => ({
                                label:
                                    index === 0
                                        ? `src/${"long-directory/".repeat(15)}file.js:10-24`
                                        : `src/file-${index}.js`,
                                text: "Synthetic attached source, not transcript text.\n".repeat(1000),
                            }));
                            const tagged = createState({
                                messages: [
                                    { role: "user", content: formatPrompt("Review the attached files.", selected) },
                                ],
                            }).messages;
                            await setState(page, { messages: tagged });
                            assert.equal(await page.locator(".message-files .attachment").count(), 8);
                            assert.equal(
                                await page.locator(".message-user .message-body").textContent(),
                                "Review the attached files.",
                            );
                            assert.ok(!(await page.locator("#conversation").textContent()).includes(selected[0].text));
                            assert.equal(
                                await page.locator(".message-files .attachment-label").first().textContent(),
                                selected[0].label,
                            );
                            assert.ok((await page.locator(".message-user").boundingBox()).height < 420);
                            await assertLayout(page, width);
                            await page.screenshot({ path: path.join(screenshots, `${name}-file-tags.png`) });
                            const delegation = sampleDelegates();
                            await setState(page, {
                                delegation,
                                commands: [{ name: "delegate" }],
                                messages: [
                                    ...sampleMessages(),
                                    {
                                        id: "delegate-summary",
                                        role: "notice",
                                        text: delegateCompletionText(delegation.jobs[1]),
                                    },
                                ],
                            });
                            assert.equal(await page.locator("#delegates-panel").isVisible(), true);
                            assert.equal(await page.locator(".delegate-worker").count(), 1);
                            assert.equal(await page.locator("#delegates-panel").getAttribute("open"), null);
                            assert.ok((await page.locator("#delegates-panel").boundingBox()).height <= 44);
                            assert.equal(await page.locator(".delegates-count").textContent(), "1 agent working");
                            await page.screenshot({ path: path.join(screenshots, `${name}-delegates-compact.png`) });
                            await page.locator(".delegates-header").click();
                            await assertLayout(page, width);
                            const delegatePanel = await page.locator("#delegates-panel").boundingBox();
                            assert.ok(delegatePanel.x >= 0 && delegatePanel.x + delegatePanel.width <= width);
                            await page.screenshot({ path: path.join(screenshots, `${name}-delegates.png`) });
                            await setState(page, { messages: sampleMessages(), conversations: sampleHistory() });
                            await page.locator("#history-button").click();
                            assert.equal(await page.locator("#history-panel").isVisible(), true);
                            assert.equal(await page.locator(".history-open").count(), 4);
                            assert.equal(
                                await page
                                    .locator("#history-search")
                                    .evaluate((node) => document.activeElement === node),
                                true,
                            );
                            const panel = await page.locator("#history-panel").boundingBox();
                            assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
                            assert.ok(panel.y >= 0 && panel.y + panel.height <= 900);
                            await page.screenshot({ path: path.join(screenshots, `${name}-history.png`) });
                            await page.keyboard.press("Escape");
                            assert.equal(await page.locator("#history-panel").isVisible(), false);
                            assert.equal(
                                await page
                                    .locator("#history-button")
                                    .evaluate((node) => document.activeElement === node),
                                true,
                            );
                        });
                    });
                }
            }

            await t.test(
                "history searches, renames, archives, restores and switches with keyboard access",
                async () => {
                    await withPage(browser, fixtures, { name: "history-interactions", width: 280 }, async (page) => {
                        let conversations = sampleHistory();
                        await setState(page, { conversations });
                        await page.locator("#history-button").click();
                        assert.deepEqual(await takeMessages(page), [{ type: "history" }]);
                        const search = page.locator("#history-search");
                        await search.fill("review");
                        assert.equal(await page.locator(".history-open").count(), 1);
                        await setState(page, { status: "busy", conversations });
                        assert.equal(await search.inputValue(), "review");
                        assert.equal(await search.evaluate((node) => document.activeElement === node), true);
                        const review = page.locator('.history-row[data-id="history-b"]');
                        await review.hover();
                        await review
                            .getByRole("button", { name: "Rename Review workspace changes", exact: true })
                            .click();
                        const name = page.getByRole("textbox", { name: "Conversation name", exact: true });
                        await name.fill("Review the sidebar");
                        conversations = conversations.map((item) =>
                            item.id === "history-a" ? { ...item, status: "ready", unread: true } : item,
                        );
                        await setState(page, { conversations });
                        assert.equal(await name.inputValue(), "Review the sidebar");
                        assert.equal(await name.evaluate((node) => document.activeElement === node), true);
                        await name.press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "renameConversation", id: "history-b", name: "Review the sidebar" },
                        ]);
                        await sendHost(page, {
                            type: "historyActionResult",
                            action: "renameConversation",
                            id: "history-b",
                            error: "Synthetic rename failed. Try again.",
                        });
                        assert.match(
                            await page.locator(".history-error-text").textContent(),
                            /Synthetic rename failed/u,
                        );
                        assert.equal(await name.isEnabled(), true);
                        await name.press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "renameConversation", id: "history-b", name: "Review the sidebar" },
                        ]);
                        conversations = conversations.map((item) =>
                            item.id === "history-b" ? { ...item, title: "Review the sidebar" } : item,
                        );
                        await sendHost(page, {
                            type: "historyActionResult",
                            action: "renameConversation",
                            id: "history-b",
                        });
                        await setState(page, { conversations });
                        assert.equal(await page.locator(".history-rename-input").count(), 0);
                        await review.hover();
                        await review.getByRole("button", { name: "Archive Review the sidebar", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "archiveConversation", id: "history-b", archived: true },
                        ]);
                        conversations = conversations.map((item) =>
                            item.id === "history-b" ? { ...item, archived: true } : item,
                        );
                        await setState(page, { conversations });
                        assert.equal(await page.locator(".history-open").count(), 0);
                        await page.getByRole("tab", { name: "Archived", exact: true }).click();
                        assert.equal(await page.locator(".history-open").count(), 1);
                        await review.hover();
                        await review.getByRole("button", { name: "Restore Review the sidebar", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "archiveConversation", id: "history-b", archived: false },
                        ]);
                        conversations = conversations.map((item) =>
                            item.id === "history-b" ? { ...item, archived: false } : item,
                        );
                        await setState(page, { conversations });
                        await page.getByRole("tab", { name: "Conversations", exact: true }).click();
                        await search.focus();
                        await search.press("ArrowDown");
                        assert.equal(
                            await review.locator(".history-open").evaluate((node) => document.activeElement === node),
                            true,
                        );
                        await page.keyboard.press("Enter");
                        assert.deepEqual(await takeMessages(page), [{ type: "selectConversation", id: "history-b" }]);
                        await sendHost(page, {
                            type: "historyActionResult",
                            action: "selectConversation",
                            id: "history-b",
                        });
                        assert.equal(await page.locator("#history-panel").isVisible(), false);
                        await sendHost(page, { type: "showHistory" });
                        assert.equal(await page.locator("#history-panel").isVisible(), true);
                        assert.deepEqual(await takeMessages(page), []);
                        await search.fill("does not exist");
                        assert.match(
                            await page.locator(".history-empty-title").textContent(),
                            /No matching conversations/u,
                        );
                        await page
                            .locator("#history-panel")
                            .getByRole("button", { name: "New conversation", exact: true })
                            .click();
                        assert.deepEqual(await takeMessages(page), [{ type: "newChat" }]);
                    });
                },
            );

            await t.test("conversation cost reflects Pi's aggregate and keeps usage details accessible", async () => {
                await withPage(browser, fixtures, { name: "conversation-cost", width: 280 }, async (page) => {
                    const usage = page.locator("#token-status");
                    await setState(page, {
                        tokens: { total: 1240, cost: 99 },
                        contextUsage: { percent: 12, tokens: 1200, contextWindow: 10000 },
                    });
                    assert.equal(await usage.textContent(), "12% · $0.0123");
                    assert.match(
                        await usage.getAttribute("title"),
                        /Pi-reported conversation cost \(USD\): \$0\.01234/u,
                    );
                    assert.match(await usage.getAttribute("aria-label"), /conversation cost \(USD\): \$0\.01234/u);
                    await usage.click();
                    assert.deepEqual(await takeMessages(page), [{ type: "showUsage" }]);
                    await usage.focus();
                    await page.keyboard.press("Enter");
                    assert.deepEqual(await takeMessages(page), [{ type: "showUsage" }]);
                    await setState(page, { cost: 0.02345 });
                    assert.equal(await usage.textContent(), "1.2k · $0.0234");
                    await setState(page, { contextToken: "new-conversation", cost: undefined, tokens: undefined });
                    assert.equal(await usage.textContent(), "");
                    assert.doesNotMatch(await usage.getAttribute("title"), /cost/u);
                    assert.doesNotMatch(await usage.getAttribute("aria-label"), /cost/u);
                    await setState(page, { contextToken: "new-conversation", cost: 0, tokens: { total: 0 } });
                    assert.equal(await usage.textContent(), "0 · $0.0000");
                    await setState(page, { cost: 0.01234, tokens: undefined });
                    assert.equal(await usage.textContent(), "$0.0123");
                });
            });

            await t.test("incoming usage events update the displayed price before the agent settles", async () => {
                await withPage(browser, fixtures, { name: "streamed-conversation-cost", width: 280 }, async (page) => {
                    const state = createState({ cost: 1 });
                    applyEvent(state, { type: "agent_start" });
                    applyEvent(state, { type: "message_start", message: { role: "assistant", content: [] } });
                    for (const cost of [0.125, 0.25]) {
                        applyEvent(state, {
                            type: "message_update",
                            message: {
                                role: "assistant",
                                content: [{ type: "text", text: "Working" }],
                                usage: { cost: { total: cost } },
                            },
                        });
                        await setState(page, state);
                        assert.equal(state.status, "busy");
                        assert.match(
                            await page.locator("#token-status").textContent(),
                            new RegExp(`\\$${(1 + cost).toFixed(4).replace(".", "\\.")}`, "u"),
                        );
                    }
                });
            });

            await t.test(
                "zero, tiny, large, and unavailable costs remain accurate and compact while streaming",
                async () => {
                    await withPage(
                        browser,
                        fixtures,
                        { name: "conversation-cost-streaming", width: 280 },
                        async (page) => {
                            const usage = page.locator("#token-status");
                            for (const [cost, expected] of [
                                [0, "1.2k · $0.0000"],
                                [0.00000032, "1.2k · <$0.0001"],
                                [0.01234, "1.2k · $0.0123"],
                                [999.1234, "1.2k · $999.1234"],
                                [1234.56, "1.2k · $1.235K"],
                                [1e12, "1.2k · $1.00e+12"],
                                [null, "1.2k tokens"],
                                [undefined, "1.2k tokens"],
                                [NaN, "1.2k tokens"],
                                [Infinity, "1.2k tokens"],
                                [-1, "1.2k tokens"],
                                ["0.0123", "1.2k tokens"],
                            ]) {
                                await setState(page, { status: "busy", cost, messages: sampleMessages() });
                                assert.equal(await usage.textContent(), expected);
                                await assertLayout(page, 280);
                                const bounds = await page.locator(".session-footer").evaluate((footer) => {
                                    const cost = document.getElementById("token-status").getBoundingClientRect();
                                    const mode = document.getElementById("send-mode").getBoundingClientRect();
                                    const stop = document.getElementById("stop-button").getBoundingClientRect();

                                    return {
                                        height: footer.getBoundingClientRect().height,
                                        left: cost.left,
                                        right: cost.right,
                                        cost: {
                                            left: cost.left,
                                            right: cost.right,
                                            top: cost.top,
                                            bottom: cost.bottom,
                                        },
                                        mode: {
                                            left: mode.left,
                                            right: mode.right,
                                            top: mode.top,
                                            bottom: mode.bottom,
                                        },
                                        stop: {
                                            left: stop.left,
                                            right: stop.right,
                                            top: stop.top,
                                            bottom: stop.bottom,
                                        },
                                    };
                                });
                                assert.ok(bounds.height >= 32 && bounds.height <= 72);
                                for (const other of [bounds.mode, bounds.stop]) {
                                    const separate =
                                        bounds.cost.right <= other.left ||
                                        bounds.cost.left >= other.right ||
                                        bounds.cost.bottom <= other.top ||
                                        bounds.cost.top >= other.bottom;
                                    assert.ok(separate, `Readable footer controls must not overlap: ${expected}`);
                                }
                            }

                            await setState(page, { status: "busy", cost: 0.01234, messages: sampleMessages() });
                            await page.screenshot({ path: path.join(screenshots, "conversation-cost-280-busy.png") });
                        },
                    );
                },
            );

            await t.test(
                "chat typography stays readable in narrow and wide sidebars and follows larger host fonts",
                async () => {
                    for (const width of [280, 390, 768, 1200]) {
                        await withPage(browser, fixtures, { name: `readable-type-${width}`, width }, async (page) => {
                            await setState(page, {
                                messages: sampleMessages(),
                                runtimeStatus: {
                                    "aa-codex-usage": "codex ▀▀▀▄▄▄▄▄▄▄ 4d",
                                    "provider-usage": "claude 25% 5h · 40% 7d",
                                },
                            });
                            await page.locator("#provider-usage summary").click();
                            const fonts = async () =>
                                page.evaluate(() => {
                                    const size = (selector) =>
                                        parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);

                                    return {
                                        message: size(".message-assistant .markdown"),
                                        composer: size("#composer-input"),
                                        limits: size("#provider-usage-values dd"),
                                        footer: size("#token-status"),
                                        code: size(".code-block pre code"),
                                    };
                                });
                            const originalFonts = await fonts();
                            assert.ok(Object.values(originalFonts).every((size) => size >= 12));
                            await assertLayout(page, width);
                            await page.screenshot({ path: path.join(screenshots, `readable-type-${width}.png`) });
                            await page.evaluate(() =>
                                document.documentElement.style.setProperty("--vscode-font-size", "16px"),
                            );
                            for (const [element, size] of Object.entries(await fonts())) {
                                assert.ok(size > originalFonts[element], `${element} must follow the larger host font`);
                            }

                            await assertLayout(page, width);
                        });
                    }
                },
            );

            const compactMeasurements = [];
            for (const width of [280, 390, 768]) {
                await t.test(
                    `compact composer at ${width}px grows with the draft and shrinks when cleared`,
                    async () => {
                        await withPage(
                            browser,
                            fixtures,
                            { name: `compact-composer-${width}`, width },
                            async (page) => {
                                await setState(page, { messages: sampleMessages() });
                                const input = page.locator("#composer-input");
                                const empty = await composerMetrics(page);
                                assert.ok(
                                    empty.composerHeight >= 60 && empty.composerHeight <= 96,
                                    `An idle composer should leave room for the conversation: ${JSON.stringify(empty)}`,
                                );
                                assert.ok(empty.inputHeight >= 28 && empty.inputHeight <= 48);
                                await input.fill("One short line");
                                const oneLine = await composerMetrics(page);
                                assert.ok(oneLine.composerHeight <= empty.composerHeight + 4);
                                await assertLayout(page, width);
                                await page.screenshot({
                                    path: path.join(screenshots, `composer-after-${width}-idle.png`),
                                });

                                const keyboardControls = new Set([
                                    "attach-menu-button",
                                    "attach-selection",
                                    "model-select",
                                    "thinking-select",
                                    "send-button",
                                ]);
                                const reached = new Set();
                                await input.focus();
                                for (let index = 0; index < 12 && reached.size < keyboardControls.size; index += 1) {
                                    await page.keyboard.press("Tab");
                                    const active = await page.evaluate(() => document.activeElement?.id);
                                    if (keyboardControls.has(active)) {
                                        reached.add(active);
                                    }
                                }

                                assert.deepEqual(
                                    Array.from(reached).sort(),
                                    Array.from(keyboardControls).sort(),
                                    "Context, model, thinking, and Send must remain reachable by keyboard",
                                );
                                assert.deepEqual(await takeMessages(page), []);

                                await input.fill("First line\nSecond line\nThird line\nFourth line");
                                const multiline = await composerMetrics(page);
                                assert.ok(multiline.inputHeight > oneLine.inputHeight + 20);
                                await input.fill(
                                    Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n"),
                                );
                                const capped = await composerMetrics(page);
                                assert.ok(capped.inputHeight >= multiline.inputHeight && capped.inputHeight <= 190);
                                assert.ok(capped.inputScrollHeight > capped.inputClientHeight + 100);
                                await assertLayout(page, width);
                                await page.screenshot({
                                    path: path.join(screenshots, `composer-after-${width}-multiline.png`),
                                });

                                await input.fill("");
                                const cleared = await composerMetrics(page);
                                assert.ok(cleared.composerHeight <= empty.composerHeight + 4);
                                await input.fill("Send this\nmultiline draft");
                                await input.press("Enter");
                                assert.deepEqual(await takeMessages(page), [
                                    { type: "send", text: "Send this\nmultiline draft", mode: "prompt" },
                                ]);
                                assert.equal(await input.inputValue(), "");
                                const sent = await composerMetrics(page);
                                assert.ok(sent.composerHeight <= empty.composerHeight + 4);
                                await assertLayout(page, width);
                                compactMeasurements.push({ width, empty, oneLine, multiline, capped, cleared, sent });
                            },
                        );
                    },
                );
            }

            await fs.writeFile(
                path.join(screenshots, "composer-after-measurements.json"),
                `${JSON.stringify(compactMeasurements, null, 2)}\n`,
                "utf8",
            );
            await t.test("a compact composer keeps queue and Stop usable in a short sidebar", async () => {
                await withPage(
                    browser,
                    fixtures,
                    { name: "compact-composer-busy", width: 280, height: 500 },
                    async (page) => {
                        await setState(page, { status: "busy", messages: sampleMessages(), queueCount: 1 });
                        const input = page.locator("#composer-input");
                        await input.fill("Keep this focused.");
                        assert.equal(await page.locator("#send-mode").isEnabled(), true);
                        assert.equal(await page.locator("#stop-button").isEnabled(), true);
                        const metrics = await composerMetrics(page);
                        assert.ok(
                            metrics.composerHeight <= 130,
                            `Busy queue controls should keep a compact footprint: ${JSON.stringify(metrics)}`,
                        );
                        await assertLayout(page, 280);
                        for (const selector of ["#send-mode", "#stop-button", "#send-button"]) {
                            const bounds = await page.locator(selector).boundingBox();
                            assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 280);
                            assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 500);
                        }

                        await page.locator("#send-mode").focus();
                        await page.keyboard.press("ArrowDown");
                        assert.equal(await page.locator("#send-mode").inputValue(), "followUp");
                        await input.focus();
                        await input.press("Enter");
                        await page.locator("#stop-button").focus();
                        await page.keyboard.press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "send", text: "Keep this focused.", mode: "followUp" },
                            { type: "stop" },
                        ]);
                        assert.ok((await composerMetrics(page)).composerHeight <= 130);
                        await page.screenshot({ path: path.join(screenshots, "composer-after-busy-280x500.png") });
                    },
                );
            });

            await t.test(
                "maximum thinking is supported and selections wait for the authoritative host state",
                async () => {
                    await withPage(browser, fixtures, { name: "maximum-thinking", width: 280 }, async (page) => {
                        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
                        const thinking = page.locator("#thinking-select");
                        await setState(page, { thinkingLevels, thinkingLevel: "max" });
                        assert.deepEqual(
                            await thinking
                                .locator("option")
                                .evaluateAll((options) => options.map((option) => option.value)),
                            thinkingLevels,
                        );
                        assert.equal(await thinking.inputValue(), "max");
                        assert.equal(await thinking.isEnabled(), true);
                        assert.ok((await thinking.locator('option[value="max"]').textContent()).trim().length > 0);
                        await thinking.selectOption("high");
                        assert.deepEqual(await takeMessages(page), [{ type: "setThinking", level: "high" }]);
                        assert.equal(
                            await thinking.inputValue(),
                            "max",
                            "The selected value must keep reflecting the host until it accepts the change",
                        );
                        await setState(page, { thinkingLevels, thinkingLevel: "high" });
                        assert.equal(await thinking.inputValue(), "high");
                        await thinking.selectOption("max");
                        assert.deepEqual(await takeMessages(page), [{ type: "setThinking", level: "max" }]);
                        assert.equal(await thinking.inputValue(), "high");
                        await setState(page, { thinkingLevels, thinkingLevel: "max" });
                        assert.equal(await thinking.inputValue(), "max");
                        await setState(page, { thinkingLevels, thinkingLevel: "max", status: "busy" });
                        assert.equal(await thinking.inputValue(), "max");
                        assert.equal(await thinking.isDisabled(), true);
                        await setState(page, { thinkingLevels, thinkingLevel: "max" });
                        assert.equal(await thinking.inputValue(), "max");
                        assert.equal(await thinking.isEnabled(), true);
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            for (const width of [280, 390]) {
                await t.test(`Command Guard mode stays readable and pickable at ${width}px`, async () => {
                    await withPage(browser, fixtures, { name: `guard-mode-${width}`, width }, async (page) => {
                        const chip = page.locator("#guard-button");
                        const guard = (mode, label) => ({
                            guard: { mode, label, detail: `Synthetic ${mode} description.`, actions: ["guard"] },
                        });
                        assert.equal(await chip.isVisible(), false, "A chat without SpecPi's guard shows no mode");
                        for (const [mode, label] of [
                            ["guard", "Guard"],
                            ["strict", "Strict"],
                            ["off", "Off"],
                            ["locked", "Locked"],
                        ]) {
                            await setState(page, guard(mode, label));
                            assert.equal(await chip.isVisible(), true);
                            assert.equal((await page.locator("#guard-label").textContent()).trim(), label);
                            // The label collapses to the shield alone in the narrowest sidebar.
                            assert.equal(await page.locator("#guard-label").isVisible(), width > 330);
                            assert.match(await chip.getAttribute("aria-label"), new RegExp(label, "u"));
                            assert.match(await chip.getAttribute("title"), /Synthetic/u);
                            await assertLayout(page, width);
                            await page.screenshot({
                                path: path.join(screenshots, `guard-${mode}-${width}.png`),
                            });
                        }

                        await chip.click();
                        assert.deepEqual(await takeMessages(page), [{ type: "chooseGuard" }]);
                        await chip.focus();
                        assert.equal(await page.evaluate(() => document.activeElement?.id), "guard-button");
                        await page.keyboard.press("Enter");
                        assert.deepEqual(await takeMessages(page), [{ type: "chooseGuard" }]);
                        await setState(page, { ...guard("guard", "Guard"), status: "busy" });
                        assert.equal(await chip.isDisabled(), true);
                        await setState(page, { ...guard("guard", "Guard"), status: "disconnected" });
                        assert.equal(await chip.isVisible(), false, "A disconnected chat cannot report a live mode");
                        assert.deepEqual(await takeMessages(page), []);
                    });
                });
            }

            for (const width of [280, 390]) {
                await t.test(
                    `composer controls remain stable and keyboard accessible through the agent lifecycle at ${width}px`,
                    async () => {
                        await withPage(
                            browser,
                            fixtures,
                            { name: `composer-lifecycle-${width}`, width },
                            async (page) => {
                                const input = page.locator("#composer-input");
                                const heights = [];
                                const draft = "Keep this focused.";
                                for (const status of ["busy", "retrying", "compacting", "ready"]) {
                                    const active = status !== "ready";
                                    await setState(page, {
                                        status,
                                        messages: sampleMessages(),
                                        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
                                        thinkingLevel: "max",
                                    });
                                    await input.fill(draft);
                                    const metrics = await composerMetrics(page);
                                    heights.push({ status, height: metrics.composerHeight });
                                    assert.ok(
                                        metrics.composerHeight <= 130,
                                        `The ${status} composer is too tall: ${JSON.stringify(metrics)}`,
                                    );
                                    await assertLayout(page, width);
                                    assert.equal(await page.locator("#thinking-select").inputValue(), "max");
                                    assert.equal(await page.locator("#stop-button").isVisible(), active);
                                    assert.equal(await page.locator("#send-mode").isVisible(), active);
                                    const layout = await page.evaluate(() => {
                                        const footer = document.querySelector(".footer").getBoundingClientRect();
                                        const controls = [
                                            "attach-menu-button",
                                            "attach-selection",
                                            "model-select",
                                            "thinking-select",
                                            "send-mode",
                                            "stop-button",
                                            "send-button",
                                            "runtime-status",
                                            "token-status",
                                        ]
                                            .map((id) => {
                                                const node = document.getElementById(id);
                                                const bounds = node.getBoundingClientRect();

                                                return {
                                                    id,
                                                    left: bounds.left,
                                                    top: bounds.top,
                                                    right: bounds.right,
                                                    bottom: bounds.bottom,
                                                    width: bounds.width,
                                                    height: bounds.height,
                                                    visible:
                                                        bounds.width > 0 &&
                                                        bounds.height > 0 &&
                                                        getComputedStyle(node).visibility !== "hidden",
                                                };
                                            })
                                            .filter((control) => control.visible);

                                        return {
                                            footer: {
                                                left: footer.left,
                                                top: footer.top,
                                                right: footer.right,
                                                bottom: footer.bottom,
                                            },
                                            viewportHeight: innerHeight,
                                            viewportWidth: innerWidth,
                                            controls,
                                        };
                                    });
                                    for (let index = 0; index < layout.controls.length; index += 1) {
                                        const control = layout.controls[index];
                                        if (!["runtime-status", "token-status"].includes(control.id)) {
                                            assert.ok(
                                                control.width >= 20 && control.height >= 20,
                                                `${status}: ${control.id} has insufficient room: ${JSON.stringify(control)}`,
                                            );
                                        }

                                        assert.ok(
                                            control.left >= layout.footer.left &&
                                                control.right <= layout.footer.right &&
                                                control.top >= layout.footer.top &&
                                                control.bottom <= layout.footer.bottom &&
                                                control.left >= 0 &&
                                                control.right <= layout.viewportWidth &&
                                                control.top >= 0 &&
                                                control.bottom <= layout.viewportHeight,
                                            `${status}: ${control.id} extends beyond the footer or viewport`,
                                        );
                                        for (const other of layout.controls.slice(index + 1)) {
                                            const overlapWidth =
                                                Math.min(control.right, other.right) -
                                                Math.max(control.left, other.left);
                                            const overlapHeight =
                                                Math.min(control.bottom, other.bottom) -
                                                Math.max(control.top, other.top);
                                            assert.ok(
                                                overlapWidth <= 1 || overlapHeight <= 1,
                                                `${status}: ${control.id} overlaps ${other.id}`,
                                            );
                                        }
                                    }

                                    if (active) {
                                        const reached = new Set();
                                        await input.focus();
                                        for (
                                            let index = 0;
                                            index < 12 && (!reached.has("send-mode") || !reached.has("stop-button"));
                                            index += 1
                                        ) {
                                            await page.keyboard.press("Tab");
                                            reached.add(await page.evaluate(() => document.activeElement?.id));
                                        }

                                        assert.ok(
                                            reached.has("send-mode") && reached.has("stop-button"),
                                            `${status}: timing and Stop must be reachable through Tab navigation`,
                                        );
                                        await page.locator("#send-mode").focus();
                                        await page.keyboard.press("End");
                                        assert.equal(await page.locator("#send-mode").inputValue(), "followUp");
                                        await input.press("Enter");
                                        await page.locator("#stop-button").focus();
                                        await page.keyboard.press("Enter");
                                        assert.deepEqual(await takeMessages(page), [
                                            { type: "send", text: draft, mode: "followUp" },
                                            { type: "stop" },
                                        ]);
                                    } else {
                                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                                        await input.press("Enter");
                                        assert.deepEqual(await takeMessages(page), [
                                            { type: "send", text: draft, mode: "prompt" },
                                        ]);
                                    }

                                    await input.fill(draft);
                                    await page.screenshot({
                                        path: path.join(screenshots, `composer-lifecycle-${width}-${status}.png`),
                                    });
                                    if (width === 280 && status === "busy") {
                                        await page.locator(".footer").screenshot({
                                            path: path.join(screenshots, "composer-streaming-compact-preview.png"),
                                        });
                                    }
                                }

                                const values = heights.map(({ height }) => height);
                                assert.ok(
                                    Math.max(...values) - Math.min(...values) <= 4,
                                    `Changing agent state must not resize the same short draft: ${JSON.stringify(heights)}`,
                                );
                            },
                        );
                    },
                );
            }

            await t.test(
                "restored conversations show connection progress and allow cancellation until ready",
                async () => {
                    await withPage(
                        browser,
                        fixtures,
                        { name: "connecting-restored", width: 280, height: 700 },
                        async (page) => {
                            const messages = sampleMessages();
                            const input = page.locator("#composer-input");
                            await setState(page, { messages });
                            assert.equal(await page.locator("#connection-banner").isVisible(), false);
                            await input.fill("Keep this draft while Pi starts.");
                            const progress = "Loading the local Pi process and workspace extensions…";
                            await setState(page, {
                                status: "connecting",
                                messages,
                                connectionMessage: progress,
                                error: "A previous synthetic connection error.",
                            });
                            assert.equal(await page.locator("#welcome").isVisible(), false);
                            assert.equal(await page.locator(".message").count(), messages.length);
                            assert.equal(await page.locator("#connection-banner").isVisible(), true);
                            assert.equal(await page.locator("#connection-message").textContent(), progress);
                            assert.equal(await page.locator("#connection-label").textContent(), "Connecting");
                            assert.equal(await page.locator("#cancel-connection").isEnabled(), true);
                            assert.equal(await page.locator("#error-retry").isVisible(), false);
                            assert.equal(await page.locator("#connect-button").isVisible(), false);
                            assert.equal(await page.locator("#connection-button").isDisabled(), true);
                            assert.equal(await page.locator("#send-button").isDisabled(), true);
                            await input.press("Enter");
                            assert.deepEqual(await takeMessages(page), []);
                            assert.equal(await input.inputValue(), "Keep this draft while Pi starts.");
                            const nextProgress = "Waiting for Pi to finish loading the installed extensions.";
                            await setState(page, { status: "connecting", messages, connectionMessage: nextProgress });
                            assert.equal(await page.locator("#connection-message").textContent(), nextProgress);
                            await assertLayout(page, 280);
                            await page.screenshot({ path: path.join(screenshots, "connecting-restored-280.png") });
                            await page.locator("#cancel-connection").click();
                            assert.deepEqual(await takeMessages(page), [{ type: "disconnect" }]);
                            await setState(page, { messages, connectionMessage: nextProgress });
                            assert.equal(await page.locator("#connection-banner").isVisible(), false);
                            assert.equal(await page.locator("#cancel-connection").isVisible(), false);
                            assert.equal(await page.locator("#send-button").isEnabled(), true);
                            assert.equal(await input.inputValue(), "Keep this draft while Pi starts.");
                            assert.deepEqual(await takeMessages(page), []);
                            await input.press("Enter");
                            assert.deepEqual(await takeMessages(page), [
                                { type: "send", text: "Keep this draft while Pi starts.", mode: "prompt" },
                            ]);
                        },
                    );
                },
            );

            for (const width of [390, 768, 1200]) {
                await t.test(`selection chip and rejected-send recovery remain usable at ${width}px`, async () => {
                    await withPage(browser, fixtures, { name: `selection-recovery-${width}`, width }, async (page) => {
                        const input = page.locator("#composer-input");
                        await setState(page, {
                            conversationKey: "selection-review",
                            selectionContext: {
                                filePath: "/synthetic/sample.ts",
                                startLine: 1,
                                endLine: 1,
                                lineCount: 1,
                            },
                            attachments: [{ id: "explicit", label: "explicit.ts", detail: "File" }],
                        });
                        assert.equal(await page.locator("#selection-chip-text").textContent(), "sample.ts:L1 (1 line)");
                        await page.locator("#selection-chip-toggle").click();
                        assert.equal(
                            await page.locator("#selection-chip-toggle").getAttribute("aria-pressed"),
                            "false",
                        );
                        assert.ok(
                            (await takeMessages(page)).some(
                                (m) => m.type === "saveDraft" && m.selectionEnabled === false,
                            ),
                        );
                        assert.equal(await page.locator(".attachment-remove").count(), 1);
                        await page.locator("#selection-chip-toggle").click();
                        await input.fill("Keep this draft");
                        await input.press("Enter");
                        const send = (await takeMessages(page, { acknowledgeSends: false })).find(
                            (m) => m.type === "send",
                        );
                        assert.ok(send);
                        assert.equal(await input.inputValue(), "");
                        await sendHost(page, {
                            type: "draft",
                            conversationKey: "selection-review",
                            text: send.text,
                            mode: "restore",
                        });
                        await sendHost(page, {
                            type: "sendResult",
                            conversationKey: "selection-review",
                            requestId: send.requestId,
                            accepted: false,
                        });
                        assert.equal(await input.inputValue(), "Keep this draft");
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                        await assertLayout(page, width);
                    });
                });
            }

            await t.test(
                "live conversation switches preserve drafts, selection, scrolling and background recovery",
                async () => {
                    await withPage(
                        browser,
                        fixtures,
                        { name: "live-conversation-drafts", width: 390 },
                        async (page) => {
                            const input = page.locator("#composer-input");
                            const messages = Array.from({ length: 30 }, (_, index) => ({
                                id: `a-${index}`,
                                role: "assistant",
                                text: `Conversation A paragraph ${index}.\n\nThis reply keeps streaming independently.`,
                            }));
                            const first = {
                                conversationKey: "conversation-a",
                                contextToken: "context-a",
                                status: "busy",
                                messages,
                            };
                            await setState(page, first);
                            await input.fill("Draft for conversation A");
                            await input.evaluate((node) => node.setSelectionRange(6, 9));
                            await page.locator("#send-mode").selectOption("followUp");
                            await page.locator("#scroll-area").evaluate((node) => {
                                node.scrollTop = 150;
                                node.dispatchEvent(new Event("scroll"));
                            });
                            const scrollTop = await page.locator("#scroll-area").evaluate((node) => node.scrollTop);
                            await setState(page, {
                                conversationKey: "conversation-b",
                                contextToken: "context-b",
                                draft: { text: "Saved draft B", selectionStart: 2, selectionEnd: 5 },
                            });
                            assert.equal(await input.inputValue(), "Saved draft B");
                            assert.deepEqual(
                                await input.evaluate((node) => [node.selectionStart, node.selectionEnd]),
                                [2, 5],
                            );
                            await input.fill("New B draft");
                            await sendHost(page, {
                                type: "draft",
                                conversationKey: "conversation-a",
                                text: "Recovered A prompt",
                                mode: "restore",
                            });
                            assert.equal(
                                await input.inputValue(),
                                "New B draft",
                                "Background recovery must not alter the visible conversation",
                            );
                            await setState(page, first);
                            assert.equal(await input.inputValue(), "Recovered A prompt\n\nDraft for conversation A");
                            assert.equal(await page.locator("#send-mode").inputValue(), "followUp");
                            assert.equal(
                                await page.locator("#scroll-area").evaluate((node) => node.scrollTop),
                                scrollTop,
                            );
                            assert.equal(await page.locator("#jump-to-latest").isVisible(), true);
                            await setState(page, { conversationKey: "conversation-b", contextToken: "context-b" });
                            assert.equal(await input.inputValue(), "New B draft");
                            const posted = await takeMessages(page);
                            assert.ok(posted.every((message) => message.type === "saveDraft"));
                            assert.ok(
                                posted.some(
                                    (message) =>
                                        message.conversationKey === "conversation-a" &&
                                        message.text === "Draft for conversation A",
                                ),
                            );
                            assert.ok(
                                posted.some(
                                    (message) =>
                                        message.conversationKey === "conversation-b" && message.text === "New B draft",
                                ),
                            );
                        },
                    );
                },
            );

            await t.test("background recovery after webview recreation uses the complete host draft", async () => {
                await withPage(browser, fixtures, { name: "live-draft-recreation", width: 390 }, async (page) => {
                    const input = page.locator("#composer-input");
                    await setState(page, {
                        conversationKey: "conversation-b",
                        contextToken: "context-b",
                        draft: { text: "Draft B" },
                    });
                    const snapshot = {
                        text: "Recovered A prompt\n\nLater unsent A draft",
                        selectionStart: 5,
                        selectionEnd: 9,
                        sendMode: "followUp",
                    };
                    await sendHost(page, {
                        type: "draft",
                        conversationKey: "conversation-a",
                        mode: "restore",
                        text: "Recovered A prompt",
                        draftSnapshot: snapshot,
                    });
                    assert.equal(await input.inputValue(), "Draft B");
                    await setState(page, {
                        conversationKey: "conversation-a",
                        contextToken: "context-a",
                        draft: snapshot,
                    });
                    assert.equal(await input.inputValue(), snapshot.text);
                    assert.deepEqual(await input.evaluate((node) => [node.selectionStart, node.selectionEnd]), [5, 9]);
                    await setState(page, {
                        conversationKey: "conversation-b",
                        contextToken: "context-b",
                        draft: { text: "Latest authoritative B draft" },
                    });
                    assert.equal(await input.inputValue(), "Latest authoritative B draft");
                    assert.ok((await takeMessages(page)).every((message) => message.type === "saveDraft"));
                });
            });

            await t.test("background send acknowledgments remain bound to their conversation", async () => {
                await withPage(browser, fixtures, { name: "live-conversation-send", width: 280 }, async (page) => {
                    const input = page.locator("#composer-input");
                    await setState(page, { conversationKey: "conversation-a", contextToken: "context-a" });
                    await input.fill("Send in A");
                    await input.press("Enter");
                    const posted = await takeMessages(page, { acknowledgeSends: false });
                    const request = posted.find((message) => message.type === "send");
                    assert.equal(request.conversationKey, "conversation-a");
                    await setState(page, {
                        conversationKey: "conversation-b",
                        contextToken: "context-b",
                        status: "connecting",
                    });
                    await input.fill("Draft B");
                    assert.equal(await page.locator("#new-chat").isEnabled(), true);
                    assert.equal(await page.locator("#history-button").isEnabled(), true);
                    assert.equal(await page.locator("#choose-workspace").isEnabled(), true);
                    await sendHost(page, {
                        type: "sendResult",
                        conversationKey: "conversation-a",
                        requestId: request.requestId,
                        accepted: true,
                    });
                    await sendHost(page, { type: "focus", conversationKey: "conversation-a" });
                    assert.equal(await input.inputValue(), "Draft B");
                    await setState(page, { conversationKey: "conversation-a", contextToken: "context-a" });
                    assert.equal(await input.inputValue(), "");
                    await input.fill("A can send again");
                    assert.equal(await page.locator("#send-button").isEnabled(), true);
                    assert.ok((await takeMessages(page)).every((message) => message.type === "saveDraft"));
                });
            });

            await t.test("keyboard sending, multiline input, IME, steering, follow-up, and Stop", async () => {
                await withPage(browser, fixtures, { name: "composer" }, async (page) => {
                    const input = page.locator("#composer-input");
                    await input.fill("  First line  ");
                    await input.press("End");
                    await input.press("Shift+Enter");
                    await input.press("a");
                    assert.deepEqual(await takeMessages(page), []);
                    assert.equal(await input.inputValue(), "  First line  \na");
                    await input.press("Enter");
                    assert.deepEqual(await takeMessages(page), [
                        { type: "send", text: "First line  \na", mode: "prompt" },
                    ]);
                    assert.equal(await input.inputValue(), "");
                    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
                    await input.fill("文字");
                    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
                    assert.deepEqual(await takeMessages(page), []);
                    assert.equal(await input.inputValue(), "文字");
                    await setState(page, { status: "connecting" });
                    await input.press("Enter");
                    assert.deepEqual(await takeMessages(page), []);
                    assert.equal(await page.locator("#send-button").isDisabled(), true);
                    await setState(page, {
                        status: "busy",
                        messages: [{ id: "busy", role: "assistant", text: "Working…", isRunning: true }],
                        queueCount: 2,
                    });
                    assert.equal(await page.locator("#stop-button").isVisible(), true);
                    assert.equal(await page.locator("#send-mode").isVisible(), true);
                    assert.equal(await page.locator("#queue-notice").textContent(), "2 messages queued");
                    await page.locator("#send-button").click();
                    assert.deepEqual(await takeMessages(page), [{ type: "send", text: "文字", mode: "steer" }]);
                    await page.locator("#send-mode").selectOption("followUp");
                    await input.fill("Then run the narrow test.");
                    assert.equal(await page.locator("#send-button").getAttribute("aria-label"), "Queue follow-up");
                    await input.press("Enter");
                    await page.locator("#stop-button").click();
                    assert.deepEqual(await takeMessages(page), [
                        { type: "send", text: "Then run the narrow test.", mode: "followUp" },
                        { type: "stop" },
                    ]);
                    await setState(page);
                    assert.equal(await page.locator("#stop-button").isVisible(), false);
                    assert.equal(await page.locator("#send-mode").isVisible(), false);
                });
            });

            await t.test(
                "requests preserve exact choices and editor text, cancel explicitly, and prevent duplicate replies",
                async () => {
                    await withPage(browser, fixtures, { name: "requests", width: 280 }, async (page) => {
                        const exactOption = "  Allow once — preserve  two spaces\nand newline  ";
                        await setState(page, {
                            status: "busy",
                            uiRequest: {
                                id: "select-1",
                                method: "select",
                                title: "Review this operation",
                                message: "Synthetic request; no workspace command will run.",
                                options: [exactOption, "Deny"],
                            },
                        });
                        assert.deepEqual(await takeMessages(page), []);
                        assert.equal(
                            await page.locator("#ui-request-title").evaluate((node) => node === document.activeElement),
                            true,
                        );
                        await page.locator("#composer-input").fill("Must wait for the decision");
                        await page.locator("#composer-input").press("Enter");
                        assert.deepEqual(await takeMessages(page), []);
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        await page.locator(".request-option").first().click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: "select-1", value: exactOption },
                        ]);
                        assert.equal(await page.locator(".request-option").first().isDisabled(), true);
                        await page.keyboard.press("Escape");
                        assert.deepEqual(await takeMessages(page), []);
                        await setState(page, {
                            status: "busy",
                            uiRequest: { id: "confirm-1", method: "confirm", title: "Confirm a synthetic operation" },
                        });
                        await page.keyboard.press("Escape");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: "confirm-1", cancelled: true },
                        ]);
                        await setState(page, {
                            status: "busy",
                            uiRequest: { id: "confirm-2", method: "confirm", title: "Confirm a synthetic operation" },
                        });
                        await page.locator("#ui-request").getByRole("button", { name: "Confirm", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: "confirm-2", confirmed: true },
                        ]);
                        await setState(page, {
                            status: "busy",
                            uiRequest: {
                                id: "input-1",
                                method: "input",
                                title: "A brief response",
                                prefill: "Suggested answer",
                            },
                        });
                        assert.equal(await page.locator("#request-input").inputValue(), "Suggested answer");
                        await page.locator("#request-input").fill("  exact answer  ");
                        await page.locator("#request-input").press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: "input-1", value: "  exact answer  " },
                        ]);
                        const text = "  const value = '<script>literal</script>';\n\treturn value;\n";
                        await setState(page, {
                            status: "busy",
                            uiRequest: {
                                id: "editor-1",
                                method: "editor",
                                title: "Edit the proposed text",
                                prefill: "Original text",
                            },
                        });
                        const field = page.locator("#request-input");
                        await field.fill(text);
                        await field.press("End");
                        await field.press("Enter");
                        assert.deepEqual(await takeMessages(page), []);
                        const expected = await field.inputValue();
                        assert.equal(expected, `${text}\n`);
                        await assertLayout(page, 280);
                        await field.press("Control+Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: "editor-1", value: expected },
                        ]);
                        await setState(page, {
                            status: "busy",
                            uiRequest: { id: "editor-2", method: "editor", title: "Cancel this proposal" },
                        });
                        await page.locator("#ui-request").getByRole("button", { name: "Cancel", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: "editor-2", cancelled: true },
                        ]);
                        await setState(page);
                        assert.equal(await page.locator("#ui-request").isVisible(), false);
                        assert.equal(
                            await page.locator("#composer-input").evaluate((node) => node === document.activeElement),
                            true,
                        );
                    });
                },
            );

            await t.test(
                "models, thinking levels, command completion, attachments, and header actions dispatch typed messages",
                async () => {
                    await withPage(browser, fixtures, { name: "controls" }, async (page) => {
                        await page.locator("#connect-button").click();
                        assert.deepEqual(await takeMessages(page), [{ type: "connect" }]);
                        await setState(page, {
                            attachments: [{ id: "file-1", label: "sidebar.js", detail: "Synthetic context" }],
                            commands: [
                                ...readyState().commands,
                                { name: "/help", description: "Duplicate runtime help" },
                            ],
                        });
                        // Each option names its provider so the selector shows where the model runs.
                        assert.deepEqual(await page.locator("#model-select option").allTextContents(), [
                            "Fixture Reasoning · fixture",
                            "Fixture Fast · fixture",
                        ]);
                        await page.locator("#model-select").selectOption(JSON.stringify(["fixture", "fast-model"]));
                        await page.locator("#thinking-select").selectOption("high");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "setModel", provider: "fixture", modelId: "fast-model" },
                            { type: "setThinking", level: "high" },
                        ]);
                        const input = page.locator("#composer-input");
                        await input.fill("/");
                        assert.equal(await page.locator("#slash-menu").isVisible(), true);
                        assert.deepEqual(await page.locator(".slash-name").allTextContents(), [
                            "/help",
                            "/new",
                            "/compact",
                            "/model",
                            "/settings",
                            "/login",
                            "/logout",
                            "/plan",
                            "/review",
                        ]);
                        await input.press("ArrowUp");
                        assert.equal(await input.getAttribute("aria-activedescendant"), "slash-option-8");
                        await input.press("Enter");
                        assert.equal(await input.inputValue(), "/review ");
                        assert.equal(await page.locator("#slash-menu").isVisible(), false);
                        assert.deepEqual(await takeMessages(page), []);
                        await input.press("Enter");
                        assert.deepEqual(await takeMessages(page), [{ type: "send", text: "/review", mode: "prompt" }]);
                        await input.fill("/pl");
                        await input.press("Tab");
                        assert.equal(await input.inputValue(), "/plan ");
                        await input.fill("/");
                        await input.press("Escape");
                        assert.equal(await page.locator("#slash-menu").isVisible(), false);
                        await page.locator("#attach-menu-button").click();
                        await page.locator("#attach-file").click();
                        await page.locator("#attach-selection").click();
                        await page.getByRole("button", { name: "Remove sidebar.js", exact: true }).click();
                        await page.locator("#history-button").click();
                        await page.locator("#settings-button").click();
                        await page.locator("#review-changes").click();
                        await page.locator("#choose-workspace").click();
                        await page.locator("#new-chat").click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "attachFile" },
                            { type: "attachSelection" },
                            { type: "removeAttachment", id: "file-1" },
                            { type: "history" },
                            { type: "settings" },
                            { type: "reviewChanges" },
                            { type: "chooseWorkspace" },
                            { type: "newChat" },
                        ]);
                        await setState(page, { status: "busy" });
                        assert.equal(await page.locator("#model-select").isDisabled(), true);
                        assert.equal(await page.locator("#thinking-select").isDisabled(), true);
                        assert.equal(await page.locator("#choose-workspace").isEnabled(), true);
                    });
                },
            );

            await t.test(
                "streaming follows the latest reply until the reader scrolls away, and Jump resumes following",
                async () => {
                    await withPage(browser, fixtures, { name: "streaming", height: 700 }, async (page) => {
                        const messages = Array.from({ length: 18 }, (_, index) => ({
                            id: `message-${index}`,
                            role: index % 2 ? "assistant" : "user",
                            text: `Synthetic message ${index}.\n\n${"Readable conversation context. ".repeat(8)}`,
                        }));
                        await setState(page, { status: "busy", messages });
                        const waitForBottom = async () => {
                            try {
                                await page.waitForFunction(() => {
                                    const node = document.getElementById("scroll-area");

                                    return node.scrollHeight - node.scrollTop - node.clientHeight < 3;
                                });
                            } catch (error) {
                                const metrics = await page.locator("#scroll-area").evaluate((node) => ({
                                    height: node.clientHeight,
                                    scrollHeight: node.scrollHeight,
                                    top: node.scrollTop,
                                    gap: node.scrollHeight - node.scrollTop - node.clientHeight,
                                    jumpHidden: document.getElementById("jump-to-latest").hidden,
                                }));
                                error.message += `\nUnsettled chat scroll: ${JSON.stringify(metrics)}`;
                                throw error;
                            }
                        };

                        const initialScroll = await page.locator("#scroll-area").evaluate((node) => ({
                            top: node.scrollTop,
                            height: node.clientHeight,
                            scrollHeight: node.scrollHeight,
                            gap: node.scrollHeight - node.scrollTop - node.clientHeight,
                        }));
                        assert.ok(
                            initialScroll.gap < 3,
                            `Initial transcript did not follow its last message: ${JSON.stringify(initialScroll)}`,
                        );
                        await waitForBottom();
                        messages[messages.length - 1].text += "\n\nA newly streamed paragraph.";
                        await setState(page, { status: "busy", messages });
                        await waitForBottom();
                        await page.locator("#scroll-area").evaluate((node) => {
                            node.scrollTop = 0;
                        });
                        await page.waitForFunction(() => !document.getElementById("jump-to-latest").hidden);
                        const scrollBefore = await page.locator("#scroll-area").evaluate((node) => node.scrollTop);
                        messages[messages.length - 1].text += `\n\n${"Additional streamed content. ".repeat(12)}`;
                        await setState(page, { status: "busy", messages });
                        assert.equal(
                            await page.locator("#scroll-area").evaluate((node) => node.scrollTop),
                            scrollBefore,
                        );
                        assert.equal(await page.locator("#jump-to-latest").isVisible(), true);
                        await page.locator("#jump-to-latest").click();
                        await waitForBottom();
                        assert.equal(await page.locator("#jump-to-latest").isVisible(), false);
                        messages[messages.length - 1].text += "\n\nFinal streamed content.";
                        await setState(page, { messages });
                        await waitForBottom();
                        assert.match(await page.locator("#announcer").textContent(), /Pi replied/u);
                    });
                },
            );

            await t.test(
                "workspace references open through the host and remain usable in a narrow conversation",
                async () => {
                    await withPage(browser, fixtures, { name: "workspace-references", width: 280 }, async (page) => {
                        const longReference = `src/${"a-long-directory-name/".repeat(8)}component.ts:123`;
                        const fencedReferences = "src/fenced.ts:7\n[source](src/also-fenced.ts:9)";
                        const text = [
                            "[source](src/app.ts:12)",
                            "`src/view.ts#L5-L8`",
                            "See src/file.ts:3:2.",
                            "[encoded path](<src/space%20dir/my%20file.ts:8>)",
                            "[angle path](<src/space dir/other file.ts:9>)",
                            `\`${longReference}\``,
                            "[unsafe command](command:workbench.action.terminal.new)",
                            "[unsafe script](javascript:alert%281%29)",
                            `\`\`\`text\n${fencedReferences}\n\`\`\``,
                        ].join("\n\n");
                        await setState(page, { messages: [{ id: "references", role: "assistant", text }] });
                        const originalUrl = page.url();
                        assert.equal(await page.locator(".code-reference").count(), 6);
                        assert.equal(await page.locator("#conversation a").count(), 0);
                        assert.equal(await page.locator(".code-block .code-reference").count(), 0);
                        assert.equal(await page.locator(".code-block pre code").textContent(), fencedReferences);
                        assert.equal(await page.getByRole("link", { name: "unsafe command", exact: true }).count(), 0);
                        assert.equal(await page.getByRole("link", { name: "unsafe script", exact: true }).count(), 0);

                        const source = page.getByRole("link", { name: "source", exact: true });
                        await source.focus();
                        await page.keyboard.press("Tab");
                        assert.equal(
                            await page.evaluate(() => document.activeElement?.textContent),
                            "src/view.ts#L5-L8",
                        );
                        await page.keyboard.press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "openCode", reference: "src/view.ts#L5-L8" },
                        ]);
                        for (const [label, reference] of [
                            ["source", "src/app.ts:12"],
                            ["src/file.ts:3:2", "src/file.ts:3:2"],
                            ["encoded path", "src/space dir/my file.ts:8"],
                            ["angle path", "src/space dir/other file.ts:9"],
                            [longReference, longReference],
                        ]) {
                            await page.getByRole("link", { name: label, exact: true }).click();
                            assert.deepEqual(await takeMessages(page), [{ type: "openCode", reference }]);
                            assert.equal(page.url(), originalUrl, "Code references must not navigate the webview");
                            assert.equal(
                                page.context().pages().length,
                                1,
                                "Code references must not open browser tabs",
                            );
                        }

                        const bounds = await page.locator(".code-reference").evaluateAll((buttons) =>
                            buttons.map((button) => {
                                const rect = button.getBoundingClientRect();

                                return {
                                    text: button.textContent,
                                    left: rect.left,
                                    right: rect.right,
                                    overflow: button.scrollWidth - button.clientWidth,
                                    href: button.getAttribute("href"),
                                };
                            }),
                        );
                        for (const button of bounds) {
                            assert.ok(
                                button.left >= 0 && button.right <= 280 && button.overflow <= 1,
                                `Code reference overflows the narrow sidebar: ${JSON.stringify(button)}`,
                            );
                            assert.equal(button.href, null);
                        }

                        await assertLayout(page, 280);
                        await page.screenshot({ path: path.join(screenshots, "workspace-references-280.png") });
                    });
                },
            );

            await t.test(
                "Markdown stays inert, links go through the host, and expandable tool output survives streaming",
                async () => {
                    await withPage(browser, fixtures, { name: "markdown" }, async (page) => {
                        const payload =
                            '<script>window.specpiAttack = true</script>\n<img src="https://example.invalid/tracker" onerror="window.specpiAttack = true">\n[bad](javascript:alert%281%29)\n[command](command:workbench.action.terminal.new)\n![remote image](https://example.invalid/image.png)\n\n[Documentation](https://example.invalid/docs)\n\n```html\n<img onerror=alert(1)>\n```';
                        const messages = [
                            {
                                id: "assistant",
                                role: "assistant",
                                text: payload,
                                thinking: "Private reasoning fixture",
                            },
                            {
                                id: "tool",
                                role: "tool",
                                toolName: "read",
                                input: "<img onerror=alert(1)> literal tool input",
                                text: "first output",
                                isRunning: true,
                            },
                        ];
                        await setState(page, { status: "busy", messages });
                        assert.equal(await page.locator(".tool-input").isVisible(), true);
                        assert.equal(
                            await page
                                .locator(
                                    "#conversation script, #conversation img, #conversation iframe, #conversation a",
                                )
                                .count(),
                            0,
                        );
                        assert.equal(await page.evaluate(() => window.specpiAttack), undefined);
                        assert.match(
                            await page.locator(".message-assistant .message-body").textContent(),
                            /<script>window\.specpiAttack = true<\/script>/u,
                        );
                        assert.equal(await page.getByRole("link", { name: "Documentation", exact: true }).count(), 1);
                        assert.equal(await page.locator(".external-image-action").count(), 1);
                        await page.getByRole("link", { name: "Documentation", exact: true }).click();
                        const copy = page.getByRole("button", { name: "Copy code to clipboard", exact: true });
                        await copy.click();
                        const [linkMessage, copyMessage] = await takeMessages(page);
                        assert.deepEqual(linkMessage, { type: "openLink", url: "https://example.invalid/docs" });
                        assert.equal(copyMessage.type, "copy");
                        assert.equal(copyMessage.text, "<img onerror=alert(1)>");
                        assert.equal(typeof copyMessage.requestId, "string");
                        assert.ok(copyMessage.requestId.length > 0);
                        assert.equal(await copy.textContent(), "Copy code", "Clipboard success must wait for the host");
                        await sendHost(page, { type: "copied", requestId: "an-unknown-request" });
                        assert.equal(await copy.textContent(), "Copy code");
                        await sendHost(page, { type: "copied", requestId: copyMessage.requestId });
                        assert.equal(await copy.textContent(), "Copied");
                        assert.equal(await page.locator("#announcer").textContent(), "Copied to clipboard");
                        assert.equal(await page.locator(".reasoning-content").isVisible(), true);
                        assert.equal(
                            await page.locator(".tool-input").textContent(),
                            "<img onerror=alert(1)> literal tool input",
                        );
                        assert.equal(await page.locator(".tool-input img").count(), 0);
                        assert.equal(await page.locator(".reasoning").getAttribute("open"), "");
                        assert.equal(await page.locator(".tool-card").getAttribute("open"), "");
                        messages[0].text += "\n\nMore streamed text.";
                        messages[1].text = "first output\nsecond output";
                        messages[1].isRunning = false;
                        await setState(page, { messages });
                        assert.equal(await page.locator(".reasoning").getAttribute("open"), "");
                        assert.equal(await page.locator(".tool-card").getAttribute("open"), "");
                        assert.equal(await page.locator(".tool-state").textContent(), "Completed");
                        assert.equal(await page.locator(".tool-output").textContent(), "first output\nsecond output");
                    });
                },
            );

            await t.test(
                "tools open by default and preserve manual toggles through streaming and completion",
                async () => {
                    for (const width of [280, 390, 768, 1200]) {
                        await withPage(browser, fixtures, { name: `tool-default-${width}`, width }, async (page) => {
                            const message = {
                                id: "tool-stream",
                                role: "tool",
                                toolName: "browser_screenshot",
                                input: '{ "fullPage": false }',
                                text: "",
                                isRunning: true,
                            };
                            const tool = page.locator('[data-message-id="tool-stream"] .tool-card');
                            await setState(page, { status: "busy", messages: [message] });
                            assert.equal(await tool.getAttribute("open"), "");
                            assert.equal(await tool.locator(".tool-input").isVisible(), true);
                            assert.equal(await tool.locator(".tool-output").textContent(), "Waiting for output…");
                            message.text = "Capturing screenshot.";
                            await setState(page, { status: "busy", messages: [message] });
                            assert.equal(await tool.getAttribute("open"), "");
                            await tool.locator("summary").focus();
                            await page.keyboard.press("Enter");
                            message.text += " Capture in progress.";
                            await setState(page, { status: "busy", messages: [message] });
                            assert.equal(await tool.getAttribute("open"), null);
                            assert.equal(await tool.locator(".tool-output").isVisible(), false);
                            message.isRunning = false;
                            message.text = "Screenshot captured.";
                            message.images = [{ type: "image", ...imageFixture() }];
                            await setState(page, { messages: [message] });
                            assert.equal(await tool.getAttribute("open"), null);
                            assert.equal(await tool.locator("img").isVisible(), false);
                            await tool.locator("summary").focus();
                            await page.keyboard.press("Enter");
                            await assertImageLoaded(tool.locator("img"));
                            assert.equal(await tool.locator(".tool-state").textContent(), "Completed");
                            await setState(page, {
                                messages: [
                                    message,
                                    { id: "failed-tool", role: "tool", text: "Synthetic failure", isError: true },
                                ],
                            });
                            assert.equal(await tool.getAttribute("open"), "");
                            assert.equal(await page.locator(".tool-card.is-error").getAttribute("open"), "");
                            assert.equal(await page.locator(".tool-card.is-error .tool-output").isVisible(), true);
                            await setState(page, { messages: [] });
                            await setState(page, { messages: [{ ...message, text: "" }] });
                            assert.equal(await tool.getAttribute("open"), "", "Restored tools start expanded");
                            await assertImageLoaded(tool.locator("img"));
                            assert.equal(await tool.locator(".tool-output").isVisible(), false);
                            await assertLayout(page, width);
                            await page.screenshot({ path: path.join(screenshots, `tool-default-${width}.png`) });
                        });
                    }
                },
            );

            await t.test("thinking opens on first arrival and preserves manual toggles during streaming", async () => {
                await withPage(browser, fixtures, { name: "thinking-default", width: 280 }, async (page) => {
                    const message = { id: "thinking-stream", role: "assistant", text: "", isRunning: true };
                    await setState(page, { status: "busy", messages: [message] });
                    assert.equal(await page.locator(".reasoning").count(), 0);
                    message.thinking = "Initial thinking.";
                    await setState(page, { messages: [message] });
                    assert.equal(await page.locator(".reasoning-content").isVisible(), true);
                    await page.locator(".reasoning summary").click();
                    message.thinking += " More thinking.";
                    await setState(page, { messages: [message] });
                    assert.equal(await page.locator(".reasoning").getAttribute("open"), null);
                    assert.equal(await page.locator(".reasoning-content").isVisible(), false);
                    await page.locator(".reasoning summary").click();
                    message.text = "Completed response.";
                    message.isRunning = false;
                    await setState(page, { status: "ready", messages: [message] });
                    assert.equal(await page.locator(".reasoning-content").isVisible(), true);
                    await assertLayout(page, 280);
                });
            });

            await t.test(
                "provider limits show both installed plugins with accessible details and isolated updates",
                async () => {
                    for (const [theme, width] of [
                        ["dark", 280],
                        ["light", 390],
                        ["highcontrast", 768],
                        ["dark", 1200],
                    ]) {
                        await withPage(
                            browser,
                            fixtures,
                            { name: `provider-usage-${theme}-${width}`, theme, width },
                            async (page) => {
                                const runtimeStatus = {
                                    "aa-codex-usage": "\u001b[36mcodex\u001b[0m ▀▀▀▄▄▄▄▄▄▄ 4d",
                                    "provider-usage": "claude 25% 5h · 40% 7d (3m old)",
                                    "another-extension": "Other runtime status",
                                };
                                await setState(page, { runtimeStatus, messages: sampleMessages() });
                                const details = page.locator("#provider-usage");
                                const summary = details.locator("summary");
                                assert.equal(await details.isVisible(), true);
                                assert.equal(await page.locator(".provider-usage-value").count(), 2);
                                assert.match(await summary.textContent(), /codex.*claude/su);
                                assert.doesNotMatch(await summary.textContent(), /\u001b/u);
                                assert.equal(await page.locator("#runtime-count").textContent(), "1");
                                assert.equal(await page.locator("#provider-usage-values").isVisible(), false);
                                const tokens = await page.locator("#token-status").textContent();
                                await summary.focus();
                                await summary.press("Enter");
                                assert.equal(await page.locator("#provider-usage-values").isVisible(), true);
                                assert.match(
                                    await page.locator("#provider-usage-values").textContent(),
                                    /@llblab\/pi-codex-usage/u,
                                );
                                assert.match(
                                    await page.locator("#provider-usage-values").textContent(),
                                    /@sreetej510\/pi-usage/u,
                                );
                                runtimeStatus["provider-usage"] = "usage rate-limited (3m)";
                                await setState(page, { status: "busy", runtimeStatus, messages: sampleMessages() });
                                assert.equal(await details.getAttribute("open"), "");
                                assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
                                assert.match(await summary.textContent(), /rate-limited/u);
                                assert.equal(await page.locator("#token-status").textContent(), tokens);
                                assert.deepEqual(
                                    await takeMessages(page),
                                    [],
                                    "Opening details must not run a command or query a provider",
                                );
                                await assertLayout(page, width);
                                if (theme === "dark") {
                                    await page.screenshot({
                                        path: path.join(screenshots, `provider-usage-${width}.png`),
                                    });
                                }

                                await setState(page, {
                                    contextToken: "different-chat",
                                    runtimeStatus: { "provider-usage": "checking" },
                                });
                                assert.equal(await page.locator(".provider-usage-value").count(), 1);
                                assert.doesNotMatch(
                                    await page.locator("#provider-usage-values").textContent(),
                                    /4d|rate-limited/u,
                                );
                                for (const status of ["error", "disconnected"]) {
                                    await setState(page, { status, runtimeStatus });
                                    assert.equal(await details.isVisible(), false);
                                    assert.equal(await page.locator("#provider-usage-values").textContent(), "");
                                }

                                await setState(page, { runtimeStatus: {} });
                                assert.equal(await details.isVisible(), false);
                                await setState(page, {
                                    runtimeStatus: {
                                        "provider-usage":
                                            '<img src="https://example.invalid/quota" onerror="window.quotaAttack=true">',
                                    },
                                });
                                await summary.click();
                                assert.equal(await details.locator("img, script, a").count(), 0);
                                assert.match(await page.locator("#provider-usage-values").textContent(), /<img/u);
                                assert.equal(await page.evaluate(() => window.quotaAttack), undefined);
                            },
                        );
                    }
                },
            );

            await t.test(
                "wide sidebar status panels stay in the conversation and composer column during resize",
                async () => {
                    for (const theme of ["dark", "light", "highcontrast"]) {
                        await withPage(
                            browser,
                            fixtures,
                            { name: `wide-column-${theme}`, theme, width: 1400 },
                            async (page) => {
                                await setState(page, {
                                    status: "busy",
                                    messages: sampleMessages(),
                                    runtimeStatus: {
                                        "aa-codex-usage": "codex 34% 6d",
                                        "specpi-command-guard": "Guard enabled",
                                        "specpi-delegation": "Delegate 0/2 workers · 54/256 calls",
                                    },
                                });
                                await page.locator("#runtime-details summary").click();
                                await page.locator("#composer-input").fill("Keep this draft while resizing");
                                for (const width of [1400, 2200, 768, 390, 1200]) {
                                    await page.setViewportSize({ width, height: 900 });
                                    const boxes = await page.evaluate(() =>
                                        Object.fromEntries(
                                            [
                                                "#composer",
                                                ".footer-panels",
                                                "#runtime-details",
                                                "#provider-usage",
                                                "#conversation",
                                                "#activity",
                                            ].map((selector) => {
                                                const rect = document.querySelector(selector).getBoundingClientRect();

                                                return [
                                                    selector,
                                                    { left: rect.left, right: rect.right, width: rect.width },
                                                ];
                                            }),
                                        ),
                                    );
                                    const composer = boxes["#composer"];
                                    for (const selector of [".footer-panels", "#runtime-details", "#provider-usage"]) {
                                        const panel = boxes[selector];
                                        assert.ok(
                                            panel.left >= composer.left - 1 && panel.right <= composer.right + 1,
                                            `${selector} must stay inside the composer column at ${width}px: ${JSON.stringify(boxes)}`,
                                        );
                                        assert.ok(
                                            panel.width >= composer.width - 6,
                                            `${selector} must not shrink to its text`,
                                        );
                                    }

                                    if (width >= 1000) {
                                        for (const selector of ["#conversation", "#activity"]) {
                                            assert.ok(
                                                Math.abs(boxes[selector].left - composer.left) <= 1 &&
                                                    Math.abs(boxes[selector].right - composer.right) <= 1,
                                                `${selector} must align with the composer despite the transcript scrollbar`,
                                            );
                                        }
                                    }

                                    assert.equal(await page.locator("#runtime-details").getAttribute("open"), "");
                                    assert.equal(
                                        await page.locator("#composer-input").inputValue(),
                                        "Keep this draft while resizing",
                                    );
                                    await assertLayout(page, width);
                                    if (width === 1400 || width === 2200) {
                                        await page.screenshot({
                                            path: path.join(screenshots, `wide-column-${theme}-${width}.png`),
                                        });
                                    }
                                }

                                assert.deepEqual(
                                    await takeMessages(page),
                                    [],
                                    "Resizing must not send the draft or query runtime status",
                                );
                            },
                        );
                    }
                },
            );

            await t.test("refreshing status preserves newer drafts without resending an accepted prompt", async () => {
                await withPage(browser, fixtures, { name: "recovery" }, async (page) => {
                    await setState(page);
                    await sendHost(page, { type: "draft", text: "Review this synthetic change." });
                    const input = page.locator("#composer-input");
                    assert.equal(await input.inputValue(), "Review this synthetic change.");
                    await input.press("Enter");
                    assert.deepEqual(await takeMessages(page), [
                        { type: "send", text: "Review this synthetic change.", mode: "prompt" },
                    ]);
                    const messages = [{ id: "accepted", role: "user", text: "Review this synthetic change." }];
                    await setState(page, { messages });
                    await input.fill("A newer unsent follow-up.");
                    await setState(page, { messages, error: "Synthetic status refresh failure." });
                    assert.equal(await page.locator("#error-banner").isVisible(), true);
                    assert.equal(await page.locator("#error-retry").textContent(), "Refresh status");
                    await page.locator("#error-retry").click();
                    assert.equal(await input.inputValue(), "A newer unsent follow-up.");
                    assert.deepEqual(await takeMessages(page), [{ type: "refresh" }]);
                    await setState(page, { messages });
                    assert.equal(await input.inputValue(), "A newer unsent follow-up.");
                    assert.deepEqual(await takeMessages(page), []);
                    await input.fill("");
                    await setState(page, { messages, error: "Another synthetic status refresh failure." });
                    await page.locator("#error-retry").click();
                    assert.equal(
                        await input.inputValue(),
                        "",
                        "Refreshing with an empty draft must not resurrect the accepted prompt",
                    );
                    assert.deepEqual(await takeMessages(page), [{ type: "refresh" }]);
                    await setState(page, { status: "error", error: "Synthetic process disconnected." });
                    await page.locator("#error-retry").click();
                    await page.locator("#error-dismiss").click();
                    assert.deepEqual(await takeMessages(page), [{ type: "connect" }, { type: "clearError" }]);
                });
            });

            await t.test(
                "retrying and compacting keep activity controls available and show readable runtime status",
                async () => {
                    await withPage(browser, fixtures, { name: "runtime-status", width: 280 }, async (page) => {
                        for (const [status, label, activity] of [
                            ["retrying", "Retrying", "Pi is retrying the request"],
                            ["compacting", "Compacting", "Pi is compacting context"],
                        ]) {
                            await setState(page, {
                                status,
                                messages: sampleMessages(),
                                runtimeStatus: {
                                    guard: "\u001b[32mCommand Guard enabled\u001b[0m",
                                    note: "<img onerror=alert(1)> is literal",
                                    ignored: 42,
                                },
                            });
                            assert.equal(await page.locator("#connection-label").textContent(), label);
                            assert.equal(await page.locator("#activity-label").textContent(), activity);
                            assert.equal(await page.locator("#activity").isVisible(), true);
                            assert.equal(await page.locator("#stop-button").isVisible(), true);
                            assert.equal(await page.locator("#send-mode").isVisible(), true);
                            assert.equal(await page.locator("#model-select").isDisabled(), true);
                            assert.equal(await page.locator("#thinking-select").isDisabled(), true);
                            assert.equal(await page.locator("#choose-workspace").isEnabled(), true);
                            assert.equal(await page.locator("#connect-button").isVisible(), false);
                            await page.locator("#composer-input").fill(`Guide the ${status} turn`);
                            await page.locator("#composer-input").press("Enter");
                            await page.locator("#stop-button").click();
                            assert.deepEqual(await takeMessages(page), [
                                { type: "send", text: `Guide the ${status} turn`, mode: "steer" },
                                { type: "stop" },
                            ]);
                        }

                        assert.equal(await page.locator("#runtime-details").isVisible(), true);
                        assert.equal(await page.locator("#runtime-count").textContent(), "2");
                        await page.locator("#runtime-details summary").click();
                        assert.deepEqual(await page.locator("#runtime-values dt").allTextContents(), ["guard", "note"]);
                        assert.deepEqual(await page.locator("#runtime-values dd").allTextContents(), [
                            "Command Guard enabled",
                            "<img onerror=alert(1)> is literal",
                        ]);
                        assert.equal(await page.locator("#runtime-values img").count(), 0);
                        await assertLayout(page, 280);
                        await page.screenshot({ path: path.join(screenshots, "runtime-status-280.png") });
                        await setState(page);
                        assert.equal(await page.locator("#runtime-details").isVisible(), false);
                        assert.equal(await page.locator("#stop-button").isVisible(), false);
                    });
                },
            );

            await t.test(
                "restoring failed drafts preserves newer text and rejects oversized combined drafts",
                async () => {
                    await withPage(browser, fixtures, { name: "draft-restoration" }, async (page) => {
                        await setState(page);
                        const input = page.locator("#composer-input");
                        assert.equal(await input.getAttribute("maxlength"), "65536");
                        await input.fill("A newer unsent follow-up.");
                        await sendHost(page, { type: "draft", mode: "restore", text: "The failed original message." });
                        assert.equal(
                            await input.inputValue(),
                            "The failed original message.\n\nA newer unsent follow-up.",
                        );
                        assert.deepEqual(await takeMessages(page), []);
                        await sendHost(page, { type: "draft", text: "An intentional replacement." });
                        assert.equal(await input.inputValue(), "An intentional replacement.");
                        await sendHost(page, { type: "draft", mode: "restore", text: "An intentional replacement." });
                        assert.equal(await input.inputValue(), "An intentional replacement.");
                        const largeOriginal = "x".repeat(65530);
                        await sendHost(page, { type: "draft", mode: "restore", text: largeOriginal });
                        assert.equal(await input.inputValue(), `${largeOriginal}\n\nAn intentional replacement.`);
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        assert.equal(await input.getAttribute("aria-invalid"), "true");
                        assert.match(await page.locator("#composer-hint").textContent(), /65,536.*shorten/u);
                        await input.press("Enter");
                        assert.deepEqual(await takeMessages(page), []);
                        await sendHost(page, { type: "draft", text: `${" ".repeat(65536)}A short message` });
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        await input.press("Enter");
                        assert.deepEqual(
                            await takeMessages(page),
                            [],
                            "Enter must honor the same raw-length limit as Send",
                        );
                        await input.fill("Shortened safely.");
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                        assert.equal(await input.getAttribute("aria-invalid"), "false");
                        await input.press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "send", text: "Shortened safely.", mode: "prompt" },
                        ]);
                    });
                },
            );
            await t.test(
                "chat action and conversation search buttons retain their native keyboard behavior",
                async () => {
                    await withPage(browser, fixtures, { name: "extras-keyboard", width: 280 }, async (page) => {
                        const messages = [
                            { id: "search-first", role: "user", text: "Alpha one" },
                            { id: "search-last", role: "assistant", text: "Alpha two" },
                        ];
                        for (const [status, action] of [
                            ["ready", "editPrompt"],
                            ["busy", "exportChat"],
                        ]) {
                            await setState(page, { status, messages });
                            await page.locator("#chat-actions-button").focus();
                            await page.keyboard.press("ArrowDown");
                            assert.equal(
                                await page.evaluate(() => document.activeElement?.dataset.action),
                                action,
                                "Opening with ArrowDown must focus the first enabled item once",
                            );
                            await page.keyboard.press("Escape");
                            assert.equal(await page.locator("#chat-actions-menu").isVisible(), false);
                        }

                        await setState(page, { messages });
                        await page.locator("#composer-input").focus();
                        await page.keyboard.press("Control+f");
                        const search = page.locator("#conversation-search");
                        assert.equal(await search.isVisible(), true);
                        await search.getByRole("searchbox", { name: "Search messages", exact: true }).fill("Alpha");
                        assert.equal(
                            await page.locator(".extras-search-match").getAttribute("data-message-id"),
                            "search-first",
                        );
                        await search.getByRole("button", { name: "Previous matching message", exact: true }).focus();
                        await page.keyboard.press("Enter");
                        assert.equal(
                            await page.locator(".extras-search-match").getAttribute("data-message-id"),
                            "search-last",
                        );
                        await search.getByRole("button", { name: "Close conversation search", exact: true }).focus();
                        await page.keyboard.press("Enter");
                        assert.equal(await search.isVisible(), false);
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            await t.test(
                "delegate progress preserves focus, details and draft while Stop waits for real settlement",
                async () => {
                    await withPage(
                        browser,
                        fixtures,
                        { name: "delegate-progress-controls", width: 390 },
                        async (page) => {
                            const delegation = sampleDelegates();
                            const commands = [{ name: "delegate" }];
                            await setState(page, { delegation, commands, status: "busy" });
                            const input = page.locator("#composer-input");
                            await input.fill("Keep my unsent draft");
                            const details = page.locator("#delegates-panel");
                            await details.locator(".delegates-header").click();
                            const stop = page.getByRole("button", { name: "Stop delegate review-api", exact: true });
                            await stop.focus();
                            delegation.jobs[0].elapsedMs += 1000;
                            delegation.jobs[0].tools += 1;
                            await setState(page, { delegation, commands, status: "busy", sending: true });
                            assert.equal(
                                await stop.isEnabled(),
                                true,
                                "Worker Stop must remain available while the parent prompt is pending",
                            );
                            assert.equal(await stop.evaluate((node) => node === document.activeElement), true);
                            assert.equal(await details.getAttribute("open"), "");
                            assert.equal(await input.inputValue(), "Keep my unsent draft");
                            await stop.press("Enter");
                            assert.deepEqual(await takeMessages(page), [
                                {
                                    type: "stopDelegate",
                                    batchId: "batch-1",
                                    jobId: "review-api",
                                    attemptId: "attempt-1",
                                    contextToken: "fixture-context-1",
                                },
                            ]);
                            delegation.jobs[0].stopPending = true;
                            await setState(page, { delegation, commands, status: "busy" });
                            assert.equal(await stop.isDisabled(), true);
                            assert.equal(
                                await page
                                    .locator(".delegates-header")
                                    .evaluate((node) => node === document.activeElement),
                                true,
                            );
                            delegation.jobs[0].state = "cancelled";
                            await setState(page, { delegation, commands, status: "ready" });
                            assert.equal(await page.locator(".delegate-state").first().textContent(), "Stopping");
                            assert.equal(await page.locator(".delegates-count").textContent(), "1 agent stopping");
                            assert.equal(await stop.isVisible(), false);
                            delegation.jobs[0].settling = false;
                            delegation.active = 0;
                            await setState(page, { delegation, commands });
                            assert.equal(await page.locator("#delegates-panel").isVisible(), false);
                            assert.equal(await page.locator(".delegate-worker").count(), 0);
                            assert.equal(await input.inputValue(), "Keep my unsent draft");
                            await setState(page, {
                                delegation: sampleDelegates(),
                                commands,
                                conversationKey: "other-chat",
                                contextToken: "other-context",
                            });
                            assert.equal(await page.locator("#delegates-panel").getAttribute("open"), null);
                            await setState(page, { status: "disconnected" });
                            assert.equal(await page.locator("#delegates-panel").isVisible(), false);
                        },
                    );
                },
            );

            await t.test(
                "delegate strip shows only live work and resets after idle without losing the draft",
                async () => {
                    await withPage(browser, fixtures, { name: "delegate-live-only", width: 390 }, async (page) => {
                        const delegation = sampleDelegates();
                        const commands = [{ name: "delegate" }];
                        const panel = page.locator("#delegates-panel");
                        const header = page.locator(".delegates-header");
                        const input = page.locator("#composer-input");
                        await setState(page, { delegation, commands });
                        await input.fill("Keep this draft");
                        assert.equal(await panel.getAttribute("open"), null);
                        assert.equal(await page.locator(".delegate-worker").count(), 1);
                        assert.equal(
                            await page
                                .locator(".delegates-pulse")
                                .evaluate((node) => getComputedStyle(node).animationName),
                            "none",
                        );
                        await header.focus();
                        await header.press("Enter");
                        assert.equal(await panel.getAttribute("open"), "");
                        delegation.jobs[1].state = "running";
                        delegation.jobs[1].settling = true;
                        delegation.active = 2;
                        await setState(page, { delegation, commands });
                        assert.equal(await page.locator(".delegates-count").textContent(), "2 agents working");
                        assert.equal(await page.locator(".delegate-worker").count(), 2);
                        assert.equal(await panel.getAttribute("open"), "");
                        await assertLayout(page, 390);
                        await page.screenshot({ path: path.join(screenshots, "delegates-two-running.png") });
                        delegation.jobs[0].state = "complete";
                        await setState(page, { delegation, commands });
                        assert.equal(await page.locator(".delegate-state").first().textContent(), "Finishing");
                        const remainingStop = page.getByRole("button", {
                            name: "Stop delegate review-tests",
                            exact: true,
                        });
                        await remainingStop.focus();
                        delegation.jobs[0].settling = false;
                        delegation.jobs[0].disposition = "accept";
                        delegation.active = 1;
                        await setState(page, { delegation, commands });
                        assert.equal(await page.locator(".delegate-worker").count(), 1);
                        assert.ok(!(await panel.textContent()).includes("Parent accepted"));
                        assert.equal(await remainingStop.evaluate((node) => node === document.activeElement), true);
                        await header.focus();
                        delegation.jobs[1].state = "complete";
                        delegation.jobs[1].settling = false;
                        delegation.active = 0;
                        await setState(page, { delegation, commands });
                        assert.equal(await panel.isVisible(), false);
                        assert.equal(await input.evaluate((node) => node === document.activeElement), true);
                        assert.equal(await input.inputValue(), "Keep this draft");
                        delegation.jobs[1].state = "queued";
                        await setState(page, { delegation, commands });
                        assert.equal(await panel.isVisible(), false, "queued-only metadata is not running work");
                        // Revoked generations can retain occupied requests without exposing old task labels.
                        delegation.jobs = [];
                        delegation.active = 1;
                        delegation.enabled = false;
                        await setState(page, { delegation, commands });
                        assert.equal(await panel.isVisible(), true);
                        assert.equal(await panel.getAttribute("open"), null);
                        assert.equal(await page.locator(".delegates-count").textContent(), "1 agent stopping");
                        await header.press("Space");
                        assert.equal(await page.locator(".delegates-note").isVisible(), true);
                        assert.equal(await page.locator(".delegate-worker").count(), 0);
                        await setState(page, {
                            delegation: sampleDelegates(),
                            commands,
                            contextToken: "new-generation",
                        });
                        assert.equal(await panel.getAttribute("open"), null);
                        await setState(page, { status: "disconnected", delegation, commands });
                        assert.equal(await panel.isVisible(), false);
                        assert.equal(await input.inputValue(), "Keep this draft");
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            await t.test(
                "delegate generation replacement hands off worker focus without stealing composer focus",
                async () => {
                    await withPage(
                        browser,
                        fixtures,
                        { name: "delegate-generation-focus", width: 390 },
                        async (page) => {
                            const commands = [{ name: "delegate" }];
                            for (const replacement of [sampleDelegates(), null]) {
                                await setState(page, {
                                    delegation: sampleDelegates(),
                                    commands,
                                    contextToken: "before",
                                });
                                await page.locator(".delegates-header").click();
                                await page.locator(".delegate-stop").focus();
                                await setState(page, { delegation: replacement, commands, contextToken: "after" });
                                const target = replacement ? ".delegates-header" : "#composer-input";
                                assert.equal(
                                    await page.locator(target).evaluate((node) => node === document.activeElement),
                                    true,
                                );
                            }

                            const input = page.locator("#composer-input");
                            await input.fill("Do not steal focus");
                            await setState(page, { delegation: sampleDelegates(), commands, contextToken: "another" });
                            assert.equal(await input.evaluate((node) => node === document.activeElement), true);
                            assert.equal(await input.inputValue(), "Do not steal focus");
                        },
                    );
                },
            );

            await t.test("delegate reports render readable summaries and keep request JSON collapsed", async () => {
                await withPage(browser, fixtures, { name: "delegate-reports", width: 280 }, async (page) => {
                    const details = {
                        jobs: [{ jobId: "review-api", state: "complete", settling: false, calls: 2 }],
                        results: [
                            {
                                receipt: { jobId: "review-api" },
                                result: {
                                    status: "complete",
                                    answer: "A synthetic advisory result.",
                                    findings: [{ claim: "Handle the empty input." }],
                                    nextStep: "Add a test.",
                                },
                            },
                        ],
                    };
                    const messages = createState({
                        messages: [
                            {
                                role: "toolResult",
                                toolCallId: "delegate-report",
                                toolName: "delegate",
                                content: [{ type: "text", text: JSON.stringify(details) }],
                                details,
                                input: JSON.stringify({ operation: "collect", batchId: "batch-1" }),
                            },
                        ],
                    }).messages;
                    await setState(page, { messages });
                    assert.match(await page.locator(".delegate-output").textContent(), /A synthetic advisory result/);
                    assert.equal(await page.locator(".delegate-input").getAttribute("open"), null);
                    assert.equal(await page.locator(".tool-state").textContent(), "Reported");
                    await page.locator(".delegate-input summary").click();
                    messages[0].text += "\nUpdated advisory.";
                    await setState(page, { messages });
                    assert.equal(await page.locator(".delegate-input").getAttribute("open"), "");
                    const delegation = sampleDelegates();
                    delegation.jobs[0].task = "<img src=x onerror=alert(1)>";
                    await setState(page, { messages, delegation, commands: [{ name: "delegate" }] });
                    await page.locator(".delegates-header").click();
                    assert.equal(await page.locator("#delegates-panel img").count(), 0);
                    assert.equal(await page.locator(".delegate-task").first().textContent(), delegation.jobs[0].task);
                    for (const state of [
                        "complete",
                        "failed",
                        "partial",
                        "needs_context",
                        "expired",
                        "stale",
                        "cancelled",
                    ]) {
                        delegation.jobs[0].state = state;
                        delegation.jobs[0].settling = false;
                        delegation.active = 0;
                        await setState(page, { messages, delegation });
                        assert.equal(await page.locator("#delegates-panel").isVisible(), false, state);
                        assert.equal(await page.locator(".delegate-worker").count(), 0, state);
                        assert.match(
                            await page.locator(".delegate-output").textContent(),
                            /A synthetic advisory result/,
                        );
                    }

                    await assertLayout(page, 280);
                });
            });

            await t.test(
                "file mentions stay as compact tags from composer selection through sent transcript refresh",
                async () => {
                    await withPage(browser, fixtures, { name: "file-mention-tags" }, async (page) => {
                        await setState(page);
                        const input = page.locator("#composer-input");
                        await input.fill("Inspect @src");
                        const search = await imageMessage(page, "findFiles");
                        await sendHost(page, {
                            type: "fileSuggestions",
                            requestId: search.requestId,
                            files: [{ path: "src/sidebar.js", label: "src/sidebar.js" }],
                        });
                        await input.press("Enter");
                        const attachment = await imageMessage(page, "attachMention");
                        const selected = {
                            id: "selected",
                            label: "src/sidebar.js",
                            detail: "File",
                            text: "const sourceMustNotRender = true;",
                        };
                        await setState(page, {
                            attachments: [{ id: selected.id, label: selected.label, detail: selected.detail }],
                        });
                        await sendHost(page, {
                            type: "attachmentResult",
                            requestId: attachment.requestId,
                            success: true,
                        });
                        assert.equal(await input.inputValue(), "Inspect @src/sidebar.js ");
                        assert.equal(
                            await page.locator("#attachments .attachment-label").textContent(),
                            selected.label,
                        );
                        assert.equal(
                            await page.getByRole("button", { name: "Remove src/sidebar.js", exact: true }).isVisible(),
                            true,
                        );
                        await input.press("Enter");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "send", text: "Inspect @src/sidebar.js", mode: "prompt" },
                        ]);
                        const messages = createState({
                            messages: [
                                {
                                    id: "tagged-user",
                                    role: "user",
                                    content: formatPrompt("Inspect @src/sidebar.js", [selected]),
                                },
                            ],
                        }).messages;
                        for (const status of ["busy", "ready"]) {
                            await setState(page, { status, messages });
                            assert.equal(await page.locator("#attachments").isVisible(), false);
                            assert.equal(
                                await page.locator(".message-user .message-body").textContent(),
                                "Inspect @src/sidebar.js",
                            );
                            assert.equal(
                                await page.getByRole("list", { name: "Attached files" }).getByRole("listitem").count(),
                                1,
                            );
                            assert.equal(
                                await page.locator(".message-files .attachment-label").textContent(),
                                selected.label,
                            );
                            assert.ok(!(await page.locator("#conversation").textContent()).includes(selected.text));
                        }

                        await page.locator(".message-user").hover();
                        await page.locator(".message-copy").click();
                        const copy = await imageMessage(page, "copy");
                        assert.equal(copy.text, "Inspect @src/sidebar.js");
                        await sendHost(page, { type: "copyResult", requestId: copy.requestId, success: true });
                        messages[0].files[0].label = "src/updated.js";
                        await setState(page, { messages });
                        assert.equal(
                            await page.locator(".message-files .attachment-label").textContent(),
                            "src/updated.js",
                            "File metadata must invalidate the message render cache",
                        );
                    });
                },
            );

            await t.test(
                "file mentions ignore Shift+Tab and stale attachment replies after a host draft replacement",
                async () => {
                    await withPage(browser, fixtures, { name: "extras-mention-races" }, async (page) => {
                        await setState(page);
                        const input = page.locator("#composer-input");
                        const draft = "Inspect @src";
                        const suggest = async () => {
                            await input.fill(draft);
                            const request = await imageMessage(page, "findFiles");
                            assert.equal(request.query, "src");
                            await sendHost(page, {
                                type: "fileSuggestions",
                                requestId: request.requestId,
                                files: [{ path: "src/sidebar.js", label: "src/sidebar.js" }],
                            });
                            assert.equal(await page.locator("#file-mention-menu").isVisible(), true);
                        };

                        await suggest();
                        await input.press("Shift+Tab");
                        assert.deepEqual(await takeMessages(page), []);
                        assert.equal(await input.inputValue(), draft);
                        await suggest();
                        await input.press("Enter");
                        const stale = await imageMessage(page, "attachMention");
                        assert.equal(stale.path, "src/sidebar.js");
                        await sendHost(page, { type: "draft", text: draft });
                        await sendHost(page, { type: "attachmentResult", requestId: stale.requestId });
                        assert.equal(
                            await input.inputValue(),
                            draft,
                            "Even an identical replacement draft invalidates earlier attachment acknowledgments",
                        );
                        assert.deepEqual(await takeMessages(page), []);
                        await suggest();
                        await input.press("Enter");
                        const accepted = await imageMessage(page, "attachMention");
                        await sendHost(page, { type: "attachmentResult", requestId: accepted.requestId });
                        assert.equal(await input.inputValue(), "Inspect @src/sidebar.js ");
                        assert.deepEqual(await takeMessages(page), []);
                        await suggest();
                        await setState(page, { contextToken: "different-ready-conversation" });
                        assert.equal(await page.locator("#file-mention-menu").isVisible(), false);
                        await input.press("Enter");
                        assert.deepEqual(await takeMessages(page), [{ type: "send", text: draft, mode: "prompt" }]);
                    });
                },
            );

            for (const theme of Object.keys(themes)) {
                for (const width of [280, 390]) {
                    await t.test(
                        `image attachments and transcript thumbnails fit the ${theme} ${width}px sidebar`,
                        async () => {
                            await withPage(
                                browser,
                                fixtures,
                                { name: `images-${theme}-${width}`, theme, width },
                                async (page) => {
                                    const image = { type: "image", ...imageFixture() };
                                    await setState(page, {
                                        model: visionModel(),
                                        models: [visionModel()],
                                        attachments: [imageAttachment()],
                                        messages: [
                                            {
                                                id: "image-user",
                                                role: "user",
                                                text: "Inspect this synthetic reference.",
                                                images: [image],
                                            },
                                            {
                                                id: "image-assistant",
                                                role: "assistant",
                                                text: "The reference contains blue checkerboard tiles.",
                                                images: [image],
                                            },
                                            {
                                                id: "image-tool",
                                                role: "tool",
                                                toolName: "read",
                                                text: "Synthetic image loaded.",
                                                images: [image],
                                            },
                                        ],
                                    });
                                    await assertImageLoaded(page.locator("#attachments .attachment-image img"));
                                    await assertImageLoaded(page.locator(".message-user .message-images img"));
                                    await assertImageLoaded(page.locator(".message-assistant .message-images img"));
                                    await assertImageLoaded(page.locator(".message-tool .message-images img"));
                                    assert.equal(await page.locator("#send-button").isEnabled(), true);
                                    await assertLayout(page, width);
                                    await page.screenshot({
                                        path: path.join(screenshots, `images-${theme}-${width}.png`),
                                    });
                                    assert.deepEqual(await takeMessages(page), []);
                                },
                            );
                        },
                    );
                }
            }

            await t.test(
                "image-only prompts and thumbnail removal keep attachment data authoritative in the host",
                async () => {
                    await withPage(browser, fixtures, { name: "image-only-send" }, async (page) => {
                        const attachments = [imageAttachment()];
                        await setState(page, { model: visionModel(), models: [visionModel()], attachments });
                        assert.equal(await page.locator("#composer-input").inputValue(), "");
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                        await page.getByRole("button", { name: "Remove Synthetic image", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [{ type: "removeAttachment", id: "image-1" }]);
                        assert.equal(
                            await page.locator("#attachments img").count(),
                            1,
                            "Removal waits for the host state update",
                        );
                        await setState(page, { model: visionModel(), models: [visionModel()], attachments: [] });
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        await setState(page, { model: visionModel(), models: [visionModel()], attachments });
                        await page.locator("#composer-input").press("Enter");
                        const messages = await takeMessages(page);
                        assert.equal(messages.length, 1);
                        assert.equal(messages[0].type, "send");
                        assert.equal(messages[0].text, "");
                        assert.equal(messages[0].mode, "prompt");
                        assert.equal(
                            messages[0].images,
                            undefined,
                            "The host supplies accepted image data from its attachments",
                        );
                    });
                },
            );

            await t.test(
                "image submissions wait for the matching host acknowledgment and cannot be duplicated",
                async () => {
                    await withPage(browser, fixtures, { name: "image-submission-latch" }, async (page) => {
                        const attachments = [imageAttachment()];
                        await setState(page, { model: visionModel(), attachments });
                        const input = page.locator("#composer-input");
                        await input.press("Enter");
                        const [first] = await takeMessages(page, { acknowledgeSends: false });
                        assert.equal(first.type, "send");
                        assert.equal(first.text, "");
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        await input.press("Enter");
                        await setState(page, { model: visionModel(), attachments });
                        await sendHost(page, { type: "sendResult", requestId: "unrelated-submission", accepted: true });
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        assert.deepEqual(await takeMessages(page), []);
                        await sendHost(page, { type: "sendResult", requestId: first.requestId, accepted: false });
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                        await input.press("Enter");
                        const [second] = await takeMessages(page, { acknowledgeSends: false });
                        assert.equal(second.type, "send");
                        assert.notEqual(second.requestId, first.requestId);
                        await input.fill("A newer draft written during submission.");
                        await setState(page, { model: visionModel(), attachments: [] });
                        assert.equal(await page.locator("#send-button").isDisabled(), true);
                        await sendHost(page, { type: "sendResult", requestId: second.requestId, accepted: true });
                        assert.equal(await input.inputValue(), "A newer draft written during submission.");
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            await t.test(
                "image media is reused across state updates and pruned references cannot resurrect bytes",
                async () => {
                    await withPage(browser, fixtures, { name: "image-media-cache" }, async (page) => {
                        const mediaId = "synthetic-cached-image";
                        const attachment = {
                            id: "cached-attachment",
                            kind: "image",
                            label: "Cached image",
                            mediaId,
                            mimeType: "image/png",
                            width: 32,
                            height: 24,
                        };
                        const message = {
                            id: "cached-message",
                            role: "assistant",
                            text: "Cached image fixture.",
                            images: [{ type: "image", mediaId, mimeType: "image/png", width: 32, height: 24 }],
                        };
                        const state = readyState({
                            model: visionModel(),
                            attachments: [attachment],
                            messages: [message],
                        });
                        await sendHost(page, {
                            type: "state",
                            state,
                            media: [{ id: mediaId, ...imageFixture() }],
                            retainedMediaIds: [mediaId],
                        });
                        await assertImageLoaded(page.locator("#attachments img"));
                        await assertImageLoaded(page.locator(".message-assistant .message-images img"));
                        const originalSource = await page.locator("#attachments img").getAttribute("src");
                        for (const status of ["busy", "retrying", "ready"]) {
                            await sendHost(page, {
                                type: "state",
                                state: { ...state, status },
                                media: [],
                                retainedMediaIds: [mediaId],
                            });
                            await assertImageLoaded(page.locator("#attachments img"));
                            assert.equal(await page.locator("#attachments img").getAttribute("src"), originalSource);
                            await assertImageLoaded(page.locator(".message-assistant .message-images img"));
                        }

                        await sendHost(page, { type: "state", state: readyState(), media: [], retainedMediaIds: [] });
                        assert.equal(await page.locator("#attachments img, #conversation img").count(), 0);
                        await sendHost(page, { type: "state", state, media: [], retainedMediaIds: [mediaId] });
                        assert.equal(
                            await page.locator("#attachments img, #conversation img").count(),
                            0,
                            "A retained identifier alone cannot recover bytes already pruned from the cache",
                        );
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            await t.test(
                "known text-only models block image sending until a capable host model is selected",
                async () => {
                    await withPage(
                        browser,
                        fixtures,
                        { name: "image-model-compatibility", width: 280 },
                        async (page) => {
                            const textModel = {
                                provider: "fixture",
                                id: "text-only",
                                name: "Fixture Text",
                                input: ["text"],
                            };
                            const attachments = [imageAttachment()];
                            const models = [textModel, visionModel()];
                            await setState(page, { model: textModel, models, attachments });
                            await page.locator("#composer-input").fill("What is in this image?");
                            assert.equal(await page.locator("#vision-warning").isVisible(), true);
                            assert.match(await page.locator("#vision-warning").textContent(), /image/iu);
                            assert.equal(await page.locator("#send-button").isDisabled(), true);
                            await page.locator("#composer-input").press("Enter");
                            assert.deepEqual(await takeMessages(page), []);
                            await page
                                .locator("#model-select")
                                .selectOption(JSON.stringify(["fixture", "vision-model"]));
                            assert.deepEqual(await takeMessages(page), [
                                { type: "setModel", provider: "fixture", modelId: "vision-model" },
                            ]);
                            assert.equal(
                                await page.locator("#send-button").isDisabled(),
                                true,
                                "An optimistic dropdown selection must not override host capabilities",
                            );
                            await setState(page, { model: visionModel(), models, attachments });
                            assert.equal(await page.locator("#vision-warning").isVisible(), false);
                            assert.equal(await page.locator("#send-button").isEnabled(), true);
                            await setState(page, { status: "disconnected", model: null, models: [], attachments });
                            assert.equal(await page.locator("#vision-warning").isVisible(), false);
                            assert.equal(
                                await page.locator("#send-button").isEnabled(),
                                true,
                                "Unknown capability must still allow connecting with an image",
                            );
                        },
                    );
                },
            );

            await t.test(
                "image previews open by keyboard, decode real PNG bytes, and return focus after Escape",
                async () => {
                    await withPage(browser, fixtures, { name: "image-preview-keyboard", width: 280 }, async (page) => {
                        const image = { type: "image", ...imageFixture() };
                        await setState(page, {
                            model: visionModel(),
                            attachments: [imageAttachment()],
                            messages: [
                                {
                                    id: "image-preview-message",
                                    role: "assistant",
                                    text: "A synthetic image.",
                                    images: [image],
                                },
                                {
                                    id: "image-preview-tool",
                                    role: "tool",
                                    toolName: "read",
                                    text: "Image output.",
                                    images: [image],
                                },
                            ],
                        });
                        for (const selector of [
                            "#attachments .image-thumbnail",
                            ".message-assistant .image-thumbnail",
                            ".message-tool .image-thumbnail",
                        ]) {
                            if (selector.startsWith(".message-tool")) {
                                await assertImageLoaded(page.locator(".message-tool .message-images img"));
                            }

                            const thumbnail = page.locator(selector);
                            await thumbnail.focus();
                            await page.keyboard.press("Enter");
                            assert.equal(await page.locator("#image-preview").isVisible(), true);
                            await assertImageLoaded(page.locator("#image-preview-content img"));
                            if (selector.startsWith("#attachments")) {
                                await page.screenshot({ path: path.join(screenshots, "image-preview-dialog-280.png") });
                            }

                            assert.equal(await page.locator("#image-preview-close").isEnabled(), true);
                            await page.keyboard.press("Escape");
                            assert.equal(await page.locator("#image-preview").isVisible(), false);
                            assert.equal(await thumbnail.evaluate((node) => node === document.activeElement), true);
                        }

                        assert.deepEqual(
                            await takeMessages(page),
                            [],
                            "Previewing already accepted data must not ask the host to read it again",
                        );
                    });
                },
            );

            await t.test(
                "the image picker menu is keyboard accessible and waits for the attachment result",
                async () => {
                    await withPage(browser, fixtures, { name: "image-picker-menu" }, async (page) => {
                        await setState(page);
                        await page.locator("#attach-menu-button").focus();
                        await page.keyboard.press("Enter");
                        assert.equal(await page.locator("#attach-menu").isVisible(), true);
                        await page.locator("#attach-image").focus();
                        await page.keyboard.press("Enter");
                        const request = await imageMessage(page, "attachImage");
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        await setState(page, { model: visionModel(), attachments: [imageAttachment()] });
                        await sendHost(page, { type: "attachmentResult", requestId: request.requestId });
                        await assertImageLoaded(page.locator("#attachments img"));
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                    });
                },
            );

            for (const method of ["paste", "drop"]) {
                await t.test(
                    `${method} reads actual PNG files and renders thumbnails only after host acceptance`,
                    async () => {
                        await withPage(browser, fixtures, { name: `image-${method}` }, async (page) => {
                            await setState(page, { model: visionModel() });
                            assert.equal(await transferFiles(page, method, [{ name: `${method}-fixture.png` }]), true);
                            const request = await imageMessage(page, "attachImageData");
                            assert.equal(request.contextToken, "fixture-context-1");
                            assert.deepEqual(request.images, [
                                { data: imagePng, mimeType: "image/png", name: `${method}-fixture.png` },
                            ]);
                            assert.deepEqual(await page.evaluate(() => window.specpiFixtureFileReads), [
                                { size: Buffer.from(imagePng, "base64").length, type: "image/png" },
                            ]);
                            assert.equal(await page.locator("#attachments img").count(), 0);
                            assert.equal(await page.locator("#send-button").isDisabled(), true);
                            await setState(page, {
                                model: visionModel(),
                                attachments: [imageAttachment({ label: `${method}-fixture.png` })],
                            });
                            await sendHost(page, { type: "attachmentResult", requestId: request.requestId });
                            await assertImageLoaded(page.locator("#attachments img"));
                            assert.equal(await page.locator("#send-button").isEnabled(), true);
                            assert.deepEqual(await takeMessages(page), []);
                        });
                    },
                );
            }

            await t.test(
                "image ingestion rejects size, count, combined bytes, and unsupported formats before FileReader",
                async () => {
                    const cases = [
                        {
                            name: "file-too-large",
                            files: [{ size: 5 * 1024 * 1024 + 1 }],
                            pattern: /5\s*(?:MiB|MB)|large|size/iu,
                        },
                        {
                            name: "too-many-files",
                            files: Array.from({ length: 9 }, () => ({})),
                            pattern: /eight|8|count|many/iu,
                        },
                        {
                            name: "batch-too-large",
                            files: Array.from({ length: 5 }, () => ({ size: 4 * 1024 * 1024 + 1 })),
                            pattern: /20\s*(?:MiB|MB)|total|combined|batch/iu,
                        },
                        {
                            name: "attachment-count",
                            files: [{}, {}],
                            attachments: Array.from({ length: 7 }, (_, index) => ({
                                id: `text-${index}`,
                                label: `context-${index}.txt`,
                            })),
                            pattern: /eight|8|count|many/iu,
                        },
                        {
                            name: "unsupported-svg",
                            files: [{ name: "not-allowed.svg", type: "image/svg+xml" }],
                            pattern: /PNG|JPEG|GIF|WebP|format|supported/iu,
                        },
                    ];
                    for (const fixture of cases) {
                        await withPage(browser, fixtures, { name: `image-limit-${fixture.name}` }, async (page) => {
                            await setState(page, { attachments: fixture.attachments || [] });
                            await transferFiles(page, "drop", fixture.files);
                            await page.locator("#image-feedback").waitFor({ state: "visible" });
                            assert.match(await page.locator("#image-feedback-text").textContent(), fixture.pattern);
                            assert.deepEqual(await page.evaluate(() => window.specpiFixtureFileReads), []);
                            assert.deepEqual(await takeMessages(page), []);
                        });
                    }
                },
            );

            await t.test(
                "eight small images are permitted and a rejected host result preserves the existing draft",
                async () => {
                    await withPage(browser, fixtures, { name: "image-attachment-rejection" }, async (page) => {
                        await setState(page, { model: visionModel() });
                        await page.locator("#composer-input").fill("Keep my draft if image validation fails.");
                        await transferFiles(
                            page,
                            "paste",
                            Array.from({ length: 8 }, (_, index) => ({ name: `fixture-${index}.png` })),
                        );
                        const request = await imageMessage(page, "attachImageData");
                        assert.equal(request.images.length, 8);
                        assert.equal(await page.evaluate(() => window.specpiFixtureFileReads.length), 8);
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        await sendHost(page, {
                            type: "attachmentResult",
                            requestId: request.requestId,
                            error: "Synthetic host validation rejected the images.",
                        });
                        assert.equal(await page.locator("#image-feedback").isVisible(), true);
                        assert.match(
                            await page.locator("#image-feedback-text").textContent(),
                            /Synthetic host validation rejected/u,
                        );
                        assert.equal(
                            await page.locator("#composer-input").inputValue(),
                            "Keep my draft if image validation fails.",
                        );
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        assert.equal(await page.locator("#send-button").isEnabled(), true);
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            await t.test(
                "dropping workspace URI text requests host file attachment without reading in the webview",
                async () => {
                    await withPage(browser, fixtures, { name: "image-uri-drop" }, async (page) => {
                        await setState(page);
                        const uris = ["file:///synthetic/workspace/image.png", "file:///synthetic/workspace/source.js"];
                        await transferFiles(
                            page,
                            "drop",
                            [],
                            `# Synthetic workspace files\r\n${uris.join("\r\n")}\r\n`,
                        );
                        const request = await imageMessage(page, "attachDroppedFiles");
                        assert.deepEqual(request.uris, uris);
                        assert.deepEqual(await page.evaluate(() => window.specpiFixtureFileReads), []);
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        await sendHost(page, { type: "attachmentResult", requestId: request.requestId });
                        assert.deepEqual(await takeMessages(page), []);
                    });
                },
            );

            await t.test(
                "ordinary image links and code references open the image viewer, not the text editor",
                async () => {
                    await withPage(browser, fixtures, { name: "linked-image-preview", width: 390 }, async (page) => {
                        const references = [
                            [
                                "[Running preview](.specpi-test/vscode/screenshots/delegates-live-preview.png)",
                                ".specpi-test/vscode/screenshots/delegates-live-preview.png",
                            ],
                            [
                                "[Idle preview](file:///f%3A/Development/SpecPi/.specpi-test/vscode/screenshots/delegates-idle-preview.png)",
                                "file:///f%3A/Development/SpecPi/.specpi-test/vscode/screenshots/delegates-idle-preview.png",
                            ],
                            ["[Spaced preview](<artifacts/my%20preview.JPEG>)", "artifacts/my preview.JPEG"],
                            ["`artifacts/preview.webp`", "artifacts/preview.webp"],
                            ["`artifacts/preview.png:1`", "artifacts/preview.png:1"],
                            ["[Preview](artifacts/preview.png#L1)", "artifacts/preview.png#L1"],
                            ["[Animation](artifacts/preview.gif)", "artifacts/preview.gif"],
                            ["[Photo](artifacts/preview.jpg)", "artifacts/preview.jpg"],
                        ];
                        const input = page.locator("#composer-input");
                        for (const [text, reference] of references) {
                            await setState(page, { messages: [{ id: "preview-link", role: "assistant", text }] });
                            await input.fill("Keep my draft");
                            assert.deepEqual(await takeMessages(page), [], "Rendering must not read image files");
                            const link = page.locator(".code-reference");
                            await link.focus();
                            await link.press("Enter");
                            const requests = await takeMessages(page);
                            assert.equal(requests.length, 1);
                            const [request] = requests;
                            assert.equal(request.type, "previewImage");
                            assert.equal(request.reference, reference);
                            assert.equal(request.contextToken, "fixture-context-1");
                            await sendHost(page, {
                                type: "imagePreview",
                                requestId: request.requestId,
                                image: imageFixture(),
                            });
                            await assertImageLoaded(page.locator("#image-preview-content img"));
                            assert.equal(await input.inputValue(), "Keep my draft");
                            await page.keyboard.press("Escape");
                            await page.waitForFunction(() =>
                                document.activeElement?.classList.contains("code-reference"),
                            );
                            assert.equal(await link.evaluate((node) => node === document.activeElement), true);
                            assert.deepEqual(await takeMessages(page), []);
                        }

                        await setState(page, {
                            messages: [
                                {
                                    id: "remote",
                                    role: "assistant",
                                    text: "[Remote](https://example.invalid/preview.png)",
                                },
                            ],
                        });
                        await page.getByRole("link", { name: "Remote", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "openLink", url: "https://example.invalid/preview.png" },
                        ]);
                        await assertLayout(page, 390);
                    });
                },
            );

            await t.test(
                "Markdown image previews are explicit local host requests and remote images are external links",
                async () => {
                    await withPage(browser, fixtures, { name: "markdown-image-preview", width: 280 }, async (page) => {
                        await setState(page, {
                            messages: [
                                {
                                    id: "markdown-images",
                                    role: "assistant",
                                    text: "![Local diagram](docs/diagram.png)\n\n![Remote diagram](https://example.invalid/diagram.png)",
                                },
                            ],
                        });
                        assert.equal(await page.locator("#conversation img").count(), 0);
                        assert.equal(await page.locator(".image-preview-action").count(), 1);
                        assert.equal(await page.locator(".external-image-action").count(), 1);
                        assert.deepEqual(
                            await takeMessages(page),
                            [],
                            "Rendering local references must not trigger filesystem reads",
                        );
                        await sendHost(page, {
                            type: "imagePreview",
                            requestId: "unsolicited-preview",
                            image: imageFixture(),
                        });
                        assert.equal(await page.locator("#image-preview").isVisible(), false);
                        const local = page.locator(".image-preview-action");
                        await local.focus();
                        await page.keyboard.press("Enter");
                        const request = await imageMessage(page, "previewImage");
                        assert.equal(request.reference, "docs/diagram.png");
                        assert.equal(request.contextToken, "fixture-context-1");
                        assert.equal(await page.locator("#conversation img").count(), 0);
                        await sendHost(page, {
                            type: "imagePreview",
                            requestId: request.requestId,
                            image: imageFixture(),
                        });
                        await assertImageLoaded(page.locator("#image-preview-content img"));
                        await page.keyboard.press("Escape");
                        await page.waitForFunction(() =>
                            document.activeElement?.classList.contains("image-preview-action"),
                        );
                        assert.equal(await local.evaluate((node) => node === document.activeElement), true);
                        await page.locator(".external-image-action").click();
                        assert.deepEqual(await takeMessages(page), [
                            { type: "openLink", url: "https://example.invalid/diagram.png" },
                        ]);
                        assert.equal(await page.locator("#conversation img").count(), 0);
                        assert.equal(page.context().pages().length, 1);
                        await local.click();
                        const failed = await imageMessage(page, "previewImage");
                        await sendHost(page, {
                            type: "imagePreview",
                            requestId: failed.requestId,
                            error: "Synthetic preview could not be read.",
                        });
                        assert.match(
                            await page.locator("#image-feedback-text").textContent(),
                            /Synthetic preview could not be read/u,
                        );
                        assert.equal(await page.locator("#image-preview").isVisible(), false);
                    });
                },
            );

            await t.test(
                "an image read started in an earlier conversation cannot attach to the new context",
                async () => {
                    await withPage(browser, fixtures, { name: "image-context-read-race" }, async (page) => {
                        await setState(page, { model: visionModel(), contextToken: "context-before-read" });
                        await page.evaluate(() => {
                            window.specpiFixtureHoldImageReads = true;
                        });
                        await transferFiles(page, "paste", [{ name: "old-conversation.png" }]);
                        assert.equal(await page.evaluate(() => window.specpiFixtureReadReleases.length), 1);
                        assert.deepEqual(await takeMessages(page), []);
                        await setState(page, { model: visionModel(), contextToken: "context-after-read" });
                        await page.locator("#composer-input").fill("The new conversation draft.");
                        await page.evaluate(() => {
                            window.specpiFixtureHoldImageReads = false;
                            for (const release of window.specpiFixtureReadReleases.splice(0)) {
                                release();
                            }
                        });
                        await page.waitForFunction(() => window.specpiFixtureCompletedReads === 1);
                        await page.waitForFunction(() =>
                            document.getElementById("image-feedback-text").textContent.includes("conversation changed"),
                        );
                        assert.deepEqual(await takeMessages(page), []);
                        assert.equal(await page.locator("#attachments img").count(), 0);
                        assert.equal(await page.locator("#composer-input").inputValue(), "The new conversation draft.");
                        await transferFiles(page, "paste", [{ name: "current-conversation.png" }]);
                        const request = await imageMessage(page, "attachImageData");
                        assert.equal(request.contextToken, "context-after-read");
                        await sendHost(page, { type: "attachmentResult", requestId: request.requestId });
                    });
                },
            );

            await t.test("a full 40 MiB media cache admits replacement images after pruning prior state", async () => {
                await withPage(browser, fixtures, { name: "image-cache-capacity" }, async (page) => {
                    const byteLength = 5 * 1024 * 1024;
                    const data = paddedPng(byteLength);
                    assert.equal(Buffer.from(data, "base64").length, byteLength);
                    const baseState = readyState({ model: visionModel() });
                    for (const generation of ["original", "replacement"]) {
                        await page.evaluate(
                            ({ generation, data, byteLength, baseState }) => {
                                const ids = Array.from({ length: 8 }, (_, index) => `${generation}-media-${index}`);
                                const media = ids.map((id) => ({
                                    id,
                                    data,
                                    byteLength,
                                    mimeType: "image/png",
                                    width: 32,
                                    height: 24,
                                }));
                                const attachments = ids.map((mediaId, index) => ({
                                    id: `${generation}-attachment-${index}`,
                                    kind: "image",
                                    mediaId,
                                    label: `Synthetic image ${index + 1}`,
                                    mimeType: "image/png",
                                    width: 32,
                                    height: 24,
                                    byteLength,
                                }));
                                window.postMessage(
                                    {
                                        type: "state",
                                        state: { ...baseState, attachments },
                                        media,
                                        retainedMediaIds: ids,
                                    },
                                    "*",
                                );
                            },
                            { generation, data, byteLength, baseState },
                        );
                        await page.waitForFunction(() => document.querySelectorAll("#attachments img").length === 8);
                        const sources = await page.locator("#attachments img").evaluateAll((images) =>
                            images.map((image) => ({
                                length: image.getAttribute("src")?.length,
                                prefix: image.getAttribute("src")?.slice(0, 22),
                            })),
                        );
                        assert.equal(sources.length, 8);
                        for (const source of sources) {
                            assert.equal(
                                source.length,
                                data.length + "data:image/png;base64,".length,
                                `${generation}: every exact 5 MiB payload must be admitted`,
                            );
                            assert.equal(source.prefix, "data:image/png;base64,");
                        }
                    }

                    await sendHost(page, { type: "state", state: baseState, media: [], retainedMediaIds: [] });
                    assert.equal(await page.locator("#attachments img").count(), 0);
                    assert.deepEqual(await takeMessages(page), []);
                });
            });

            await t.test(
                "approval requests close image previews and cannot be obscured by late preview replies",
                async () => {
                    await withPage(browser, fixtures, { name: "image-preview-approval" }, async (page) => {
                        const attachments = [imageAttachment()];
                        const messages = [
                            {
                                id: "preview-approval-message",
                                role: "assistant",
                                text: "![Local image](docs/diagram.png)",
                            },
                        ];
                        await setState(page, { attachments, messages });
                        await page.locator("#attachments .image-thumbnail").click();
                        assert.equal(await page.locator("#image-preview").isVisible(), true);
                        const uiRequest = {
                            id: "approval-during-preview",
                            method: "confirm",
                            title: "Review this synthetic command",
                        };
                        await setState(page, { status: "busy", attachments, messages, uiRequest });
                        assert.equal(await page.locator("#image-preview").isVisible(), false);
                        assert.equal(
                            await page.locator("#ui-request-title").evaluate((node) => node === document.activeElement),
                            true,
                        );
                        await page.keyboard.press("Escape");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: uiRequest.id, cancelled: true },
                        ]);
                        await setState(page, { attachments, messages });
                        await page.locator(".image-preview-action").click();
                        const request = await imageMessage(page, "previewImage");
                        const nextRequest = {
                            id: "approval-during-load",
                            method: "confirm",
                            title: "Review another synthetic command",
                        };
                        await setState(page, { status: "busy", attachments, messages, uiRequest: nextRequest });
                        await sendHost(page, {
                            type: "imagePreview",
                            requestId: request.requestId,
                            image: imageFixture(),
                        });
                        assert.equal(await page.locator("#image-preview").isVisible(), false);
                        await page.locator("#attachments .image-thumbnail").click();
                        assert.equal(await page.locator("#image-preview").isVisible(), false);
                        assert.equal(
                            await page.locator("#ui-request-title").evaluate((node) => node === document.activeElement),
                            true,
                        );
                        await page.locator(".image-preview-action").click();
                        assert.equal(
                            await page.locator("#ui-request-title").evaluate((node) => node === document.activeElement),
                            true,
                        );
                        assert.deepEqual(await takeMessages(page), []);
                        await page.keyboard.press("Escape");
                        assert.deepEqual(await takeMessages(page), [
                            { type: "uiResponse", id: nextRequest.id, cancelled: true },
                        ]);
                    });
                },
            );

            await t.test(
                "search traverses folded tool matches and chat actions dispatch explicit host commands",
                async () => {
                    await withPage(browser, fixtures, { name: "extras-core-flows", width: 280 }, async (page) => {
                        const messages = [
                            { id: "extra-user", role: "user", text: "Find the synthetic needle." },
                            {
                                id: "extra-tool",
                                role: "tool",
                                toolName: "read",
                                text: "The hidden tool output contains needle.",
                            },
                            { id: "extra-assistant", role: "assistant", text: "I found the needle." },
                        ];
                        await setState(page, { messages });
                        assert.equal(await page.locator(".tool-card").getAttribute("open"), "");
                        await page.locator(".tool-card summary").click();
                        assert.equal(await page.locator(".tool-card").getAttribute("open"), null);
                        await page.locator("#composer-input").focus();
                        await page.keyboard.press("Control+f");
                        const search = page.locator("#conversation-search");
                        await search.getByRole("searchbox", { name: "Search messages", exact: true }).fill("needle");
                        assert.equal(
                            await page.locator(".extras-search-match").getAttribute("data-message-id"),
                            "extra-user",
                        );
                        await search.getByRole("button", { name: "Next matching message", exact: true }).click();
                        assert.equal(
                            await page.locator(".extras-search-match").getAttribute("data-message-id"),
                            "extra-tool",
                        );
                        assert.equal(await page.locator(".tool-card").getAttribute("open"), "");
                        await search.getByRole("button", { name: "Next matching message", exact: true }).click();
                        assert.equal(
                            await page.locator(".extras-search-match").getAttribute("data-message-id"),
                            "extra-assistant",
                        );
                        await search.getByRole("button", { name: "Previous matching message", exact: true }).click();
                        assert.equal(
                            await page.locator(".extras-search-match").getAttribute("data-message-id"),
                            "extra-tool",
                        );
                        await page.keyboard.press("Escape");
                        assert.equal(await search.isVisible(), false);
                        for (const action of [
                            "editPrompt",
                            "forkChat",
                            "exportChat",
                            "copyConversation",
                            "showUsage",
                        ]) {
                            await page.locator("#chat-actions-button").click();
                            await page.locator(`#chat-actions-menu [data-action="${action}"]`).click();
                            assert.deepEqual(await takeMessages(page), [{ type: action }]);
                        }

                        await setState(page, {
                            messages,
                            recoveredDrafts: [
                                { id: "recovered-1", text: "A stopped synthetic image prompt.", imageCount: 2 },
                            ],
                        });
                        const recovered = page.locator("#recovered-image-drafts");
                        assert.equal(await recovered.isVisible(), true);
                        assert.match(await recovered.textContent(), /2 images/u);
                        await recovered.getByRole("button", { name: "Restore draft", exact: true }).click();
                        assert.deepEqual(await takeMessages(page), [{ type: "restoreQueuedDraft", id: "recovered-1" }]);
                        assert.equal(await recovered.isVisible(), true, "Recovered draft changes wait for host state");
                        await recovered
                            .getByRole("button", { name: "Dismiss stopped image message", exact: true })
                            .click();
                        assert.deepEqual(await takeMessages(page), [{ type: "dismissQueuedDraft", id: "recovered-1" }]);
                        await setState(page, { messages, recoveredDrafts: [] });
                        assert.equal(await recovered.isVisible(), false);
                    });
                },
            );

            await t.test("native VS Code file drags preserve the complete internal or ResourceURLs list", async () => {
                const uris = ["file:///synthetic/workspace/first.png", "file:///synthetic/workspace/second.png"];
                for (const [name, extraData] of [
                    [
                        "native-list",
                        { "application/vnd.code.uri-list": uris.join("\r\n"), ResourceURLs: JSON.stringify([uris[0]]) },
                    ],
                    ["resource-urls", { ResourceURLs: JSON.stringify(uris) }],
                ]) {
                    await withPage(browser, fixtures, { name: `drop-${name}` }, async (page) => {
                        await setState(page);
                        assert.equal(await transferFiles(page, "dragover", [], "", extraData), true);
                        assert.deepEqual(await takeMessages(page), []);
                        assert.equal(await transferFiles(page, "drop", [], uris[0], extraData), true);
                        const request = await imageMessage(page, "attachDroppedFiles");
                        assert.deepEqual(
                            request.uris,
                            uris,
                            "Native lists must take precedence over the truncated standard URI list",
                        );
                        assert.equal(request.contextToken, "fixture-context-1");
                        assert.deepEqual(await page.evaluate(() => window.specpiFixtureFileReads), []);
                        await sendHost(page, { type: "attachmentResult", requestId: request.requestId });
                    });
                }
            });

            await t.test(
                "invalid native ResourceURLs data is rejected without partial attachment fallback",
                async () => {
                    const validFirst = "file:///synthetic/workspace/first.png";
                    for (const [name, resources] of [
                        ["malformed", "{not valid JSON"],
                        ["non-string", JSON.stringify([validFirst, 42])],
                        [
                            "too-many",
                            JSON.stringify(
                                Array.from({ length: 9 }, (_, index) => `file:///synthetic/file-${index}.png`),
                            ),
                        ],
                        ["oversized", JSON.stringify([`file:///synthetic/${"a".repeat(128 * 1024)}.png`])],
                    ]) {
                        await withPage(browser, fixtures, { name: `drop-resource-rejection-${name}` }, async (page) => {
                            await setState(page);
                            await transferFiles(page, "drop", [], validFirst, { ResourceURLs: resources });
                            assert.equal(await page.locator("#image-feedback").isVisible(), true);
                            assert.ok((await page.locator("#image-feedback-text").textContent()).trim().length > 0);
                            assert.deepEqual(await page.evaluate(() => window.specpiFixtureFileReads), []);
                            assert.deepEqual(
                                await takeMessages(page),
                                [],
                                "A malformed full list must not silently attach only the first standard URI",
                            );
                        });
                    }
                },
            );

            await t.test("a queued welcome scroll event cannot disable following the initial transcript", async () => {
                await withPage(
                    browser,
                    fixtures,
                    { name: "queued-welcome-scroll", width: 390, height: 500 },
                    async (page) => {
                        const state = readyState({
                            status: "busy",
                            messages: Array.from({ length: 18 }, (_, index) => ({
                                id: `queued-scroll-${index}`,
                                role: index % 2 ? "assistant" : "user",
                                text: `Synthetic message ${index}. ${"Readable context. ".repeat(30)}`,
                            })),
                        });
                        const immediate = await page.evaluate((state) => {
                            const scroller = document.getElementById("scroll-area");
                            const welcomeRange = scroller.scrollHeight - scroller.clientHeight;
                            scroller.scrollTop = Math.max(1, Math.floor(welcomeRange / 2));
                            const queuedTop = scroller.scrollTop;
                            window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }));

                            return {
                                welcomeRange,
                                queuedTop,
                                gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
                            };
                        }, state);
                        assert.ok(
                            immediate.welcomeRange > 0 && immediate.queuedTop > 0,
                            "The fixture must queue an actual welcome scroll event",
                        );
                        assert.ok(
                            immediate.gap < 3,
                            `The first transcript must follow before the queued welcome event is delivered: ${JSON.stringify(immediate)}`,
                        );
                        await page.evaluate(
                            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
                        );
                        const settledGap = await page
                            .locator("#scroll-area")
                            .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
                        assert.ok(settledGap < 3);
                        assert.equal(await page.locator("#jump-to-latest").isVisible(), false);
                    },
                );
            });

            await t.test("a short narrow sidebar keeps request decisions and composer controls in reach", async () => {
                await withPage(browser, fixtures, { name: "short-sidebar", width: 280, height: 500 }, async (page) => {
                    const command = `Synthetic command:\nnode fixture.mjs --description '${"A long reviewable argument with all original detail. ".repeat(30)}'`;
                    await setState(page, {
                        status: "busy",
                        messages: sampleMessages(),
                        error: "Synthetic provider notice. ".repeat(18),
                        runtimeStatus: {
                            guard: "Synthetic command guard enabled. ".repeat(12),
                            mode: "Waiting for explicit decision",
                        },
                        uiRequest: {
                            id: "short-sidebar-request",
                            method: "confirm",
                            title: "Review the complete command before continuing",
                            message: command,
                        },
                    });
                    await page.locator("#runtime-details summary").click();
                    const bounds = await page.evaluate(() => {
                        const rect = (selector) => {
                            const value = document.querySelector(selector).getBoundingClientRect();

                            return { top: value.top, bottom: value.bottom, left: value.left, right: value.right };
                        };

                        return {
                            height: innerHeight,
                            width: innerWidth,
                            input: rect("#composer-input"),
                            send: rect("#send-button"),
                            stop: rect("#stop-button"),
                            request: rect("#ui-request"),
                            footer: rect(".footer"),
                        };
                    });
                    await page.screenshot({ path: path.join(screenshots, "short-sidebar-280x500.png") });
                    for (const name of ["input", "send", "stop"]) {
                        assert.ok(
                            bounds[name].top >= 0 && bounds[name].bottom <= bounds.height,
                            `${name} falls outside the sidebar: ${JSON.stringify(bounds)}`,
                        );
                        assert.ok(bounds[name].left >= 0 && bounds[name].right <= bounds.width);
                    }

                    assert.equal(await page.locator("#ui-request .request-message").textContent(), command);
                    const cancel = page.locator("#ui-request").getByRole("button", { name: "Cancel", exact: true });
                    await cancel.scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(screenshots, "short-sidebar-280x500-decision.png") });
                    await cancel.click();
                    assert.deepEqual(await takeMessages(page), [
                        { type: "uiResponse", id: "short-sidebar-request", cancelled: true },
                    ]);
                    await page.locator("#stop-button").click();
                    assert.deepEqual(await takeMessages(page), [{ type: "stop" }]);
                });
            });
        } finally {
            await browser.close();
        }
    },
);
