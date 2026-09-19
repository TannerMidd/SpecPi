// What the ledger cannot answer: how much of this session's budget is left, right now.
//
// The ledger is an audit trail -- every call ever made, append-only, rotated when it grows past
// eight megabytes. Counting *this session* out of it means knowing where the session began, which
// nothing outside the advisor's own process does. So the advisor publishes its running total to one
// small file, rewritten in place, and anything that wants to show a budget reads that instead of
// replaying a log to find the boundary.
//
// It holds counts and nothing else. No state, no questions, no answers, no payload, not even the
// ledger's digests: a reader learns how many calls a system made and how many changed something,
// and can learn nothing about what was sent. That is deliberate, because this is the one file in
// the layer meant to be read by another process.
//
// The file always describes the most recent session rather than being deleted at shutdown, and
// carries `active` to say which. "Nothing is running and the last session spent 6 calls" and "a
// session is running and has spent 6 calls" are different facts, and a reader that could not tell
// them apart would report a live budget for a session that ended yesterday.

import fs from "node:fs";
import path from "node:path";
import { SYSTEM_NAMES, jevDirectory, regularFile, writeFileAtomic } from "./config.mjs";

export function usagePath() {
    return path.join(jevDirectory(), "usage.json");
}

/**
 * Replace the snapshot. Failure is swallowed for the same reason the ledger's is: an advisor that
 * cannot write its own bookkeeping must not break the session it is advising, and a missing file
 * reads as "no usage recorded" rather than as zero calls.
 */
export function writeUsage(snapshot) {
    try {
        writeFileAtomic(usagePath(), `${JSON.stringify(snapshot, null, 4)}\n`);

        return true;
    } catch {
        return false;
    }
}

/** Every unknown shape reads as absent, never as a partial count. */
export function normalizeUsage(raw) {
    if (raw?.schema !== 1) {
        return undefined;
    }

    const systems = {};
    for (const name of SYSTEM_NAMES) {
        const bucket = raw.systems?.[name];
        systems[name] = {
            calls: count(bucket?.calls),
            applied: count(bucket?.applied),
            failed: count(bucket?.failed),
            savedBytes: count(bucket?.savedBytes),
        };
    }

    return {
        schema: 1,
        session: typeof raw.session === "string" ? raw.session.slice(0, 64) : "",
        startedAt: iso(raw.startedAt),
        updatedAt: iso(raw.updatedAt),
        active: raw.active === true,
        calls: count(raw.calls),
        budgets: Object.fromEntries(["total", ...SYSTEM_NAMES].map((name) => [name, count(raw.budgets?.[name])])),
        systems,
    };
}

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function iso(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : "";
}

export function readUsage() {
    try {
        const file = usagePath();
        // regularFile refuses links, hard-linked files and anything over 4 KiB. A counts file for
        // seven systems is a few hundred bytes, so the size check is a real one here.
        if (!regularFile(file, "Jev usage")) {
            return undefined;
        }

        return normalizeUsage(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
        return undefined;
    }
}
