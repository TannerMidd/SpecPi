// System 4: pre-rank the sources a delegation batch is about to snapshot.
//
// specpi-delegation freezes up to 200 files / 8 MiB for a child that can read the selection and
// nothing else. A wrong selection costs twice: the snapshot itself, and a child that cannot answer
// the question it was given. Ranking is advisory — the parent still chooses, the ceilings are
// unchanged, and this lives in SpecPi's advisor rather than in the published package, so
// specpi-delegation keeps its one-sentence boundary and gains no network dependency.

import { choice, noul, score } from "../client.mjs";
import { choiceValue, nounTrue, scoreLevel } from "../gate.mjs";
import { compact } from "../sanitize.mjs";

export const RELEVANCE_LEVELS = Object.freeze([
    "Unrelated to the question",
    "Possibly relevant background",
    "Very likely to contain the answer",
]);

/** Paths and shape only. File contents are exactly what the child is being given access to read. */
export function buildInput({ question, candidates }) {
    return {
        question: compact(question ?? "", 200),
        candidates: candidates.slice(0, 40).map((item) => ({
            path: compact(item.path, 80),
            bytes: item.bytes ?? 0,
        })),
    };
}

/**
 * One Score per candidate in a single call. Questions are evaluated in parallel against one state,
 * so forty scores cost one state rather than forty, and output is free.
 */
export function questions({ candidates }) {
    const asked = {
        job_mode: choice("What is being asked of the child session?", {
            review: "Check finished work against stated requirements",
            scout: "Answer one evidence question over the sources",
        }),
        worth_delegating: noul(
            "This is a self-contained evidence question that a child session with read-only access could answer",
        ),
    };
    for (const [index, item] of candidates.slice(0, 40).entries()) {
        asked[`source_${index}`] = score(
            `How likely is ${compact(item.path, 80)} to contain what the question needs?`,
            RELEVANCE_LEVELS,
        );
    }

    return asked;
}

/**
 * Ordering only. Ungated scores keep their original position rather than being dropped, so a
 * low-confidence run degrades to the caller's own ordering instead of a truncated selection.
 */
export function decide(answers, candidates) {
    const ranked = candidates.slice(0, 40).map((item, index) => ({
        ...item,
        level: scoreLevel(answers?.[`source_${index}`], "sources"),
        position: index,
    }));
    ranked.sort((a, b) => {
        if (a.level === b.level) {
            return a.position - b.position;
        }

        if (a.level === undefined) {
            return 1;
        }

        if (b.level === undefined) {
            return -1;
        }

        return b.level - a.level;
    });

    return {
        ordered: ranked.map(({ level, position, ...item }) => item),
        unrelated: ranked.filter((item) => item.level === 0).map((item) => item.path),
        jobMode: choiceValue(answers?.job_mode, "sources"),
        worthDelegating: nounTrue(answers?.worth_delegating, "sources"),
    };
}
