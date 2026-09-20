// Build the tier 6 workspaces.
//
// Tier 6 exists because tiers 1 to 5 and Terminal-Bench cannot reach what the Jev layer was built
// for. Those suites are short, single-session and non-adversarial, and the layer's systems fire on
// situations rather than on scores: a session long enough to accumulate dead tool results, one long
// enough to compact, a command that should not run unexamined.
//
// Two earlier versions of this tier measured nothing, and the reasons are written down in
// corpus.mjs because they are the traps any replacement falls into. In short: v1 was batchable and
// v2 was greppable, and in both cases the claim that it was neither lived only in a prompt. The
// build now proves it instead -- generation runs audit.mjs over what it just wrote and throws
// rather than leaving a corpus that a term-frequency attack can separate.
//
// The tier is two tasks, not four. `t6-error-loop` was dropped rather than repaired: across seven
// harnesses and fourteen attempts it produced zero tool errors, because reading a small script is
// free and the script named its own escape hatch. Forcing a repeated failing call needs a wrong
// path that stays tempting after the agent has read the source, and obfuscation is not that. A task
// that never fires measures nothing, and three honest tasks beat four with one piece of theatre.
//
//   haystack  classifies prose. Judgement per document, and no feature separates the answer, so
//             each document must enter the model's context to be decided.
//   marathon  does the same over enough documents to exceed the context window, with a fact stated
//             at the start that is only needed at the end. Compaction is not optional here.
// `t6-destructive-guard` was dropped too, after it passed eight attempts out of eight with the
// guard consulted forty-six times and acting zero times. Headless, the guard's middle band has
// nobody to ask, so every "ask" verdict degrades to a defer and only a confident destructive
// reading can block -- which ordinary cleanup does not produce. The guard package's own suite already
// covers block, ask and defer directly and deterministically, so the task was paying model money
// to re-derive what a unit test proves for free.
//
// These tasks stay winnable without Jev and losable with it. The point is not to stage a victory.
//
// Usage: node evals/lib/tier6/generate.mjs [--check]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { auditCorpus } from "./audit.mjs";
import { report } from "./corpus.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.resolve(here, "..", "..", "tasks");

// Deterministic, so filler is stable across machines and regenerating does not churn the diff.
function rng(seed) {
    let state = seed >>> 0;

    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;

        return state / 0x100000000;
    };
}

const picker = (next) => (list) => list[Math.floor(next() * list.length)];

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function idFor(index) {
    return `INC-${String(2200 + index * 7).padStart(4, "0")}`;
}

/**
 * Check that a report encodes the label the answer key gives it.
 *
 * The audit proves the corpus cannot be separated by its words. This proves the opposite thing,
 * which matters just as much and is easier to get wrong: that the words are there to separate it by
 * at all. A binding bug -- the subject's reach sentence attached to the other resource, say --
 * produces a corpus where the stated rule gives a different answer than the key, every harness
 * fails, and the failure looks like the model being bad at reading.
 */
function verifyBinding(id, built, expected) {
    const { truth, text } = built;
    if (truth.disclosure !== expected) {
        throw new Error(`${id}: built as ${truth.disclosure} but the answer key says ${expected}`);
    }

    if (truth.disclosure !== (truth.hasData && truth.reachable)) {
        throw new Error(`${id}: label does not follow from the rule it was built from`);
    }

    for (const [what, sentence] of Object.entries(truth.sentences)) {
        if (!text.includes(sentence)) {
            throw new Error(`${id}: the subject's ${what} sentence is not in the report`);
        }

        if (!sentence.includes(truth.subject)) {
            throw new Error(`${id}: the subject's ${what} sentence is about ${truth.other}, not the subject`);
        }
    }
}

/**
 * Write a corpus and refuse to ship it if it can be separated without being read.
 *
 * The throw is the whole point of this function. Both previous versions of this tier would have
 * been caught here in under a second, and both were instead published, run across seven harnesses,
 * and reported as a measurement of something they did not measure.
 */
function writeCorpus({ root, count, disclosures, paragraphs, seed, label }) {
    // Search rather than trust. The design makes no sentence carry the class, but a draw can still
    // land one specific phrasing on half the disclosures and nowhere else, and that is a real leak
    // in the shipped artifact however innocent its cause. Seeds are cheap; a corpus that leaks is
    // not. The chosen seed is printed so a regeneration is reproducible rather than a fresh gamble.
    for (let attempt = 0; attempt < 400; attempt += 1) {
        const candidate = seed + attempt;
        const next = picker(rng(candidate));
        const docs = [];
        for (let i = 0; i < count; i += 1) {
            const disclosure = disclosures.includes(i);
            const built = report({ id: idFor(i), disclosure, next, paragraphs });
            verifyBinding(idFor(i), built, disclosure);
            docs.push({ id: idFor(i), text: built.text, disclosure });
        }

        const { findings, worst } = auditCorpus(docs);
        if (findings.length > 0) {
            continue;
        }

        for (const doc of docs) {
            write(path.join(root, "incidents", `${doc.id}.md`), doc.text);
        }

        process.stdout.write(
            `${label}: audit clean at seed ${candidate} ` +
                `(best term "${worst.term.feature}" F1 ${worst.term.score.toFixed(2)}, v2 grep ${worst.v2Match})
`,
        );

        return docs.filter((doc) => doc.disclosure).map((doc) => doc.id);
    }

    // Not a warning and not a fallback write. Both previous versions of this tier were published
    // because the build had no way to refuse, and a separable corpus is worse than no corpus: it
    // produces numbers that look like a measurement.
    throw new Error(
        `${label}: no seed in 400 produced a corpus the audit accepts -- ` +
            "the pools in corpus.mjs are too narrow for this many documents",
    );
}

