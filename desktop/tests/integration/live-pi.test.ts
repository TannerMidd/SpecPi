import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../src/shared/rpc";
import { PiProcess } from "../../src/main/pi-process";

const execute = promisify(execFile);
const live = process.env.SPECPI_LIVE_PI === "1";

describe("installed Pi RPC", () => {
    it.runIf(live)(
        "loads SpecPi commands without blocking Desktop startup or session switches",
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
            const events: RuntimeEvent[] = [];
            runtime.on("event", (event: RuntimeEvent) => events.push(event));
            try {
                await runtime.start({ cwd: repository, trust: "approve", noSession: true, offline: true });
                expect(runtime.snapshot().pendingUi).toEqual([]);
                expect(
                    events.some(
                        (event) =>
                            event.record.type === "extension_ui_request" &&
                            event.record.method === "select" &&
                            String(event.record.title).includes("SpecPi command guard"),
                    ),
                ).toBe(false);
                await vi.waitFor(() =>
                    expect(
                        events.some(
                            (event) => event.record.method === "setStatus" && event.record.statusText === "Guard Off",
                        ),
                    ).toBe(true),
                );
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

                await runtime.request({ type: "prompt", message: "/guard status" });
                await runtime.request({ type: "prompt", message: "/guard strict" });
                await vi.waitFor(() =>
                    expect(
                        events.some(
                            (event) =>
                                event.record.method === "setStatus" &&
                                String(event.record.statusText).includes("Strict"),
                        ),
                    ).toBe(true),
                );
                await runtime.request({ type: "prompt", message: "/guard off" });
                expect(runtime.snapshot().pendingUi).toEqual([]);
                await runtime.request({ type: "new_session" });
                await new Promise((resolve) => setTimeout(resolve, 250));
                expect(runtime.snapshot().pendingUi).toEqual([]);
                expect(
                    events.some(
                        (event) =>
                            event.record.type === "extension_ui_request" &&
                            event.record.method === "select" &&
                            String(event.record.title).includes("SpecPi command guard"),
                    ),
                ).toBe(false);

                await runtime.request({ type: "prompt", message: "/spec on" });
                await vi.waitFor(
                    () =>
                        expect(
                            events.some((event) => {
                                const entry = event.record.entry as
                                    { customType?: string; data?: { enabled?: boolean } } | undefined;

                                return entry?.customType === "spec-mode" && entry.data?.enabled === true;
                            }),
                        ).toBe(true),
                    { timeout: 10_000 },
                );

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
