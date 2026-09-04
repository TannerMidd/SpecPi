import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { PiProcess } from "../../src/main/pi-process";
import type { RuntimeEvent, RuntimeLaunchOptions } from "../../src/shared/rpc";

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
    else if (command.type === "get_messages") write({ type: "response", id: command.id, command: "get_messages", success: true, data: { messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024), timestamp: 1 }] } });
    else if (command.type === "get_session_stats") write({ type: "response", id: command.id, command: "get_session_stats", success: true, data: { unexpected: "x".repeat(4 * 1024 * 1024) } });
    else if (command.type === "get_tree") write({ type: "response", id: command.id, command: "get_tree", success: false, error: "tree unavailable" });
    else if (command.type === "new_session") write({ type: "response", id: command.id, command: "new_session", success: true, data: {} });
    else if (command.type === "clone" || command.type === "fork") write({ type: "response", id: command.id, command: command.type, success: true, data: { cancelled: true } });
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

async function slowProbePi(): Promise<{ directory: string; shim: string; marker: string }> {
    const directory = path.join(os.tmpdir(), `specpi-slow-probe-${crypto.randomUUID()}`);
    const bundle = path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
    await mkdir(bundle, { recursive: true });
    const cli = path.join(bundle, "cli.js");
    const shim = path.join(directory, "pi.cmd");
    const marker = path.join(directory, "rpc-started.txt");
    await writeFile(
        cli,
        `const fs = require("node:fs");
if (process.argv.includes("--version")) { setTimeout(() => { console.log("0.84.4"); }, 1000); }
else { fs.writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000); }
`,
    );
    await writeFile(shim, '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n');
    await chmod(shim, 0o700);

    return { directory, shim, marker };
}

function launch(fixture: { directory: string; shim: string }): RuntimeLaunchOptions {
    return {
        projectId: "project",
        cwd: fixture.directory,
        piPath: fixture.shim,
        trust: "deny",
        noSession: true,
        offline: true,
    };
}

class ControlledChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin: Writable;
    readonly pid: number;
    killed = false;
    exitCode: number | null = null;
    #buffer = "";

    constructor(pid: number) {
        super();
        this.pid = pid;
        this.stdin = new Writable({
            write: (chunk, _encoding, callback) => {
                this.#buffer += chunk.toString("utf8");
                for (;;) {
                    const index = this.#buffer.indexOf("\n");
                    if (index < 0) {
                        break;
                    }

                    const command = JSON.parse(this.#buffer.slice(0, index)) as { id: string; type: string };
                    this.#buffer = this.#buffer.slice(index + 1);
                    if (command.type === "get_state") {
                        this.stdout.write(
                            `${JSON.stringify({
                                type: "response",
                                id: command.id,
                                command: "get_state",
                                success: true,
                                data: { sessionId: `session-${pid}` },
                            })}\n`,
                        );
                    }
                }

                callback();
            },
        });
    }

    kill(): boolean {
        this.killed = true;

        return true;
    }

    asChild(): ChildProcessWithoutNullStreams {
        return this as unknown as ChildProcessWithoutNullStreams;
    }
}

