import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "leaf") {
    console.log(`LEAF=${process.pid}`);
    process.send?.("ready");
} else {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "leaf"], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    if (process.argv[2] === "orphan") {
        child.once("message", () => process.exit(0));
    }

    console.log(`PARENT=${process.pid}`);
}

setInterval(() => {}, 1000);
