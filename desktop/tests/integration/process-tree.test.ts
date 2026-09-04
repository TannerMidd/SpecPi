import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { terminateProcessTree } from "../../src/main/process-tree";

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

async function waitUntilDead(pid: number): Promise<boolean> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        if (!isAlive(pid)) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return !isAlive(pid);
}

describe("Pi process-tree termination", () => {
    it("[B4] terminates both the direct child and its descendant", async () => {
        const directory = path.join(os.tmpdir(), `specpi-process-tree-${crypto.randomUUID()}`);
        await mkdir(directory, { recursive: true });
        const descendantScript = path.join(directory, "descendant.cjs");
        const parentScript = path.join(directory, "parent.cjs");
        await writeFile(descendantScript, "setInterval(() => {}, 1000);\n");
        await writeFile(
            parentScript,
            `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true });
console.log(child.pid);
setInterval(() => {}, 1000);
`,
        );
        const parent = spawn(process.execPath, [parentScript], {
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
        const parentPid = parent.pid;
        if (!parentPid) {
            throw new Error("The process-tree fixture did not start");
        }

        let descendantPid: number | undefined;
        try {
            descendantPid = await new Promise<number>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("The descendant PID was not reported")), 3_000);
                parent.stdout.once("data", (chunk: Buffer) => {
                    clearTimeout(timer);
                    resolve(Number(chunk.toString("utf8").trim()));
                });
                parent.once("error", reject);
            });
            expect(Number.isSafeInteger(descendantPid)).toBe(true);
            expect(isAlive(parentPid)).toBe(true);
            expect(isAlive(descendantPid)).toBe(true);

            await terminateProcessTree(parent);

            expect(await waitUntilDead(parentPid)).toBe(true);
            expect(await waitUntilDead(descendantPid)).toBe(true);
        } finally {
            for (const pid of [descendantPid, parentPid]) {
                if (pid && isAlive(pid)) {
                    try {
                        process.kill(pid, "SIGKILL");
                    } catch {
                        // Best-effort fixture cleanup.
                    }
                }
            }
        }
    }, 10_000);
});
