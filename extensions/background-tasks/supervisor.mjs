// An owned root stays alive until the parent completes bounded tree cleanup.
// Never load project modules or configuration here. Commands arrive once over IPC.
import { spawn } from "node:child_process";

let started = false;
process.on("message", (message) => {
    if (started || message?.operation !== "start") {
        return;
    }

    started = true;
    try {
        const child = spawn(message.shell, message.args, {
            cwd: message.cwd,
            env: process.env,
            stdio: ["ignore", "inherit", "inherit"],
            windowsHide: true,
            windowsVerbatimArguments: process.platform === "win32",
        });
        child.once("spawn", () => process.send?.({ event: "started" }));
        child.once("error", () => process.send?.({ event: "failed" }));
        child.once("exit", (code, signal) => process.send?.({ event: "exited", code, signal }));
    } catch {
        process.send?.({ event: "failed" });
    }
});
// Keep the root alive during POSIX group grace so its identity cannot be reused.
process.on("SIGTERM", () => {});
process.on("disconnect", () => {
    // A crashed parent cannot provide reliable tree cleanup. Do not persist a daemon.
    process.exit(1);
});
process.send?.({ event: "ready" });
