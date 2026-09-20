// Prove that the tier 6 corpus cannot be separated without reading it.
//
// This file exists because the corpus was shipped twice on the strength of an assertion in a prompt
// -- "There is no keyword that separates a disclosure from an outage" -- that was false both times,
// and nothing in the build ever checked. The second corpus fell to a single grep with four
// alternations, which returned the answer set exactly on both tasks. The claim is cheap to make and
// cheap to test, and only one of those had been happening.
//
// Generation now fails rather than writes when any of these hold:
//
//   * a sentence or term recovers half the answer or more with no false positives
//   * a term covers nearly every outage and no disclosure, so its complement is the answer
//   * a term is at least 80% precise on disclosures while finding half of them
//   * a threshold on file size, line count or the stated duration does the same
//   * the exact v2 attack works
//
// Two things about how it measures, both of which were wrong in the first version of this file and
// would have made it useless in opposite directions.
//
// It asks about precision before recall. The classes are deliberately unbalanced -- seven
// disclosures in sixty reports -- and in that shape F1, and even F1 lift over the trivial
// classifier, rewards terms no attacker could use: a term hitting six files of which three are
// disclosures scores a quarter-point of lift while getting half its answers wrong. The task is
// scored on an exact set, so what matters is whether a term is nearly always right when it fires.
//
// It does not build word pairs across line breaks. Joining the last word of one paragraph to the
// first word of the next invents phrases like "quarter garbage" that no reader could use and that
// land on one class or the other purely by draw order, so the audit spent its strictness on noise
// while real phrases went unchecked.
//
// None of this proves the corpus is unbreakable. A model that understands the rule could in
// principle write a parser that binds each report's subject resource to its two determining
// sentences, and no term-frequency audit would see that coming. What the audit rules out is the
// whole family of attacks that actually broke the last two versions. The pilot run tests the rest:
// if a harness solves the marathon without its context ever growing, it did not read the corpus,
// whatever the audit says.

const WORD = /[a-z][a-z-]+/gu;

/** Lowercased words and adjacent word pairs, pairs confined to a single line. */
function terms(text) {
    const found = new Set();
    for (const line of text.split("\n")) {
        const words = line.toLowerCase().match(WORD) ?? [];
        for (const [index, word] of words.entries()) {
            found.add(word);
            if (index > 0) {
                found.add(`${words[index - 1]} ${word}`);
            }
        }
    }

    return found;
}

/** Non-empty, non-heading lines. A sentence pool split by class is the defect that broke v2. */
function sentences(text) {
    return new Set(
        text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("Duration:")),
    );
}

function f1(hits, positives, predicted) {
    if (hits === 0) {
        return 0;
    }

    const precision = hits / predicted;
    const recall = hits / positives;

    return (2 * precision * recall) / (precision + recall);
}

/** What answering "every file is this class" already scores, which is the bar a term has to clear. */
function baseline(classSize, total) {
    return (2 * classSize) / (total + classSize);
}

function tally(docs, pick) {
    const counts = new Map();
    for (const doc of docs) {
        for (const feature of pick(doc)) {
            const seen = counts.get(feature) ?? { total: 0, disclosure: 0 };
            seen.total += 1;
            seen.disclosure += doc.disclosure ? 1 : 0;
            counts.set(feature, seen);
        }
    }

    return counts;
}

/**
 * Flag only the attacks somebody could actually run.
 *
 * Exclusivity on its own is not one. To exploit a term that happens to appear only in disclosures
 * you have to know it appears only in disclosures, and without the labels you cannot -- in a corpus
 * of sixty reports with seven disclosures, a term occurring in exactly two files lands on two
 * disclosures about one time in eighty by arithmetic alone. Failing the build on that would make
 * the audit unsatisfiable rather than strict, and would teach the next person to raise the
 * threshold until it passed.
 *
 * What is usable is a term recovering a real share of the answer with nothing else mixed in, so the
 * positive bar is precision 1.0 at half the answer or better. The negative direction is an attack
 * only when it covers nearly every outage, because then its complement is the answer; a term in
 * seven of twenty-four outages leaves seventeen undecided and is worth nothing.
 */
