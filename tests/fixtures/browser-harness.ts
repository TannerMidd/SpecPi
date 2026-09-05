import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerBrowser from "../../extensions/browser/index.ts";

const html = `<!doctype html><html><head><title>Browser fixture</title><link rel="icon" href="data:,"></head><body>
<h1>Visually healthy fixture</h1>
<input id="first" name="first" autofocus><input id="second" name="second">
<select id="single" aria-label="single"><option value="a">Alpha</option><option value="b">Beta</option></select>
<select id="multiple" multiple aria-label="multiple"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
<button id="async">Async</button><button id="navigate">Navigate</button><button id="errors">Errors</button><button id="hang">Hang font</button>
<output id="focus"></output><output id="input"></output><output id="key"></output><output id="selection"></output>
<div id="changing">before</div><div id="hide">hide me</div><div id="remove">remove me</div>
<script>
addEventListener('focusin', e => document.querySelector('#focus').textContent = e.target.id);
addEventListener('input', e => document.querySelector('#input').textContent = e.target.value || '');
addEventListener('keydown', e => document.querySelector('#key').textContent = e.key);
addEventListener('change', e => { if(e.target.matches('select')) document.querySelector('#selection').textContent = [...e.target.selectedOptions].map(o => o.value).join(','); });
document.querySelector('#async').onclick = () => setTimeout(() => {
 document.querySelector('#changing').textContent = 'ready .* [literal]';
 document.querySelector('#hide').hidden = true;
 document.querySelector('#remove').remove();
 const late = document.createElement('div'); late.id = 'late'; late.textContent = 'late'; document.body.append(late);
}, 150);
document.querySelector('#navigate').onclick = () => setTimeout(() => location.hash = 'done', 150);
document.querySelector('#errors').onclick = async () => {
 console.error('after interaction token=POSTCANARY');
 await Promise.all([fetch('/missing?token=QUERYCANARY'), fetch('/server'), fetch('/broken').catch(() => {})]);
 document.querySelector('#changing').textContent = 'requests finished';
 setTimeout(() => { throw new Error('post exception password=POSTCANARY'); }, 0);
};
document.querySelector('#hang').onclick = () => {
 const font = new FontFace('Never', 'url(/font)'); document.fonts.add(font); font.load().catch(() => {});
 document.querySelector('h1').style.fontFamily = 'Never';
 new MutationObserver(records => { if(records.some(record => [...record.addedNodes].some(node => node.tagName === 'STYLE'))) fetch('/capture-started'); }).observe(document.head, {childList:true});
};
console.log('benign log');
console.error('startup console api_key=STARTCANARY');
setTimeout(() => { throw new Error('startup exception secret=STARTCANARY'); }, 0);
</script></body></html>`;

