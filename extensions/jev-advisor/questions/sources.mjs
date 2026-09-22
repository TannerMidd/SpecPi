// Rank each delegation job's selected sources, never select or remove sources. Paths are state,
// not question instructions. The 1 KiB evidence budget may cause a large job to abstain locally.
import { noul, score } from "../client.mjs";
import { nounFalse, nounTrue, scoreLevel } from "../gate.mjs";
import { compact } from "../sanitize.mjs";

export const RELEVANCE_LEVELS = Object.freeze([
    "Unrelated to the question",
    "Possibly relevant background",
    "Very likely to contain the answer",
]);
export const MAX_CANDIDATES = 40;

export function buildInput({ question, mode, candidates }) {
    return {
        question: compact(question ?? "", 220),
        mode,
        candidates: candidates.map((item, index) => ({ id: `source_${index}`, path: item.path })),
    };
}

export function questions({ candidates }) {
    if (candidates.length > MAX_CANDIDATES) {
        return {};
    }

    const asked = {
        worth_delegating: noul(
            "Given its declared mode, can a read-only child answer this job's question from the selected sources?",
        ),
    };
    for (let index = 0; index < candidates.length; index += 1) {
        asked[`source_${index}`] = score(
            `How likely is candidate source_${index} in the state to contain what the question needs?`,
            RELEVANCE_LEVELS,
        );
    }

    return asked;
}

/** Only gated slots are reordered. Ungated sources stay at their original indices. */
export function decide(answers, candidates) {
    const ranked = candidates.map((item, index) => ({
        item,
        level: scoreLevel(answers?.[`source_${index}`], "sources"),
        position: index,
    }));
    const gated = ranked.filter((item) => item.level !== undefined && item.level <= 2);
    const sorted = [...gated].sort((a, b) => b.level - a.level || a.position - b.position);
    const ordered = [...candidates];
    for (const [index, slot] of gated.entries()) {
        ordered[slot.position] = sorted[index].item;
    }

    return {
        ordered,
        unrelated: gated.filter((item) => item.level === 0).map((item) => item.item.path),
        worthDelegating: nounTrue(answers?.worth_delegating, "sources"),
        notWorthDelegating: nounFalse(answers?.worth_delegating, "sources"),
    };
}