function checkExclusivity(docs, pick, label, findings) {
    const positives = docs.filter((doc) => doc.disclosure).length;
    const negatives = docs.length - positives;
    const floors = {
        disclosure: baseline(positives, docs.length),
        outage: baseline(negatives, docs.length),
    };
    let worst = { feature: null, lift: 0, score: 0 };

    for (const [feature, seen] of tally(docs, pick)) {
        if (seen.total < 2) {
            continue;
        }

        const outage = seen.total - seen.disclosure;
        if (seen.disclosure === seen.total && seen.disclosure >= positives * 0.5) {
            findings.push(
                `${label} "${feature}" appears in ${seen.total} files, all disclosures ` +
                    `-- recovers ${seen.disclosure}/${positives} of the answer with no false positives`,
            );
        } else if (outage === seen.total && outage >= negatives * 0.9) {
            findings.push(
                `${label} "${feature}" covers ${outage}/${negatives} outages and no disclosures ` +
                    "-- its complement is the answer",
            );
        }

        // Precision first, and recall only as a floor under it. F1 lift is the wrong instrument
        // for a rare positive class: a term hitting six files of which three are disclosures scores
        // 0.25 above the trivial classifier and is worth nothing to an attacker, because half of
        // what it returns is wrong and the task is scored on an exact set. What would be worth
        // something is a term that is almost always right when it fires and fires often enough to
        // matter, so that is what fails the build.
        const precision = seen.disclosure / seen.total;
        const recall = seen.disclosure / positives;
        if (precision >= 0.8 && recall >= 0.5 && seen.disclosure !== seen.total) {
            findings.push(
                `${label} "${feature}" is ${(precision * 100).toFixed(0)}% precise at ` +
                    `${seen.disclosure}/${positives} recall -- close enough to the answer to use`,
            );
        }

        const score = Math.max(f1(seen.disclosure, positives, seen.total), f1(outage, negatives, seen.total));
        if (score > worst.score) {
            worst = { feature, score, lift: score - Math.max(floors.disclosure, floors.outage) };
        }
    }

    return worst;
}

/** A numeric field separates if some threshold is precise enough on disclosures to act on. */
function checkNumeric(docs, value, label, findings) {
    const positives = docs.filter((doc) => doc.disclosure).length;
    const floor = baseline(positives, docs.length);
    const values = [...new Set(docs.map(value))].sort((a, b) => a - b);
    let best = 0;

    // Same bar as the term check, and for the same reason: a cut that takes ten files to find five
    // disclosures has not separated anything a reader would trust.
    for (const cut of values) {
        for (const above of [docs.filter((doc) => value(doc) >= cut), docs.filter((doc) => value(doc) < cut)]) {
            const hits = above.filter((doc) => doc.disclosure).length;
            if (above.length === 0) {
                continue;
            }

            best = Math.max(best, f1(hits, positives, above.length));
            if (hits / above.length >= 0.8 && hits / positives >= 0.5) {
                findings.push(
                    `${label} separates the classes: a threshold at ${cut} is ` +
                        `${((hits / above.length) * 100).toFixed(0)}% precise at ${hits}/${positives} recall`,
                );

                return best;
            }
        }
    }

    return best;
}

/** The grep that broke v2, kept as a named regression rather than a memory. */
const V2_ATTACK = /revoked|purged|allowlisted|re-scoped/iu;

/**
 * @param docs [{ id, text, disclosure }]
 * @returns { findings: string[], worst: object } -- findings empty means the corpus passed.
 */
export function auditCorpus(docs) {
    const findings = [];
    const positives = docs.filter((doc) => doc.disclosure).length;
    if (positives === 0 || positives === docs.length) {
        throw new Error("audit needs both classes present");
    }

    const prepared = docs.map((doc) => ({
        ...doc,
        termSet: terms(doc.text),
        sentenceSet: sentences(doc.text),
        bytes: Buffer.byteLength(doc.text),
        lines: doc.text.split("\n").length,
        duration: Number(/Duration: (\d+)/u.exec(doc.text)?.[1] ?? 0),
    }));

    const worstSentence = checkExclusivity(prepared, (doc) => doc.sentenceSet, "sentence", findings);
    const worstTerm = checkExclusivity(prepared, (doc) => doc.termSet, "term", findings);

    checkNumeric(prepared, (doc) => doc.bytes, "file size", findings);
    checkNumeric(prepared, (doc) => doc.lines, "line count", findings);
    checkNumeric(prepared, (doc) => doc.duration, "stated duration", findings);

    const caught = prepared.filter((doc) => V2_ATTACK.test(doc.text));
    const caughtDisclosures = caught.filter((doc) => doc.disclosure).length;
    if (caught.length > 0 && (caughtDisclosures === caught.length || caughtDisclosures === positives)) {
        findings.push(
            `the v2 grep /${V2_ATTACK.source}/ still separates: ` +
                `${caught.length} files matched, ${caughtDisclosures} of ${positives} disclosures`,
        );
    }

    return {
        findings,
        worst: {
            term: worstTerm,
            sentence: worstSentence,
            v2Match: `${caught.length}/${docs.length} files, ${caughtDisclosures}/${positives} disclosures`,
        },
    };
}
