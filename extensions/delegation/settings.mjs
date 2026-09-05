import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_TIMEOUT_MINUTES, timeoutLimits } from "./protocol.mjs";
import { DelegationError } from "./errors.mjs";

const MAX_SETTINGS_BYTES = 4096;
const MAX_BACKUP_BYTES = 32 * 1024;

function regularFile(file, maxBytes = MAX_SETTINGS_BYTES) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes)) {
        throw new Error("Unsupported settings file");
    }

    return stat;
}

function directory(dir, create = false) {
    const parent = path.dirname(dir);
    if (parent !== dir) {
        directory(parent, create);
    }

    let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat && create) {
        fs.mkdirSync(dir, { mode: 0o700 });
        stat = fs.lstatSync(dir);
    }

    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new Error("Unsupported settings directory");
    }
}

// Resolve the human-selected agent root, including platform aliases, once.
// Missing descendants stay non-mutating on load and are checked before creation.
function canonicalAgentDirectory(dir) {
    if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
        const resolved = fs.realpathSync.native(dir);
        if (!fs.statSync(resolved).isDirectory()) {
            throw new Error("Unsupported agent directory");
        }

        return resolved;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
        throw new Error("Agent directory root is unavailable");
    }

    return path.join(canonicalAgentDirectory(parent), path.basename(dir));
}

function atomicWrite(file, content, maxBytes = MAX_SETTINGS_BYTES) {
    regularFile(file, maxBytes);
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
        throw new Error("Settings write exceeds its bound");
    }

    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** Own preference only; never reads Pi settings, credentials or session state. */
export function createTimeoutStore(
    agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
) {
    const requestedAgentDir = path.resolve(agentDir);
    let resolvedAgentDir;
    const location = () => {
        resolvedAgentDir ??= canonicalAgentDirectory(requestedAgentDir);
        const dir = path.join(resolvedAgentDir, "specpi", "delegation");

        return { dir, file: path.join(dir, "settings.json") };
    };

    const read = () => {
        const { dir, file } = location();
        directory(dir);
        if (!regularFile(file)) {
            return undefined;
        }

        const content = fs.readFileSync(file, "utf8");
        const settings = JSON.parse(content);
        if (
            !settings ||
            settings.schema !== 1 ||
            Object.keys(settings).length !== 2 ||
            !Object.hasOwn(settings, "timeoutMinutes")
        ) {
            throw new Error("Invalid settings schema");
        }

        timeoutLimits(settings.timeoutMinutes);

        return { content, minutes: settings.timeoutMinutes };
    };

    return {
        load() {
            try {
                return read()?.minutes ?? DEFAULT_TIMEOUT_MINUTES;
            } catch {
                throw new DelegationError(
                    "Cannot read delegation settings. Check <agent-dir>/specpi/delegation/settings.json (schema 1, timeoutMinutes: integer 1–60) and its permissions; restart Pi after repairing it.",
                );
            }
        },
        save(minutes) {
            timeoutLimits(minutes);
            try {
                const previous = read();
                const { dir, file } = location();
                directory(dir, true);
                if (previous) {
                    atomicWrite(
                        `${file}.bak`,
                        `${JSON.stringify({ sha256: createHash("sha256").update(previous.content).digest("hex"), content: previous.content })}\n`,
                        MAX_BACKUP_BYTES,
                    );
                }

                atomicWrite(file, `${JSON.stringify({ schema: 1, timeoutMinutes: minutes })}\n`);
            } catch {
                throw new DelegationError(
                    "Cannot save delegation settings. Check <agent-dir>/specpi/delegation/settings.json and its permissions; the active timeout is unchanged.",
                );
            }
        },
    };
}
