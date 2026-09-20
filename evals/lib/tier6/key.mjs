// Recover a tier 6 report's label from its text, the way the author can.
//
// This is the reference key, and it is deliberately not a stored list of ids. A stored list proves
// that the expected output exists; it cannot prove that the corpus still encodes the rule the task
// states. That is the failure that would be invisible and expensive: a binding bug in corpus.mjs
// would produce reports whose stated rule gives a different answer than the key, every harness would
// fail, and the failure would look like the model being bad at reading prose.
//
// So the key regenerates every sentence corpus.mjs could have written, for every resource, and finds
// which ones are in the report. Exact string matching, never a regex over the prose: the sentences
// come from templates, so the author can reproduce them exactly, and anything that does not match
// exactly is a corpus that changed without this file changing with it.
//
// None of this is available to a harness under test. A harness has the report and the rule, which is
// the point.

import { POOLS } from "./corpus.mjs";

/** The resource a built sentence is about, for every sentence the pool could have produced. */
function bindings(builders) {
    const index = new Map();
    for (const resource of POOLS.RESOURCES) {
        for (const build of builders) {
            index.set(build(resource), resource.name);
        }
    }

    return index;
}

const CONTENT_PRESENT = bindings(POOLS.CONTENT_PRESENT);
const REACH_OPEN = bindings(POOLS.REACH_OPEN);

/** Every summary the pool could have produced, mapped to the resource the lapse was on. */
function summaryIndex() {
    const index = new Map();
    for (const subject of POOLS.RESOURCES) {
        for (const other of POOLS.RESOURCES) {
            if (other.name === subject.name) {
                continue;
            }

            for (const lapse of POOLS.LAPSES) {
                for (const build of POOLS.SUMMARIES) {
                    // Keyed on the whole summary rather than its first line, because four of the
                    // eight phrasings name the unaffected resource first and one resolves the
                    // subject only through "the latter".
                    index.set(build(subject, other, lapse).join("\n"), subject.name);
                }
            }
        }
    }

    return index;
}

const SUMMARIES = summaryIndex();

function find(index, lines, what, id) {
    for (const line of lines) {
        const resource = index.get(line);
        if (resource) {
            return resource;
        }
    }

    throw new Error(`${id}: no ${what} sentence in the report -- corpus.mjs and key.mjs disagree`);
}

/**
 * Whether a report describes data reaching somewhere it should not have.
 *
 * True exactly when the resource the lapse was on is also the one that held data and the one that
 * could be reached. Any other arrangement fails one of the two conditions, and the sentences that
 * fail it are about the resource reviewed alongside.
 */
export function isDisclosure(text, id = "report") {
    const lines = text.split("\n").map((line) => line.trim());
    const subject = subjectOf(lines, id);

    return (
        find(CONTENT_PRESENT, lines, "content-present", id) === subject &&
        find(REACH_OPEN, lines, "reach-open", id) === subject
    );
}

function subjectOf(lines, id) {
    // Summaries are two lines with a blank between them in the report, so the pairs are rebuilt here
    // rather than matched line by line.
    for (let i = 0; i < lines.length; i += 1) {
        for (const gap of [1, 2]) {
            const subject = SUMMARIES.get(`${lines[i]}\n${lines[i + gap] ?? ""}`);
            if (subject) {
                return subject;
            }
        }
    }

    throw new Error(`${id}: no summary matched any phrasing corpus.mjs can produce`);
}
