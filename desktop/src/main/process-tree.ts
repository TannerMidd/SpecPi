import { spawn, type ChildProcess } from "node:child_process";

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null) {
        return;
    }

    await new Promise<void>((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            child.removeListener("exit", finish);
            resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        child.once("exit", finish);
    });
}

function processGroupAlive(pid: number): boolean {
    try {
        process.kill(-pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processGroupAlive(pid)) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return !processGroupAlive(pid);
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
    if (!child.pid) {
        return;
    }

    if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                resolve();
            };

            const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
                shell: false,
                windowsHide: true,
                stdio: "ignore",
            });
            const timer = setTimeout(() => {
                killer.kill("SIGKILL");
                child.kill("SIGKILL");
                finish();
            }, 2_000);
            killer.once("error", () => {
                child.kill("SIGKILL");
                finish();
            });
            killer.once("exit", finish);
        });
        await waitForChildExit(child, 1_000);

        return;
    }

    try {
        process.kill(-child.pid, "SIGTERM");
    } catch {
        child.kill("SIGTERM");
    }

    const groupExited = await waitForProcessGroupExit(child.pid, 500);
    if (!groupExited) {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            child.kill("SIGKILL");
        }

        await Promise.all([waitForChildExit(child, 500), waitForProcessGroupExit(child.pid, 500)]);
    }
}
