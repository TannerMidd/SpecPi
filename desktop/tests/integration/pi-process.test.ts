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
write({ type: "extension_ui_request", id: "guard", method: "select", title: "SpecPi command guard", options: ["Deny (Recommended)", "Allow once"] });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "extension_ui_response") write({ type: "extension_ui_request", id: "notice", method: "notify", message: "Guard active", notifyType: "info" });
    else if (command.type === "get_state") write({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "fake", thinkingLevel: "off" } });
    else if (command.type === "new_session") write({ type: "response", id: command.id, command: "new_session", success: true, data: {} });
  }
});
`,
    );
    await writeFile(shim, '"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n');
    await chmod(shim, 0o700);

    return { directory, shim };
}

describe("PiProcess", () => {
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
        expect(runtime.snapshot().pendingUi[0]?.id).toBe("guard");
        const statePromise = runtime.request({ type: "get_state" });
        const early = await Promise.race([
            statePromise.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
        ]);
        expect(early).toBe(false);
        await runtime.respond({ type: "extension_ui_response", id: "guard", value: "Deny (Recommended)" });
        const state = await statePromise;
        expect(state).toEqual({ sessionId: "fake", thinkingLevel: "off" });
        const generation = runtime.snapshot().status.generation;
        await runtime.request({ type: "new_session" });
        expect(runtime.snapshot().status.generation).toBe(generation + 1);
        expect(events.some((event) => event.record.type === "extension_ui_request")).toBe(true);
        await runtime.stop();
        expect(runtime.snapshot().status.phase).toBe("stopped");
    });
});
