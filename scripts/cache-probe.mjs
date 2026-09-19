#!/usr/bin/env node
// Phase 7: put a measured number on the cost of changing the tool set mid-session.
//
// SpecPi's standing rule is that any tool-set decision happens once, before the first request, or
// not at all. The reasoning is that adding tool schemas partway through a session throws away the
// provider's cached prompt prefix, and since about 94% of prompt tokens are cache reads priced at a
// fiftieth of fresh input, that swings the bulk of spend by roughly 47x. Pi's own documentation
// agrees in principle -- the fallback path "may invalidate the provider's cached prompt prefix" --
// but the size of the effect has never been measured in this repository, and a rule that expensive
// should rest on a number.
//
// The experiment is three arms on `t3-cascade-ledger`, which by request 6 carries a prefix past
// 20k tokens, differing only in when Browser QA's fourteen tools (about 8.2 KB of schema) reach the
// request: never, at one fixed mid-session turn, or from the first request.
//
// PRE-REGISTERED DECISION RULE, written before the run:
//   A collapse in cached tokens at the flip, with a re-warm costing more than about 10% of attempt
//   cost -> the cache argument holds, Phase 8 proceeds, and `request_capability` gains a documented
//   per-invocation cost.
//   No collapse -> the cache argument is dropped, Phase 8 is re-ranked on turn-saving alone, and
//   the Jev page is corrected rather than left standing.
//
// Usage:
//   node scripts/cache-probe.mjs [--run=evals/runs/cache-probe] [--json]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Above this share of attempt cost, the re-warm is worth designing around. Fixed in advance. */
export const REWARM_THRESHOLD = 0.1;

/** A drop of at least this share of the previous request's cached tokens counts as a collapse. */
export const COLLAPSE_THRESHOLD = 0.2;

export const ARMS = Object.freeze({
    "probe-control": "never armed",
    "probe-flip": "armed mid-session",
    "probe-armed": "armed from turn 1",
});