/* ---------- t6-retention-haystack ---------- */

// Twenty-eight incident reports, four of which describe data reaching somewhere it should not have.
// Deciding which is a reading of what happened: every report contains the same four determining
// sentences, and only which resource each one is about differs.
export const HAYSTACK = { count: 28, disclosures: [2, 4, 9, 11, 16, 19, 23, 25] };

function haystack(root) {
    const answer = writeCorpus({
        root,
        count: HAYSTACK.count,
        disclosures: HAYSTACK.disclosures,
        paragraphs: 12,
        seed: 20260921,
        label: "haystack",
    });

    write(
        path.join(root, "README.md"),
        [
            "# Incident review",
            "",
            "`incidents/` holds this quarter's incident reports. Every one of them describes an",
            "access-control lapse on one resource, reviewed alongside a second resource the same",
            "change did not touch.",
            "",
            "A report describes **data reaching somewhere it should not have** when the resource the",
            "lapse happened to both held data at the time and could be reached from outside the",
            "operator group. If the affected resource was empty, or could not be reached from",
            "outside, then nothing left the boundary however serious the lapse was.",
            "",
            "The facts that decide this are stated in each report, in different sections. Facts about",
            "the second resource decide nothing.",
            "",
            "Identify the reports of the first kind. Write `work/disclosures.json`.",
        ].join("\n"),
    );

    return answer;
}

/* ---------- t6-context-marathon ---------- */

// The same judgement, over enough reports to overrun a 200k window, plus a fact stated once at the
// beginning and needed only at the end. Compaction will happen; the question is what it keeps. A
// harness that compacts by token distance drops the oldest content first, and the oldest content
// here is the only thing the final answer needs.
export const MARATHON = { count: 60, disclosures: [3, 12, 21, 29, 38, 47, 55], ticket: "CHG-90417" };

function marathon(root) {
    const answer = writeCorpus({
        root,
        count: MARATHON.count,
        disclosures: MARATHON.disclosures,
        paragraphs: 36,
        seed: 771,
        label: "marathon",
    });

    // Stated once, in the brief, before any of the reading starts.
    write(
        path.join(root, "BRIEF.md"),
        [
            "# Review brief",
            "",
            `Change ticket for this review: **${MARATHON.ticket}**`,
            "",
            "Quote that ticket in your final answer. It is recorded here and nowhere else, and it",
            "will not be repeated. Read it now; you will be asked for it at the end.",
            "",
            "## The rule",
            "",
            "Every report describes an access-control lapse on one resource, reviewed alongside a",
            "second resource the same change did not touch.",
            "",
            "A report describes **data reaching somewhere it should not have** when the resource the",
            "lapse happened to both held data at the time and could be reached from outside the",
            "operator group. If the affected resource was empty, or could not be reached from",
            "outside, then nothing left the boundary however serious the lapse was. Facts about the",
            "second resource decide nothing.",
            "",
            "## The work",
            "",
            "Read every report in `incidents/`, in filename order, and decide each one. When you",
            "have read all of them, write `work/review.json`.",
        ].join("\n"),
    );

    return answer;
}

const BUILDERS = {
    "t6-retention-haystack": haystack,
    "t6-context-marathon": marathon,
};

function main() {
    const check = process.argv.includes("--check");
    const answers = {};
    for (const [id, build] of Object.entries(BUILDERS)) {
        const root = path.join(tasksDir, id, "workspace");
        if (check) {
            if (!fs.existsSync(root)) {
                throw new Error(`${id}: workspace missing; run node evals/lib/tier6/generate.mjs`);
            }

            continue;
        }

        fs.rmSync(root, { recursive: true, force: true });
        answers[id] = build(root);
        let bytes = 0;
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else {
                    bytes += fs.statSync(full).size;
                }
            }
        };

        walk(root);
        process.stdout.write(
            `${id}: ${(bytes / 1024).toFixed(0)} KiB, ~${Math.round(bytes / 4000)}k tokens if read whole\n`,
        );
    }

    // Printed so the checkers can be compared against what was actually written, rather than
    // against an index list that drifted.
    if (!check) {
        for (const [id, ids] of Object.entries(answers)) {
            if (ids) {
                process.stdout.write(`${id} answer: ${JSON.stringify(ids)}\n`);
            }
        }
    }
}

main();