describe("PiProcess", () => {
    it("does not report an idle runtime before Pi answers RPC", async () => {
        const fixture = await delayedPi();
        const runtime = new PiProcess();
        const starting = runtime.start(launch(fixture));
        const early = await Promise.race([
            starting.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
        ]);
        expect(early).toBe(false);
        expect(runtime.snapshot().status.phase).toBe("starting");
        await expect(starting).resolves.toMatchObject({ phase: "idle" });
        await runtime.stop();
    });

    it("accepts bounded bulk session responses above the ordinary record limit", async () => {
        const fixture = await fakePi();
        const runtime = new PiProcess();
        const events: RuntimeEvent[] = [];
        runtime.on("event", (event: RuntimeEvent) => events.push(event));
        await runtime.start(launch(fixture));

        const result = (await runtime.request({ type: "get_messages" })) as {
            messages: Array<{ content: string }>;
        };
        expect(result.messages[0]?.content).toHaveLength(4 * 1024 * 1024);
        expect(events.some((event) => event.record.type === "response")).toBe(false);
        expect(runtime.snapshot().status.phase).not.toBe("failed");
        await runtime.stop();
    });

    it("still rejects oversized non-bulk RPC records", async () => {
        const fixture = await fakePi();
        const runtime = new PiProcess();
        await runtime.start(launch(fixture));

        await expect(runtime.request({ type: "get_session_stats" })).rejects.toThrow(
            "RPC record exceeded 4194304 bytes",
        );
        expect(runtime.snapshot().status).toMatchObject({
            phase: "failed",
            error: "RPC record exceeded 4194304 bytes",
        });
        await runtime.stop();
    });

    it("[C7] rejects an oversized unsolicited response without emitting it", async () => {
        let child: ControlledChild | undefined;
        const runtime = new PiProcess({
            resolveLaunch: async () => ({ displayPath: "pi", executable: "pi", argsPrefix: [], environment: {} }),
            probe: async () => "0.84.4",
            spawnRuntime: () => {
                child = new ControlledChild(900);
                queueMicrotask(() => child?.emit("spawn"));

                return child.asChild();
            },
            terminate: async () => undefined,
        });
        const events: RuntimeEvent[] = [];
        runtime.on("event", (event: RuntimeEvent) => events.push(event));
        await runtime.start({ projectId: "project", cwd: process.cwd(), trust: "deny", noSession: true });

        child!.stdout.write(
            `${JSON.stringify({ type: "response", id: "unsolicited", command: "get_messages", success: true, data: "x".repeat(4 * 1024 * 1024) })}\n`,
        );
        await vi.waitFor(() => expect(runtime.snapshot().status.phase).toBe("failed"));

        expect(events.some((event) => event.record.type === "response")).toBe(false);
        await runtime.stop();
    });

    it("[B5/C7] routes blocking UI, classifies responses, and preserves cancelled transitions", async () => {
        const fixture = await fakePi();
        const runtime = new PiProcess();
        const events: RuntimeEvent[] = [];
        runtime.on("event", (event: RuntimeEvent) => events.push(event));
        await runtime.start(launch(fixture));
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
        const statePromise = runtime.request({ type: "get_state" });
        const early = await Promise.race([
            statePromise.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
        expect(early).toBe(false);
        await expect(
            runtime.respond({ type: "extension_ui_response", id: "approval", value: "Allow everything" }),
        ).rejects.toThrow("did not select an offered option");
        expect(runtime.snapshot().pendingUi).toHaveLength(1);
        await runtime.respond({ type: "extension_ui_response", id: "approval", value: "Deny (Recommended)" });
        expect(await statePromise).toMatchObject({ sessionId: "fake", desktop: "1" });
        await expect(runtime.request({ type: "get_tree" })).rejects.toThrow("tree unavailable");
        expect(events.some((event) => event.record.type === "response")).toBe(false);

        const generation = runtime.snapshot().status.generation;
        await runtime.request({ type: "new_session" });
        expect(runtime.snapshot().status.generation).toBe(generation + 1);
        const afterReplacement = runtime.snapshot().status.generation;
        for (const command of [{ type: "clone" }, { type: "fork", entryId: "entry" }]) {
            await expect(runtime.request(command)).resolves.toEqual({ cancelled: true });
            expect(runtime.snapshot().status.generation).toBe(afterReplacement);
        }

        await runtime.stop();
        expect(runtime.snapshot().status.phase).toBe("stopped");
    });

    it("requires main-owned compatibility confirmation before spawning a newer Pi", async () => {
        const spawnRuntime = vi.fn(() => new ControlledChild(950).asChild());
        const confirmCompatibility = vi.fn(async () => false);
        const runtime = new PiProcess({
            resolveLaunch: async () => ({ displayPath: "pi", executable: "pi", argsPrefix: [], environment: {} }),
            probe: async () => "0.85.0",
            spawnRuntime,
            terminate: async () => undefined,
        });

        await expect(
            runtime.start({
                projectId: "project",
                cwd: process.cwd(),
                trust: "deny",
                noSession: true,
                confirmCompatibility,
            }),
        ).rejects.toThrow("Pi compatibility mode was cancelled");
        expect(confirmCompatibility).toHaveBeenCalledWith(expect.stringContaining("newer"));
        expect(spawnRuntime).not.toHaveBeenCalled();
        expect(runtime.snapshot().status.phase).toBe("stopped");
    });

    it("[B4] cannot spawn RPC after stop returns during version probing", async () => {
        const fixture = await slowProbePi();
        const runtime = new PiProcess();
        const starting = runtime.start(launch(fixture));
        await new Promise((resolve) => setTimeout(resolve, 75));
        await runtime.stop();
        await expect(starting).rejects.toThrow("Pi runtime start was cancelled");
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await expect(readFile(fixture.marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(runtime.snapshot().status.phase).toBe("stopped");
    });

    it("[B4] ignores delayed callbacks from a replaced child", async () => {
        const children: ControlledChild[] = [];
        const runtime = new PiProcess({
            resolveLaunch: async () => ({ displayPath: "pi", executable: "pi", argsPrefix: [], environment: {} }),
            probe: async () => "0.84.4",
            spawnRuntime: () => {
                const child = new ControlledChild(1000 + children.length);
                children.push(child);
                queueMicrotask(() => child.emit("spawn"));

                return child.asChild();
            },
            terminate: async () => undefined,
        });
        const options: RuntimeLaunchOptions = {
            projectId: "project",
            cwd: process.cwd(),
            trust: "deny",
            noSession: true,
        };
        await runtime.start(options);
        await runtime.stop();
        await runtime.start(options);
        const replacement = runtime.snapshot().status;

        children[0]!.stdout.write("not-json\n");
        children[0]!.emit("error", new Error("old child error"));
        children[0]!.emit("exit", 1, null);
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(runtime.snapshot().status).toEqual(replacement);
        expect(runtime.snapshot().status.phase).toBe("idle");
        await runtime.stop();
    });
});
