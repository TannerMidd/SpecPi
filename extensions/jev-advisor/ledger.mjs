// "We only send digests" is a promise until someone can check it. This ledger is the check: one
// line per call recording what was sent, how big it was and what came back, with a SHA-256 of the
// exact payload and never the payload itself.
//
// It doubles as the calibration corpus. Thresholds in this layer are meant to be read off a curve
// rather than guessed, and the curve has to come from somewhere.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { jevDirectory, regularFile } from "./config.mjs";

const MAX_LINES = 5000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

export function ledgerPath() {
    return path.join(jevDirectory(), "transmissions.jsonl");
}

export function payloadDigest(payload) {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Append one record. Ledger failure never fails the call that produced it: an advisor that cannot
 * write its audit line still must not break the session, so the error is swallowed and the caller
 * proceeds. The absence of a line is itself visible in `/jev ledger`.
 */
export function record(entry) {
    try {
        const file = ledgerPath();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (fs.existsSync(file)) {
            const stat = fs.lstatSync(file, { throwIfNoEntry: false });
            if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
                return false;
            }

            if (stat.size > MAX_LEDGER_BYTES) {
                rotate(file);
            }
        }

        fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
            mode: 0o600,
        });

        return true;
    } catch {
        return false;
    }
}

/** Keep the newest half. Unbounded growth is a worse failure than losing old audit lines. */
function rotate(file) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(-Math.floor(MAX_LINES / 2));
    fs.writeFileSync(file, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
}

export function read(limit = 20) {
    try {
        const file = ledgerPath();
        if (!regularFile(file, "Jev ledger")) {
            return [];
        }
    } catch {
        // An oversize ledger is still readable; only a link or irregular file is refused.
    }

    try {
        const lines = fs.readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean);

        return lines
            .slice(-Math.max(1, limit))
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return undefined;
                }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}