function parseArgs(argv) {
    const options = { run: path.join(root, "evals", "runs", "cache-probe"), json: false };
    for (const argument of argv) {
        if (argument.startsWith("--run=")) {
            options.run = path.resolve(argument.slice("--run=".length));
        } else if (argument === "--json") {
            options.json = true;
        } else if (argument === "--help" || argument === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    return options;
}

const fresh = (point) => Math.max(0, (point.promptTokens ?? 0) - (point.cachedTokens ?? 0));

function median(values) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Which request first carried the new schema, read from the run rather than assumed from the turn
 * the fixture was told to flip at. Turns and requests are close to one-to-one here but not
 * guaranteed to be, and `toolsOffered` counts how many requests offered each tool, which pins the
 * boundary exactly: a tool offered on the last N requests first appeared at request total-N+1.
 */
export function flipRequest(attempt) {
    const offered = attempt.tokens?.toolsOffered ?? {};
    const browser = Math.max(
        0,
        ...Object.entries(offered)
            .filter(([name]) => name.startsWith("browser_"))
            .map(([, count]) => count),
    );
    const total = (attempt.tokens?.series ?? []).length;
    if (!Number.isFinite(browser) || browser <= 0 || browser >= total) {
        return null;
    }

    return total - browser + 1;
}

/**
 * The cost of the flip, in the only terms that matter: how many extra fresh tokens the request
 * after the change carried, over what the requests before it were carrying. Comparing against the
 * neighbours rather than against a fixed baseline is what keeps this a within-run measurement --
 * the arms need not match turn for turn, and none of this depends on them doing so.
 */
export function flipEffect(attempt, price) {
    const series = attempt.tokens?.series ?? [];
    const at = flipRequest(attempt);
    if (at === null || at < 2 || at > series.length) {
        return { measured: false, reason: at === null ? "never-flipped" : "flip-out-of-range" };
    }

    const before = series[at - 2];
    const after = series[at - 1];
    // Requests 2..flip-1: the first request is always all fresh and would drag the baseline up.
    const baseline = median(series.slice(1, at - 1).map(fresh));
    const excessTokens = Math.max(0, fresh(after) - baseline);
    const cost = (excessTokens * price.inputPerMTok) / 1_000_000;
    const attemptCost = attempt.modelCost ?? attempt.cost ?? 0;

    return {
        measured: true,
        at,
        cachedBefore: before.cachedTokens ?? 0,
        cachedAfter: after.cachedTokens ?? 0,
        promptBefore: before.promptTokens ?? 0,
        promptAfter: after.promptTokens ?? 0,
        freshBefore: fresh(before),
        freshAfter: fresh(after),
        baselineFresh: baseline,
        // The signal the plan named: cache reads falling while the prompt keeps growing.
        collapsed:
            (before.cachedTokens ?? 0) > 0 &&
            (after.cachedTokens ?? 0) < (1 - COLLAPSE_THRESHOLD) * (before.cachedTokens ?? 0) &&
            (after.promptTokens ?? 0) >= (before.promptTokens ?? 0),
        excessTokens,
        cost,
        attemptCost,
        shareOfAttempt: attemptCost > 0 ? cost / attemptCost : null,
    };
}

export function armSummary(cells, price) {
    const attempts = cells.flatMap((cell) => cell.attempts ?? []).filter((attempt) => attempt.skipped !== true);
    const series = attempts.flatMap((attempt) => attempt.tokens?.series ?? []);
    const prompt = series.reduce((total, point) => total + (point.promptTokens ?? 0), 0);
    const cached = series.reduce((total, point) => total + (point.cachedTokens ?? 0), 0);

    return {
        attempts: attempts.length,
        passed: attempts.filter((attempt) => attempt.pass).length,
        score: attempts.length ? attempts.reduce((t, a) => t + (a.score ?? 0), 0) / attempts.length : 0,
        requests: attempts.length ? attempts.reduce((t, a) => t + (a.modelRequests ?? 0), 0) / attempts.length : 0,
        modelCost: attempts.length ? attempts.reduce((t, a) => t + (a.modelCost ?? 0), 0) / attempts.length : 0,
        freshTokens: attempts.length ? (prompt - cached) / attempts.length : 0,
        cacheHitRate: prompt > 0 ? cached / prompt : 0,
        schemaChars: median(attempts.map((attempt) => attempt.firstCall?.toolSchemaChars ?? 0)),
        flips: attempts.map((attempt) => flipEffect(attempt, price)),
    };
}

export function analyse(report, prices) {
    const price = prices.models?.[report.model] ?? { inputPerMTok: 0, cacheReadPerMTok: 0 };
    const arms = {};
    for (const id of Object.keys(ARMS)) {
        const cells = (report.results ?? []).filter((cell) => cell.harness === id);
        if (cells.length > 0) {
            arms[id] = armSummary(cells, price);
        }
    }

    const flips = (arms["probe-flip"]?.flips ?? []).filter((item) => item.measured);
    const collapsed = flips.filter((item) => item.collapsed);
    const shares = flips.map((item) => item.shareOfAttempt).filter((value) => value !== null);
    const meanShare = shares.length ? shares.reduce((total, value) => total + value, 0) / shares.length : null;
    // The pre-registered rule, applied without reinterpretation.
    const verdict =
        flips.length === 0
            ? "inconclusive: no attempt in the flip arm ever changed its tool set"
            : collapsed.length === 0
              ? "no-collapse"
              : meanShare !== null && meanShare > REWARM_THRESHOLD
                ? "collapse-and-expensive"
                : "collapse-but-cheap";

    return {
        model: report.model,
        attemptsPerCell: report.attemptsPerCell,
        price,
        arms,
        flip: { measured: flips.length, collapsed: collapsed.length, meanShareOfAttempt: meanShare },
        threshold: REWARM_THRESHOLD,
        verdict,
    };
}

const money = (value) => `$${value.toFixed(5)}`;
const pct = (value) => (value === null ? "    -" : `${(value * 100).toFixed(1)}%`);

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log("Usage: node scripts/cache-probe.mjs [--run=<dir>] [--json]");

        return;
    }

    const file = path.join(options.run, "report.json");
    if (!fs.existsSync(file)) {
        console.error(
            `No cache probe report at ${file}. Run:\n  node scripts/eval-run.mjs --harness=probe-control,probe-flip,probe-armed --task=t3-cascade-ledger --attempts=3 --model=deepseek-v4.1-flash --env-file=evals/.env --out=evals/runs/cache-probe`,
        );
        process.exitCode = 1;

        return;
    }

    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    const prices = JSON.parse(fs.readFileSync(path.join(root, "evals", "prices.json"), "utf8"));
    const result = analyse(report, prices);
    if (options.json) {
        console.log(JSON.stringify(result, null, 4));

        return;
    }

    console.log(`Cache probe on ${report.model}, ${report.attemptsPerCell} attempts per arm.`);
    console.log("");
    console.log("arm                  n  score  reqs   schema   fresh tok   cache hit   model cost");
    for (const [id, label] of Object.entries(ARMS)) {
        const arm = result.arms[id];
        if (!arm) {
            continue;
        }

        console.log(
            `${label.padEnd(18)}  ${String(arm.attempts).padStart(1)}  ${arm.score.toFixed(3)}  ${arm.requests.toFixed(1).padStart(4)}  ${String(arm.schemaChars).padStart(7)}  ${String(Math.round(arm.freshTokens)).padStart(9)}  ${pct(arm.cacheHitRate).padStart(9)}  ${money(arm.modelCost).padStart(10)}`,
        );
    }

    console.log("");
    console.log("The flip, request by request");
    console.log(
        "  at  cached before   cached after   prompt before   prompt after   fresh after   baseline   excess   cost      share",
    );
    for (const item of result.arms["probe-flip"]?.flips ?? []) {
        if (!item.measured) {
            console.log(`  --  ${item.reason}`);
            continue;
        }

        console.log(
            `  ${String(item.at).padStart(2)}  ${String(item.cachedBefore).padStart(13)}  ${String(item.cachedAfter).padStart(13)}  ${String(item.promptBefore).padStart(13)}  ${String(item.promptAfter).padStart(12)}  ${String(item.freshAfter).padStart(11)}  ${String(item.baselineFresh).padStart(9)}  ${String(item.excessTokens).padStart(6)}  ${money(item.cost)}  ${pct(item.shareOfAttempt)}`,
        );
    }

    console.log("");
    console.log(
        `Collapsed in ${result.flip.collapsed} of ${result.flip.measured} flips; mean re-warm ${pct(result.flip.meanShareOfAttempt)} of attempt cost against a ${pct(REWARM_THRESHOLD)} threshold fixed in advance.`,
    );
    console.log(`Verdict: ${result.verdict}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
