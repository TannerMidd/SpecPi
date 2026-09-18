import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An answer is most of the mark. Citing the documents it came from is the
// rest, because an answer nobody can retrace is worth less than one they can,
// and because the citation is what distinguishes research from a lucky guess.
const ANSWER_CREDIT = 0.75;
const SOURCE_CREDIT = 0.25;
// Citing the whole corpus would otherwise satisfy any source requirement, so
// a citation list may carry a couple of documents beyond the ones needed and
// no more. Counting questions get a wider allowance, declared per question.
const DEFAULT_EXTRA_ALLOWANCE = 2;

function taskDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}

function sha(text) {
    return createHash("sha256").update(String(text).split("\r\n").join("\n")).digest("hex");
}

function flatten(text) {
    return String(text)
        .toLowerCase()
        .replace(/\s+/gu, " ")
        .replace(/[.,;:]+$/u, "")
        .trim();
}

// The question bank asks for a bare value, so the comparison is exact rather
// than fuzzy: a number is a number, an id is an id. Backticks and surrounding
// quotes are stripped because they are formatting, not content.
function answerMatches(question, given) {
    const value = flatten(given).replace(/^["'`]+|["'`]+$/gu, "");
    if (question.answerKind === "number") {
        const number = Number(value);

        return Number.isFinite(number) && number === Number(question.answer);
    }

    return value === flatten(question.answer);
}

export default async function check(workspaceDir) {
    const key = JSON.parse(fs.readFileSync(path.join(taskDir(), "KEY.json"), "utf8"));

    // The corpus and the question bank are the exam. A harness that edits
    // either has rewritten what it is being asked, so this is a hard zero
    // rather than a deduction. Every document is hashed: rewriting one
    // superseded RFC would turn six questions into one-hop lookups, and a
    // spot check over a sample would miss exactly that edit.
    const fixtures = JSON.parse(fs.readFileSync(path.join(taskDir(), "FIXTURES.json"), "utf8"));
    for (const [relative, digest] of Object.entries(fixtures)) {
        const file = path.join(workspaceDir, relative);
        if (!fs.existsSync(file)) {
            return { pass: false, score: 0, notes: `${relative} is missing; the corpus is fixed` };
        }

        if (sha(fs.readFileSync(file, "utf8")) !== digest) {
            return { pass: false, score: 0, notes: `${relative} was modified; the corpus is fixed` };
        }
    }

    const answersFile = path.join(workspaceDir, "answers.json");
    if (!fs.existsSync(answersFile)) {
        return { pass: false, score: 0, notes: "answers.json was never written" };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(answersFile, "utf8"));
    } catch (error) {
        return { pass: false, score: 0, notes: `answers.json is not valid JSON: ${String(error?.message ?? error)}` };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { pass: false, score: 0, notes: "answers.json must be an object keyed by question id" };
    }

    let credit = 0;
    let correct = 0;
    let cited = 0;
    let attempted = 0;
    let overCited = 0;
    const byArchetype = new Map();

    for (const question of key) {
        const entry = parsed[question.id];
        if (entry === undefined || entry === null) {
            continue;
        }

        attempted += 1;
        const given = typeof entry === "string" ? entry : entry.answer;
        const right = answerMatches(question, given ?? "");
        if (right) {
            correct += 1;
            credit += ANSWER_CREDIT;
            const bucket = byArchetype.get(question.archetype) ?? 0;
            byArchetype.set(question.archetype, bucket + 1);
        }

        const sources = Array.isArray(entry?.sources) ? entry.sources.map((source) => String(source).trim()) : [];
        const unique = new Set(sources);
        const required = new Set(question.sources);
        const allowance = Number.isFinite(question.extraAllowance) ? question.extraAllowance : DEFAULT_EXTRA_ALLOWANCE;
        const complete = [...required].every((source) => unique.has(source));
        const tight = unique.size <= required.size + allowance;
        // Source credit only rides on a correct answer: citing the right
        // documents and then reading the wrong value out of them is not a
        // partially right answer, it is a wrong one.
        if (right && complete && tight) {
            cited += 1;
            credit += SOURCE_CREDIT;
        } else if (complete && !tight) {
            overCited += 1;
        }
    }

    const score = Math.min(1, Math.max(0, credit / key.length));
    const archetypes = [...new Set(key.map((question) => question.archetype))].sort();
    const breakdown = [
        { check: "questions answered correctly", got: correct, of: key.length },
        { check: "correct answers with complete citations", got: cited, of: key.length },
        { check: "questions attempted", got: attempted, of: key.length },
        { check: "citations too broad to credit", got: overCited, of: key.length },
        ...archetypes.map((archetype) => ({
            check: `correct: ${archetype}`,
            got: byArchetype.get(archetype) ?? 0,
            of: key.filter((question) => question.archetype === archetype).length,
        })),
    ];

    return {
        pass: correct === key.length && cited === key.length,
        score,
        breakdown,
        notes:
            correct === key.length
                ? `all ${key.length} questions answered correctly, ${cited} fully cited`
                : `${correct}/${key.length} correct of ${attempted} attempted, ${cited} fully cited`,
    };
}
