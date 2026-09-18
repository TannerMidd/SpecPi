import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Getting the cluster serving is most of the mark. The rest is how much it
// cost to get there: a run that thrashed its way to the same place did not do
// the same work, and backlog is the only thing in this task that separates
// them.
const SERVING_WEIGHT = 0.75;
const PRECISION_WEIGHT = 0.25;
// Backlog at which the precision mark is gone. The reference sequence accrues
// none, and a single destroyed stateful service accrues five.
const BACKLOG_CEILING = 40;

function taskDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}

function sha(text) {
    return createHash("sha256").update(String(text).split("\r\n").join("\n")).digest("hex");
}

export default async function check(workspaceDir) {
    const fixtures = JSON.parse(fs.readFileSync(path.join(taskDir(), "FIXTURES.json"), "utf8"));
    for (const [relative, digest] of Object.entries(fixtures)) {
        const file = path.join(workspaceDir, relative);
        if (!fs.existsSync(file)) {
            return { pass: false, score: 0, notes: `${relative} is missing; the cluster is fixed` };
        }

        if (sha(fs.readFileSync(file, "utf8")) !== digest) {
            return { pass: false, score: 0, notes: `${relative} was modified; the cluster is fixed` };
        }
    }

    const ops = await import(`${pathToFileURL(path.join(workspaceDir, ".ops-impl.mjs")).href}?t=${Date.now()}`);
    const stateFile = path.join(workspaceDir, ".ops", "state.json");
    if (!fs.existsSync(stateFile)) {
        return { pass: false, score: 0, notes: "the cluster was never driven; no state was recorded" };
    }

    let saved = null;
    try {
        saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch (error) {
        return {
            pass: false,
            score: 0,
            notes: `.ops/state.json is not valid JSON: ${String(error?.message ?? error)}`,
        };
    }

    // The cluster is scored on what the recorded commands actually do, not on
    // what the state file claims. Replaying them from the initial state means
    // a hand-written state file scores whatever its journal earns, which for
    // a hand-written file is nothing.
    const journal = Array.isArray(saved.journal) ? saved.journal : [];
    const replayed = ops.initialState();
    let malformed = 0;
    for (const entry of journal) {
        if (typeof entry?.command !== "string" || !Array.isArray(entry?.args)) {
            malformed += 1;
            continue;
        }

        ops.applyAction(replayed, entry.command, entry.args);
    }

    const status = ops.health(replayed);
    const ids = Object.keys(replayed.services).sort();
    const serving = ids.filter((id) => status[id].state === "healthy");
    const destroyed = ids.filter((id) => replayed.services[id].dataLoss);
    const precision = Math.max(0, 1 - replayed.backlog / BACKLOG_CEILING);
    // Precision scales with what is serving rather than adding to it. A
    // cluster nobody touched has a perfect backlog, and paying for that would
    // hand a quarter of the mark to doing nothing.
    const score = (serving.length / ids.length) * (SERVING_WEIGHT + PRECISION_WEIGHT * precision);

    const counts = new Map();
    for (const id of ids) {
        counts.set(status[id].state, (counts.get(status[id].state) ?? 0) + 1);
    }

    const breakdown = [
        { check: "services serving", got: serving.length, of: ids.length },
        { check: "services still failed", got: counts.get("failed") ?? 0, of: ids.length },
        { check: "services still degraded", got: counts.get("degraded") ?? 0, of: ids.length },
        { check: "services left out of rotation", got: counts.get("drained") ?? 0, of: ids.length },
        { check: "stateful services destroyed by a restart", got: destroyed.length, of: 0 },
        { check: "backlog accrued", got: replayed.backlog, of: 0 },
        { check: "commands issued", got: journal.length, of: 0 },
    ];

    const drift = JSON.stringify(saved.services) !== JSON.stringify(replayed.services);

    return {
        pass: serving.length === ids.length && destroyed.length === 0,
        score: Math.min(1, Math.max(0, score)),
        breakdown,
        notes:
            serving.length === ids.length
                ? `every service is serving after ${journal.length} commands, backlog ${replayed.backlog}`
                : `${serving.length}/${ids.length} serving after ${journal.length} commands, backlog ${replayed.backlog}` +
                  `${destroyed.length > 0 ? `, ${destroyed.length} destroyed by a restart: ${destroyed.join(", ")}` : ""}` +
                  `${drift ? " (the recorded state does not match its own journal; the journal is what was scored)" : ""}` +
                  `${malformed > 0 ? `, ${malformed} unreplayable journal entries` : ""}`,
    };
}
