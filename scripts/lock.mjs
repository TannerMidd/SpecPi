import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";

function assertSafeLockPath(agentDir, lockPath) {
    const root = path.resolve(agentDir);
    let current = path.dirname(path.resolve(lockPath));
    while (current !== root) {
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new Error(`ZenPi refuses a symlinked lock parent: ${current}`);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`ZenPi lock path escapes the agent directory: ${lockPath}`);
        }

        current = parent;
    }

    try {
        if (fs.lstatSync(lockPath).isSymbolicLink()) {
            throw new Error(`ZenPi refuses a symlinked lock target: ${lockPath}`);
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}

function processState(pid) {
    try {
        process.kill(pid, 0);

        return "active";
    } catch (error) {
        if (error?.code === "ESRCH") {
            return "absent";
        }

        throw error;
    }
}

export function acquireZenPiLock(agentDir) {
    const root = path.resolve(agentDir);
    const stateDir = path.join(root, "zenpi");
    const lockPath = path.join(stateDir, "install.lock");
    assertSafeLockPath(root, lockPath);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${randomBytes(12).toString("hex")}`;
    const payload = `${JSON.stringify({ pid: process.pid, token })}\n`;
    let fd;
    try {
        fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }

        const raw = fs.readFileSync(lockPath, "utf8").trim();
        let pid;
        if (/^[1-9]\d*$/.test(raw)) {
            pid = Number(raw);
        } else {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error(`ZenPi lock is malformed and was not reclaimed: ${lockPath}`);
            }

            if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed) ||
                !Number.isInteger(parsed.pid) ||
                parsed.pid <= 0 ||
                typeof parsed.token !== "string" ||
                !parsed.token
            ) {
                throw new Error(`ZenPi lock is malformed and was not reclaimed: ${lockPath}`);
            }

            pid = parsed.pid;
        }

        if (processState(pid) === "active") {
            throw new Error(`Another ZenPi operation appears active: ${lockPath}`);
        }

        if (fs.readFileSync(lockPath, "utf8").trim() !== raw) {
            throw new Error(`ZenPi lock changed during recovery and was not reclaimed: ${lockPath}`);
        }

        fs.rmSync(lockPath);
        fd = fs.openSync(lockPath, "wx", 0o600);
    }

    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);

    return () => {
        try {
            if (fs.readFileSync(lockPath, "utf8") === payload) {
                fs.rmSync(lockPath);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    };
}
