// Copied into workflow workspaces. No network, wall-clock sleeps, or dependencies.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Which transfers fail ambiguously, and which jobs fail their first run, used to be plain fields on
// each item in scenario.json. That file is the one input an agent must read, so the task announced
// its own answer: knowing a transfer is "after" means knowing the commit landed, and the premise
// that an error leaves the outcome unknown collapses. The outcome is derived from an opaque per-item
// seed instead. Runtime and the checker replay through this same function, so they cannot disagree.
//
// This is obfuscation, not secrecy: ops.mjs is a copy of this file and sits in the workspace, so an
// agent that reads it and recomputes the hash can still predict every outcome. The bar it raises is
// from "read one labelled field" to "reimplement the simulator", which is a deliberate act rather
// than an unavoidable one. An offline simulator whose source ships beside the fixture cannot do
// better than that, and TIER5.md says so rather than implying the assignment is hidden.
export function seedBucket(seed) {
    return Number.parseInt(createHash("sha256").update(String(seed)).digest("hex").slice(0, 8), 16);
}

export const FAULT_KINDS = Object.freeze(["none", "before", "after"]);

/** Ambiguity class for a transfer: none, failed before committing, or committed then failed. */
export function faultOf(item) {
    return typeof item.seed === "string" ? FAULT_KINDS[seedBucket(item.seed) % FAULT_KINDS.length] : "none";
}

/** Whether a job fails its first execution and has to be retried. */
export function flakyOf(item) {
    return typeof item.seed === "string" && seedBucket(item.seed) % 2 === 1;
}

export function initialState(spec) {
    return {
        calls: 0,
        rejected: 0,
        faults: 0,
        retries: 0,
        duplicates: 0,
        tick: 0,
        seen: {},
        commits: [],
        jobs: Object.fromEntries(spec.items.map((item) => [item.id, { status: "pending", attempts: 0 }])),
    };
}

export function apply(state, spec, args) {
    state.calls += 1;
    const [command, id, key] = args;
    const item = spec.items.find((entry) => entry.id === id);
    const reply = (ok, message, data = null) => ({ ok, message, data });
    const reject = (message) => {
        state.rejected += 1;

        return reply(false, message);
    };

    if (command === "status") {
        if (id && !item) {
            return reject("unknown item");
        }

        return reply(true, "snapshot", {
            tick: state.tick,
            commits: state.commits.filter((entry) => !id || entry.id === id),
            jobs: id ? { [id]: state.jobs[id] } : state.jobs,
        });
    }

    if (spec.kind === "transactions") {
        if (command !== "send" || !item || !key || !/^[a-zA-Z0-9_-]{1,64}$/u.test(key)) {
            return reject("use send <id> <stable-key> or status [id]");
        }

        if (!item.approved) {
            return reject("not authorized; no transfer made");
        }

        const prior = state.commits.find((entry) => entry.key === key);
        if (prior) {
            if (prior.id !== id) {
                return reject("idempotency key belongs to a different transfer");
            }

            state.retries += 1;

            return reply(true, "already committed", prior);
        }

        state.seen[id] = (state.seen[id] ?? 0) + 1;
        if (faultOf(item) === "before" && state.seen[id] === 1) {
            state.faults += 1;

            return reply(false, "503 upstream unavailable; commit status unknown");
        }

        if (state.commits.some((entry) => entry.id === id)) {
            state.duplicates += 1;
        }

        const receipt = {
            id,
            key,
            // A sequential tx-0001 is guessable, so a journal and receipt file could be written
            // without ever running the simulator. Hashing the transfer, the agent's own key and the
            // commit position means a fabricated receipt has to reproduce this derivation rather
            // than count. Forgery by reimplementation is still possible; see the note above.
            receipt: createHash("sha256")
                .update(`${id}|${key}|${state.commits.length + 1}`)
                .digest("hex")
                .slice(0, 12),
            amount: item.amount,
        };
        state.commits.push(receipt);
        if (faultOf(item) === "after" && state.seen[id] === 1) {
            state.faults += 1;

            return reply(false, "503 upstream unavailable; commit status unknown");
        }

        return reply(true, "committed", receipt);
    }

    if (command === "advance") {
        state.tick += 1;
        for (const entry of spec.items) {
            const job = state.jobs[entry.id];
            if (job.status === "running" && job.until <= state.tick) {
                if (flakyOf(entry) && job.attempts === 1) {
                    job.status = "failed";
                    state.faults += 1;
                } else {
                    job.status = "done";
                }
            }
        }

        return reply(true, "advanced one logical tick", { tick: state.tick, jobs: state.jobs });
    }

    if (command !== "start" || !item) {
        return reject("use start <id>, advance, or status [id]");
    }

    const job = state.jobs[id];
    if (!["pending", "failed"].includes(job.status)) {
        return reject("job already running or done");
    }

    if (item.dependencies.some((dependency) => state.jobs[dependency].status !== "done")) {
        return reject("dependency not done");
    }

    const running = spec.items.filter((entry) => state.jobs[entry.id].status === "running");
    if (running.length >= spec.capacity || running.some((entry) => entry.resource === item.resource)) {
        return reject("capacity or exclusive resource unavailable");
    }

    if (job.status === "failed") {
        state.retries += 1;
    }

    job.status = "running";
    job.attempts += 1;
    job.until = state.tick + item.duration;

    return reply(true, "started", { id, until: job.until });
}

export function replay(spec, journal) {
    const state = initialState(spec);
    for (const args of journal) {
        apply(state, spec, args);
    }

    return state;
}

export function runCli(directory, args) {
    const spec = JSON.parse(fs.readFileSync(path.join(directory, "scenario.json"), "utf8"));
    const journalFile = path.join(directory, "work", "journal.json");
    const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, "utf8")) : [];
    const state = replay(spec, journal);
    const result = apply(state, spec, args);
    journal.push(args);
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    const temporary = `${journalFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(journal)}\n`);
    fs.renameSync(temporary, journalFile);
    console.log(JSON.stringify(result));

    return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = runCli(path.dirname(fileURLToPath(import.meta.url)), process.argv.slice(2));
}
