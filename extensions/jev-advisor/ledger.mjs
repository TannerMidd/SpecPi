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

/**
 * Roll the ledger up into the few numbers a report wants. Kept here rather than in the eval suite
 * because the shape of a line is this module's business, and a reader that has to know it is a
 * second copy of the schema waiting to drift.
 */
export function summarize(entries) {
    const lines = Array.isArray(entries) ? entries : [];
    const bySystem = {};
    let abstentions = 0;
    let elisions = 0;
    for (const entry of lines) {
        if (entry?.sent === false) {
            abstentions += 1;
            continue;
        }

        // Older lines have no effect tags. Positive savings, not `applied`, distinguish a
        // real shortening from an untrusted-content banner sharing a retention request.
        if (entry?.effects?.includes("elision") || (entry?.system === "retention" && entry?.savedBytes > 0)) {
            elisions += 1;
        }

        const name = typeof entry?.system === "string" ? entry.system : "unknown";
        const bucket = (bySystem[name] ??= {
            calls: 0,
            failed: 0,
            applied: 0,
            savedBytes: 0,
            stateBytes: 0,
            outcomes: {},
        });
        bucket.calls += 1;
        bucket.failed += entry?.ok === true ? 0 : 1;
        bucket.applied += entry?.applied === true ? 1 : 0;
        bucket.savedBytes += Number.isFinite(entry?.savedBytes) ? entry.savedBytes : 0;
        bucket.stateBytes += Number.isFinite(entry?.stateBytes) ? entry.stateBytes : 0;
        // "Asked 3 times, applied 0" is a number. "Asked 3 times, applied 0, all three because the
        // result might hold the answer" is a finding.
        const outcome =
            typeof entry?.outcome === "string" ? entry.outcome : entry?.ok === true ? "unrecorded" : "failed";
        bucket.outcomes[outcome] = (bucket.outcomes[outcome] ?? 0) + 1;
    }

    const totals = Object.values(bySystem);

    return {
        calls: lines.length - abstentions,
        abstentions,
        failed: totals.reduce((sum, item) => sum + item.failed, 0),
        applied: totals.reduce((sum, item) => sum + item.applied, 0),
        savedBytes: totals.reduce((sum, item) => sum + item.savedBytes, 0),
        stateBytes: totals.reduce((sum, item) => sum + item.stateBytes, 0),
        // Named for what retention does, because it is the only system that shortens anything and
        // the number is meaningless averaged with systems that cannot.
        elisions,
        bytesDropped: bySystem.retention?.savedBytes ?? 0,
        bySystem,
    };
}

/** Every line, for a caller that wants to summarize rather than display. `read` is for display. */
export function readAll() {
    return read(Number.MAX_SAFE_INTEGER);
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
