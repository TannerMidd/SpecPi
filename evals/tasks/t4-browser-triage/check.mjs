import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reporting a widget that is actually correct costs a whole defect. Without
// it the cheapest strategy is to list all fifty widgets and collect the
// naming credit on the forty that happen to be broken.
const FALSE_POSITIVE_COST = 1;
// A widget id that is not in the application at all is noise rather than a
// wrong call, so it costs less — but not nothing, or padding the file would
// be free.
const UNKNOWN_COST = 0.25;
// Naming the defect is the smaller half. Quoting what the browser printed is
// the larger one, because that string only exists once the widget has been
// driven.
const NAMING_CREDIT = 0.4;
const EVIDENCE_CREDIT = 0.6;

function taskDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}

function normalized(text) {
    return String(text).split("\r\n").join("\n");
}

function sha(text) {
    return createHash("sha256").update(normalized(text)).digest("hex");
}

// Quoted evidence is compared with whitespace collapsed and case folded, so
// a harness is not penalised for reflowing a long a11y row, but the
// characters that carry the meaning still have to be there.
function flatten(text) {
    return String(text).toLowerCase().replace(/\s+/gu, " ").trim();
}

export default async function check(workspaceDir) {
    const key = JSON.parse(fs.readFileSync(path.join(taskDir(), "KEY.json"), "utf8"));

    // The application and the browser that runs it are the exam. Editing
    // either rewrites the thing doing the judging, so it is a hard zero
    // rather than a deduction: every number below it would be meaningless.
    const fixtures = JSON.parse(fs.readFileSync(path.join(taskDir(), "FIXTURES.json"), "utf8"));
    for (const [relative, digest] of Object.entries(fixtures)) {
        const file = path.join(workspaceDir, relative);
        if (!fs.existsSync(file)) {
            return { pass: false, score: 0, notes: `${relative} is missing; the application is fixed` };
        }

        if (sha(fs.readFileSync(file, "utf8")) !== digest) {
            return { pass: false, score: 0, notes: `${relative} was modified; the application is fixed` };
        }
    }

    const reportFile = path.join(workspaceDir, "findings.json");
    if (!fs.existsSync(reportFile)) {
        return { pass: false, score: 0, notes: "findings.json was never written" };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    } catch (error) {
        return { pass: false, score: 0, notes: `findings.json is not valid JSON: ${String(error?.message ?? error)}` };
    }

    const reported = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.findings) ? parsed.findings : null;
    if (reported === null) {
        return { pass: false, score: 0, notes: "findings.json must be an array, or an object with a findings array" };
    }

    const byId = new Map(key.map((entry) => [entry.id, entry]));
    const defects = key.filter((entry) => entry.defective);
    const seen = new Set();
    let credit = 0;
    let confirmed = 0;
    let namedOnly = 0;
    let wrongKind = 0;
    let falsePositives = 0;
    let unknown = 0;
    const routes = new Set();

    for (const finding of reported) {
        const id = String(finding?.widget ?? finding?.id ?? "").trim();
        // One verdict per widget: filing the same widget twice is a report
        // that needs tidying, not extra evidence.
        if (seen.has(id)) {
            continue;
        }

        seen.add(id);
        const entry = byId.get(id);
        if (entry === undefined) {
            unknown += 1;
            credit -= UNKNOWN_COST;
            continue;
        }

        if (!entry.defective) {
            falsePositives += 1;
            credit -= FALSE_POSITIVE_COST;
            continue;
        }

        routes.add(entry.route);
        const kindMatches =
            String(finding?.kind ?? "")
                .trim()
                .toLowerCase() === entry.kind;
        const observed = flatten(
            typeof finding?.observed === "string" ? finding.observed : JSON.stringify(finding?.observed ?? ""),
        );
        const quoted = entry.tokens.every((token) => observed.includes(flatten(token)));
        if (kindMatches) {
            credit += NAMING_CREDIT;
        } else {
            wrongKind += 1;
        }

        if (quoted) {
            credit += EVIDENCE_CREDIT;
        }

        if (kindMatches && quoted) {
            confirmed += 1;
        } else {
            namedOnly += 1;
        }
    }

    const score = Math.min(1, Math.max(0, credit / defects.length));
    const breakdown = [
        { check: "defects confirmed with evidence", got: confirmed, of: defects.length },
        { check: "defects reported without full evidence", got: namedOnly, of: defects.length },
        { check: "wrong defect kind", got: wrongKind, of: defects.length },
        { check: "correct widgets reported as broken", got: falsePositives, of: key.length - defects.length },
        { check: "widget ids that do not exist", got: unknown, of: 0 },
        { check: "routes covered", got: routes.size, of: new Set(key.map((entry) => entry.route)).size },
    ];

    return {
        pass: confirmed === defects.length && falsePositives === 0 && unknown === 0,
        score,
        breakdown,
        notes:
            confirmed === defects.length && falsePositives === 0
                ? `all ${defects.length} defects confirmed with evidence`
                : `${confirmed}/${defects.length} confirmed, ${namedOnly} partly, ${falsePositives} false positive(s), ${unknown} unknown id(s)`,
    };
}
