import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../src/shared/rpc";
import { PiProcess } from "../../src/main/pi-process";

async function fakePi(): Promise<{ directory: string; shim: string }> {
    const directory = path.join(os.tmpdir(), `specpi-fake-pi-${crypto.randomUUID()}`);
    const bundle = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
    await mkdir(bundle, { recursive: true });
    const cli = path.join(bundle, "cli.js");
    const shim = path.join(directory, "pi.cmd");
    await writeFile(
        cli,
        `if (process.argv.includes("--version")) { console.log("0.84.4"); process.exit(0); }
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
write({ type: "extension_ui_request", id: "startup", method: "select", title: "SpecPi command guard", options: ["Guard (Recommended)", "Strict", "Off for this session"] });
let startupValue;
let startupConfirmed = false;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "extension_ui_response" && command.id === "startup") {
      startupValue = command.value;
      write({ type: "extension_ui_request", id: "startup-confirm", method: "confirm", title: "Turn command guard off for this session?", message: "Legacy confirmation" });
    } else if (command.type === "extension_ui_response" && command.id === "startup-confirm") {
      startupConfirmed = command.confirmed === true;
      write({ type: "extension_ui_request", id: "legacy-notice", method: "notify", message: "Command guard is off for this session; this is not a sandbox.", notifyType: "warning" });
      write({ type: "extension_ui_request", id: "approval", method: "select", title: "Command guard approval — Severity: high", options: ["Deny (Recommended)", "Allow once"] });
      write({ type: "extension_ui_request", id: "approval-duplicate", method: "select", title: "Command guard approval — Severity: high", options: ["Deny (Recommended)", "Allow once"] });
    } else if (command.type === "extension_ui_response") write({ type: "extension_ui_request", id: "notice", method: "notify", message: "Guard active", notifyType: "info" });
    else if (command.type === "get_state") write({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "fake", thinkingLevel: "off", desktop: process.env.SPECPI_DESKTOP, startupValue, startupConfirmed } });
    else if (command.type === "new_session") write({ type: "response", id: command.id, command: "new_session", success: true, data: {} });
  }
});
`,
    );
    await writeFile(shim, '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n');
    await chmod(shim, 0o700);

    return { directory, shim };
}

async function delayedPi(): Promise<{ directory: string; shim: string }> {
    const directory = path.join(os.tmpdir(), `specpi-delayed-pi-${crypto.randomUUID()}`);
    const bundle = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
    await mkdir(bundle, { recursive: true });
    const cli = path.join(bundle, "cli.js");
    const shim = path.join(directory, "pi.cmd");
    await writeFile(
        cli,
        `if (process.argv.includes("--version")) { console.log("0.84.4"); process.exit(0); }
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "get_state") setTimeout(() => write({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "delayed" } }), 200);
  }
});
`,
    );
    await writeFile(shim, '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n');
    await chmod(shim, 0o700);

    return { directory, shim };
}

describe("PiProcess", () => {
    it("does not report an idle runtime before Pi answers RPC", async () => {
        const fixture = await delayedPi();
        const runtime = new PiProcess();
        const starting = runtime.start({
            cwd: fixture.directory,
            piPath: fixture.shim,
            trust: "deny",
            noSession: true,
            offline: true,
        });
        const early = await Promise.race([
            starting.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
        ]);
        expect(early).toBe(false);
        expect(runtime.snapshot().status.phase).toBe("starting");
        await expect(starting).resolves.toMatchObject({ phase: "idle" });
        await runtime.stop();
    });

    it("routes blocking extension UI and correlated responses", async () => {
        const fixture = await fakePi();
        const runtime = new PiProcess();
        const events: RuntimeEvent[] = [];
        runtime.on("event", (event: RuntimeEvent) => events.push(event));
        await runtime.start({
            cwd: fixture.directory,
            piPath: fixture.shim,
            trust: "deny",
            noSession: true,
            offline: true,
        });
        await vi.waitFor(() => expect(runtime.snapshot().pendingUi).toHaveLength(1));
        expect(runtime.snapshot().pendingUi[0]?.id).toBe("approval");
        expect(
            events.filter(
                (event) =>
                    event.record.type === "extension_ui_request" &&
                    ["SpecPi command guard", "Turn command guard off for this session?"].includes(
                        String(event.record.title),
                    ),
            ),
        ).toHaveLength(0);
        expect(
            events.some(
                (event) =>
                    event.record.type === "extension_ui_request" &&
                    event.record.message === "Command guard is off for this session; this is not a sandbox.",
            ),
        ).toBe(false);
        const statePromise = runtime.request({ type: "get_state" });
        const early = await Promise.race([
            statePromise.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
        expect(early).toBe(false);
        await runtime.respond({ type: "extension_ui_response", id: "approval", value: "Deny (Recommended)" });
        const state = await statePromise;
        expect(state).toEqual({
            sessionId: "fake",
            thinkingLevel: "off",
            desktop: "1",
            startupValue: "Off for this session",
            startupConfirmed: true,
        });
        const generation = runtime.snapshot().status.generation;
        await runtime.request({ type: "new_session" });
        expect(runtime.snapshot().status.generation).toBe(generation + 1);
        expect(events.some((event) => event.record.type === "extension_ui_request")).toBe(true);
        await runtime.stop();
        expect(runtime.snapshot().status.phase).toBe("stopped");
    });
});
