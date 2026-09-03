import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { PiProcess } from "../../src/main/pi-process";

const execute = promisify(execFile);
const live = process.env.SPECPI_LIVE_PI === "1";

describe("installed Pi RPC", () => {
    it.runIf(live)(
        "loads SpecPi from isolated state and completes startup UI",
        async () => {
            const repository = path.resolve(import.meta.dirname, "../../..");
            const agentDirectory = path.join(os.tmpdir(), `specpi-desktop-live-${crypto.randomUUID()}`);
            await mkdir(agentDirectory, { recursive: true });
            const canary = Buffer.from("desktop-live-auth-canary");
            await writeFile(path.join(agentDirectory, "auth.json"), canary, { mode: 0o600 });
            await execute(
                process.execPath,
                [
                    path.join(repository, "scripts", "specpi.mjs"),
                    "install",
                    "--yes",
                    "--skip-package-install",
                    "--skip-browser-install",
                    "--skip-tool-install",
                    "--skip-shell",
                ],
                { cwd: repository, env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory }, timeout: 30_000 },
            );

            const previous = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDirectory;
            const runtime = new PiProcess();
            try {
                await runtime.start({ cwd: repository, trust: "approve", noSession: true, offline: true });
                await vi.waitFor(() => expect(runtime.snapshot().pendingUi.length).toBeGreaterThan(0), {
                    timeout: 20_000,
                });
                const request = runtime.snapshot().pendingUi.find((item) => item.method === "select");
                expect(request?.title).toContain("SpecPi command guard");
                await runtime.respond({
                    type: "extension_ui_response",
                    id: request!.id,
                    value: "Guard (Recommended)",
                });
                const state = (await runtime.request({ type: "get_state" })) as { sessionFile?: string };
                expect(state.sessionFile).toBeUndefined();
                const result = (await runtime.request({ type: "get_commands" })) as {
                    commands?: Array<{ name?: string }>;
                };
                const names = new Set(result.commands?.map((command) => command.name));
                for (const name of [
                    "guard",
                    "files",
                    "spec",
                    "harness-improvement",
                    "wishlist",
                    "scope",
                    "experiment",
                    "challenge",
                ]) {
                    expect(names.has(name)).toBe(true);
                }

                expect((await stat(path.join(agentDirectory, "auth.json"))).size).toBe(canary.length);
            } finally {
                await runtime.stop();
                if (previous === undefined) {
                    delete process.env.PI_CODING_AGENT_DIR;
                } else {
                    process.env.PI_CODING_AGENT_DIR = previous;
                }
            }
        },
        70_000,
    );
});