export default function browserHarness(pi: ExtensionAPI) {
    const tools = new Map<string, ToolDefinition>();
    const shutdownHandlers: Array<() => Promise<void>> = [];
    registerBrowser(
        new Proxy(pi, {
            get(target, key) {
                if (key === "on") {
                    return (event: "session_shutdown", handler: () => Promise<void>) => {
                        shutdownHandlers.push(handler);
                        target.on(event, handler);
                    };
                }

                if (key === "registerTool") {
                    return (tool: ToolDefinition) => {
                        tools.set(tool.name, tool);
                        target.registerTool(tool);
                    };
                }

                return Reflect.get(target, key);
            },
        }),
    );
    pi.on("session_start", async (_event, ctx) => {
        const call = async (name: string, params = {}, signal?: AbortSignal) => {
            const tool = tools.get(name);
            assert.ok(tool, name);

            return tool.execute("fixture", params, signal, undefined, ctx);
        };

        const text = (result: Awaited<ReturnType<typeof call>>) =>
            result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
        const snapshot = async () => JSON.parse(text(await call("browser_snapshot")));
        const diagnostics = async (params = {}) => JSON.parse(text(await call("browser_diagnostics", params)));
        const wait = async (target: string, value: string) =>
            call("browser_wait_for", { condition: "text", target, text: value });
        const expected = [
            "browser_open",
            "browser_set_viewport",
            "browser_snapshot",
            "browser_click",
            "browser_fill",
            "browser_diagnostics",
            "browser_press",
            "browser_select_option",
            "browser_wait_for",
            "browser_screenshot",
            "browser_save_baseline",
            "browser_compare_screenshot",
            "browser_close",
        ];
        assert.deepEqual([...tools.keys()].sort(), expected.sort());
        assert.ok([...tools.values()].every((tool) => tool.executionMode === "sequential"));
        assert.equal((await diagnostics()).records.length, 0);
        await assert.rejects(call("browser_press", { key: "Tab", timeoutMs: 0 }), /Invalid browser tool parameters/u);
        if (process.env.SPECPI_BROWSER_REGISTRATION_ONLY === "1") {
            console.log("SPECPI_BROWSER_HARNESS=" + JSON.stringify({ registration: true, tools: tools.size }));

            return;
        }

        const runtime = process.env.SPECPI_BROWSER_RUNTIME;
        assert.ok(runtime, "Required browser runtime was not supplied");
        const runtimeLink = path.join(process.env.PI_CODING_AGENT_DIR!, "specpi", "browser-runtime");
        fs.mkdirSync(path.dirname(runtimeLink), { recursive: true });
        fs.symlinkSync(runtime, runtimeLink, process.platform === "win32" ? "junction" : "dir");
        let fontRequested!: () => void;
        let captureStarted!: () => void;
        const fontRequest = new Promise<void>((resolve) => {
            fontRequested = resolve;
        });
        const captureStart = new Promise<void>((resolve) => {
            captureStarted = resolve;
        });
        const server = http.createServer((request, response) => {
            if (request.url === "/font") {
                fontRequested();

                return;
            }

            if (request.url === "/capture-started") {
                captureStarted();
            }

            if (request.url?.startsWith("/broken")) {
                request.socket.destroy();

                return;
            }

            const status = request.url?.startsWith("/missing") ? 404 : request.url === "/server" ? 500 : 200;
            response.writeHead(status, { "Content-Type": "text/html" });
            response.end(status === 200 ? html : "fixture failure");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/`;
        try {
            await call("browser_open", { url, waitUntil: "load" });
            await wait("#focus", "first");
            const firstSnapshot = await snapshot();
            assert.match(firstSnapshot.text, /Visually healthy/u);
            const firstRef = firstSnapshot.controls.find((control: { name: string }) => control.name === "first").ref;
            await call("browser_wait_for", { condition: "visible", target: firstRef });
            await call("browser_press", { target: firstRef, key: "x" });
            await wait("#input", "x");
            await assert.rejects(call("browser_press", { target: firstRef, key: "y" }), /refresh the snapshot/u);
            await call("browser_press", { key: "Tab" });
            await wait("#focus", "second");
            await call("browser_press", { key: "Shift+Tab" });
            await wait("#focus", "first");
            for (const key of ["Enter", "Escape", "ArrowDown"]) {
                await call("browser_press", { target: "#first", key });
                await wait("#key", key);
            }

            const failedFillRef = (await snapshot()).controls[0].ref;
            await assert.rejects(call("browser_fill", { target: "#single", value: "invalid" }));
            await assert.rejects(call("browser_press", { target: failedFillRef, key: "x" }), /refresh the snapshot/u);
            const failedClickRef = (await snapshot()).controls[0].ref;
            await assert.rejects(call("browser_click", { target: "[" }));
            await assert.rejects(call("browser_press", { target: failedClickRef, key: "x" }), /refresh the snapshot/u);
            await call("browser_fill", { target: "#first", value: "filled" });
            await wait("#input", "filled");
            await call("browser_select_option", { target: "#single", options: [{ label: "Beta" }] });
            await wait("#selection", "b");
            await call("browser_select_option", { target: "#single", options: [{ index: 0 }] });
            await wait("#selection", "a");
            await call("browser_select_option", { target: "#multiple", options: [{ value: "a" }, { value: "c" }] });
            await wait("#selection", "a,c");
            await assert.rejects(
                call("browser_select_option", { target: "#single", options: [{ value: "a", label: "Alpha" }] }),
                /exactly one/u,
            );
            await assert.rejects(
                call("browser_select_option", { target: "#single", options: [{ value: "a" }, { value: "b" }] }),
            );
            await assert.rejects(
                call("browser_select_option", { target: "#first", options: [{ value: "SECRETINPUTCANARY" }] }),
                (error: Error) => !error.message.includes("CANARY"),
            );
            await assert.rejects(call("browser_press", { key: "not-a-key" }), /Unsupported/u);
            await assert.rejects(
                call("browser_wait_for", { condition: "visible", target: "#first", text: "contradiction" }),
                /Element waits/u,
            );
            await call("browser_click", { target: "#async" });
            await call("browser_wait_for", { condition: "attached", target: "#late" });
            await call("browser_wait_for", { condition: "hidden", target: "#hide" });
            await call("browser_wait_for", { condition: "detached", target: "#remove" });
            await wait("#changing", "ready .* [literal]");
            await call("browser_click", { target: "#navigate" });
            const navigationRef = (await snapshot()).controls[0].ref;
            await call("browser_wait_for", { condition: "url", url: `${url}#done` });
            await assert.rejects(
                call("browser_wait_for", { condition: "visible", target: navigationRef }),
                /refresh the snapshot/u,
            );
            await call("browser_click", { target: "#errors" });
            await wait("#changing", "requests finished");
            // A browser round trip after the fixture's timer observes the asynchronous exception.
            await snapshot();
            const errors = await diagnostics();
            assert.deepEqual(
                new Set(errors.records.map((entry: { category: string }) => entry.category)),
                new Set(["pageerror", "console", "http", "requestfailed"]),
            );
            assert.ok(errors.records.some((entry: { status: number }) => entry.status === 404));
            assert.ok(errors.records.some((entry: { status: number }) => entry.status === 500));
            assert.doesNotMatch(JSON.stringify(errors), /CANARY|benign log/u);
            assert.ok(errors.records.some((entry: { message: string }) => entry.message.includes("startup exception")));
            assert.ok(errors.records.some((entry: { message: string }) => entry.message.includes("post exception")));
            const directory = path.join(process.env.PI_CODING_AGENT_DIR!, "shots");
            const baseline = path.join(directory, "baseline.png");
            await call("browser_save_baseline", { path: baseline });
            const baselineBytes = fs.readFileSync(baseline);
            await assert.rejects(call("browser_save_baseline", { path: baseline }), /already exists/u);
            await call("browser_screenshot", { path: path.join(directory, "shot.png") });
            const exact = await call("browser_compare_screenshot", { baselinePath: baseline });
            assert.match(text(exact), /PASS/u);
            await call("browser_fill", { target: "#first", value: "changed visually" });
            const changed = await call("browser_compare_screenshot", { baselinePath: baseline, maxDiffPixelRatio: 0 });
            assert.match(text(changed), /FAIL/u);
            assert.deepEqual(fs.readFileSync(baseline), baselineBytes);
            const cleared = await diagnostics({ clear: true, category: "pageerror", maxEntries: 1 });
            assert.ok(cleared.clearedRecords > cleared.records.length);
            assert.equal((await diagnostics()).records.length, 0);
            for (let index = 0; index < 2; index++) {
                await call("browser_open", { url, waitUntil: "load" });
                await wait("#focus", "first");
                await snapshot();
                const report = await diagnostics({ clear: true });
                assert.equal(
                    report.records.filter((entry: { message: string }) => entry.message.includes("startup console"))
                        .length,
                    1,
                );
            }

            await assert.rejects(
                call("browser_wait_for", { condition: "visible", target: "#never", timeoutMs: 60 }),
                /timed out/u,
            );
            await call("browser_open", { url });
            const queuedStarted = Date.now();
            const queuedResults = await Promise.allSettled([
                call("browser_wait_for", { condition: "visible", target: "#never", timeoutMs: 5000 }),
                call("browser_press", { target: "#first", key: "q", timeoutMs: 100 }),
            ]);
            assert.equal(queuedResults[0].status, "rejected");
            assert.equal(queuedResults[1].status, "rejected");
            assert.ok(Date.now() - queuedStarted < 2500, "queued deadline includes admission wait and bounded cleanup");
            await call("browser_open", { url });
            assert.ok((await diagnostics()).records.length > 0);
            const alreadyAborted = new AbortController();
            alreadyAborted.abort();
            await assert.rejects(call("browser_press", { key: "x" }, alreadyAborted.signal), /aborted/u);
            assert.equal((await diagnostics()).records.length, 0);
            await call("browser_open", { url });
            const controller = new AbortController();
            const pending = call("browser_wait_for", { condition: "visible", target: "#never" }, controller.signal);
            const timer = setTimeout(() => controller.abort(), 100);
            await assert.rejects(pending, /aborted/u);
            clearTimeout(timer);
            assert.equal((await diagnostics()).records.length, 0);
            await call("browser_open", { url });
            await call("browser_close");
            const afterClose = await diagnostics({ cursor: errors.nextCursor });
            assert.equal(afterClose.records.length, 0);
            assert.equal(afterClose.contextChanged, true);
            // Timeout while Chromium launch is pending must close the eventual browser before admitting another.
            await assert.rejects(call("browser_press", { key: "x", timeoutMs: 10 }), /timed out/u);
            await call("browser_open", { url });
            await wait("#focus", "first");
            const failedOpenRef = (await snapshot()).controls[0].ref;
            await assert.rejects(call("browser_open", { url: "file:///not-allowed" }));
            await assert.rejects(call("browser_press", { key: "x", target: failedOpenRef }), /refresh the snapshot/u);
            const viewportRef = (await snapshot()).controls[0].ref;
            await call("browser_set_viewport", { preset: "mobile" });
            await assert.rejects(call("browser_press", { key: "x", target: viewportRef }), /refresh the snapshot/u);
            await call("browser_click", { target: "#hang" });
            await fontRequest;
            const blockedCapture = call("browser_screenshot").then(
                () => "unexpected capture",
                () => "aborted capture",
            );
            await captureStart;
            await Promise.all(shutdownHandlers.map((shutdown) => shutdown()));
            assert.equal(await blockedCapture, "aborted capture");
            await assert.rejects(call("browser_press", { key: "x" }), /aborted/u);
            console.log(
                "SPECPI_BROWSER_HARNESS=" +
                    JSON.stringify({
                        registration: true,
                        tools: tools.size,
                        diagnostics: true,
                        interactions: true,
                        lifecycle: true,
                        images: true,
                    }),
            );
        } finally {
            await Promise.all(shutdownHandlers.map((shutdown) => shutdown()));
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}
