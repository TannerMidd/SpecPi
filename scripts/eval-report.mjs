#!/usr/bin/env node
// Eval accounting. One rule matters more than any other: never let a
// success-conditioned number stand alone. Every cost section reports mean
// cost per attempt and cost per success together, and unknown prices are
// lower bounds (≥), never zeroes.

export function mean(values) {
    if (values.length === 0) {
        return 0;
    }

    let total = 0;
    for (const value of values) {
        total += value;
    }

    return total / values.length;
}

export function median(values) {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }

    return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function wilsonInterval(solved, attempts, z = 1.96) {
    if (attempts === 0) {
        return { low: 0, high: 1 };
    }

    const p = solved / attempts;
    const denominator = 1 + (z * z) / attempts;
    const center = p + (z * z) / (2 * attempts);
    const spread = z * Math.sqrt((p * (1 - p)) / attempts + (z * z) / (4 * attempts * attempts));

    return {
        low: Math.max(0, (center - spread) / denominator),
        high: Math.min(1, (center + spread) / denominator),
    };
}

// The harness's own model spend, which is the only figure comparable
// across harnesses. Eval plumbing (the per-attempt OpenCode session mint)
// is charged to whoever the plumbing needed, not to the harness. Reports
// written before the split carry the total alone, and subtracting an
// absent mint leaves it unchanged, so old runs still render.
export function attemptModelCost(attempt) {
    if (Number.isFinite(attempt?.modelCost)) {
        return attempt.modelCost;
    }

    return (attempt?.cost ?? 0) - (attempt?.mintCost ?? 0);
}

export function attemptMintCost(attempt) {
    return Number.isFinite(attempt?.mintCost) ? attempt.mintCost : 0;
}

// Calls and offers, kept apart. Reports written before tool counting was
// fixed recorded the request's tool list under toolCalls — the tools the
// model was offered, not the ones it invoked — which reads as "create_goal
// 61" for a tool nothing ever called. A proxy attempt with no toolsOffered
// field is from one of those runs, so its counts move to the offers side
// and its calls are reported as unmeasured rather than as fiction.
export function attemptToolCounts(attempt) {
    const tokens = attempt?.tokens ?? {};
    const offersRecorded = tokens.toolsOffered !== undefined;
    if (!attempt?.native && !offersRecorded) {
        return { calls: {}, offers: tokens.toolCalls ?? {}, callsMeasured: false };
    }

    return { calls: tokens.toolCalls ?? {}, offers: tokens.toolsOffered ?? {}, callsMeasured: true };
}

// A boolean verdict saturates: across 168 attempts the suite produced two
// failures, so solve rate alone carried almost no information. Score is how
// much of the task landed; scope is whether the harness stayed inside the
// paths the task allowed. Both are reported next to the verdict.
export function attemptScore(attempt) {
    if (Number.isFinite(attempt?.score)) {
        return attempt.score;
    }

    return attempt?.pass ? 1 : 0;
}

export function scopeSummary(attempts) {
    const measured = attempts.filter((attempt) => attempt?.scope);
    if (measured.length === 0) {
        return { measured: 0, clean: 0, violations: 0, created: 0, tampered: 0, cleanRate: null };
    }

    const clean = measured.filter((attempt) => attempt.scope.clean).length;
    const all = measured.flatMap((attempt) => attempt.scope.violations);
    // Leaving a scratch file behind and rewriting a file the task protected are
    // not the same failing. The first is untidiness; the second is a breach of
    // the instruction, and it is the one worth escalating.
    const created = all.filter((violation) => violation.kind === "created").length;
    const tampered = all.length - created;

    return {
        measured: measured.length,
        clean,
        violations: all.length,
        created,
        tampered,
        cleanRate: clean / measured.length,
    };
}

// Token economics per attempt. These are harness properties and they spread
// far wider than solve rate does: on a tier where every harness scores 100%,
// input tokens still range over 2x and output over 5x. Proxy prompt_tokens
// arrive inclusive of cache rereads while native harnesses report them apart,
// so the total is reconstructed the same way for both before dividing.
export function usageSummary(attempts) {
    if (attempts.length === 0) {
        return {
            meanInputTokens: 0,
            meanOutputTokens: 0,
            meanTokensPerRequest: 0,
            cacheHitRate: null,
            meanToolCalls: 0,
        };
    }

    let promptTotal = 0;
    let cachedTotal = 0;
    let outputTotal = 0;
    let requestTotal = 0;
    let callTotal = 0;
    for (const attempt of attempts) {
        const tokens = attempt.tokens ?? {};
        const cached = tokens.cachedTokens ?? 0;
        const input = tokens.inputTokens ?? 0;
        promptTotal += attempt.native ? input + cached : input;
        cachedTotal += cached;
        outputTotal += tokens.outputTokens ?? 0;
        requestTotal += attempt.modelRequests ?? 0;
        callTotal += Object.values(attemptToolCounts(attempt).calls).reduce((sum, count) => sum + count, 0);
    }

    return {
        meanInputTokens: promptTotal / attempts.length,
        meanOutputTokens: outputTotal / attempts.length,
        meanTokensPerRequest: requestTotal === 0 ? 0 : promptTotal / requestTotal,
        cacheHitRate: promptTotal === 0 ? null : cachedTotal / promptTotal,
        meanToolCalls: callTotal / attempts.length,
    };
}

export function summarizeAttempts(attempts) {
    // Every cost figure below is model cost; the mint is reported beside
    // it so the real total is never hidden, only kept out of comparisons.
    const costs = attempts.map(attemptModelCost);
    const mints = attempts.map(attemptMintCost);
    const solved = attempts.filter((attempt) => attempt.pass).length;
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    const wins = attempts.filter((attempt) => attempt.pass).map(attemptModelCost);
    const winsTotal = wins.reduce((sum, cost) => sum + cost, 0);
    const complete = attempts.every((attempt) => attempt.costComplete !== false);

    return {
        attempts: attempts.length,
        solved,
        solveRate: attempts.length === 0 ? 0 : solved / attempts.length,
        wilson: wilsonInterval(solved, attempts.length),
        meanCostPerAttempt: mean(costs),
        medianCostPerAttempt: median(costs),
        costPerSuccess: solved === 0 ? 0 : total / solved,
        successConditionedCost: solved === 0 ? 0 : winsTotal / solved,
        meanScore: mean(attempts.map(attemptScore)),
        usage: usageSummary(attempts),
        scope: scopeSummary(attempts),
        meanMintCostPerAttempt: mean(mints),
        meanTotalCostPerAttempt: mean(attempts.map((attempt) => attempt.cost ?? 0)),
        costComplete: complete,
    };
}

export function pairedContingency(firstAttempts, secondAttempts) {
    let both = 0;
    let onlyFirst = 0;
    let onlySecond = 0;
    let neither = 0;
    const count = Math.min(firstAttempts.length, secondAttempts.length);
    for (let index = 0; index < count; index++) {
        const first = Boolean(firstAttempts[index]?.pass);
        const second = Boolean(secondAttempts[index]?.pass);
        if (first && second) {
            both += 1;
        } else if (first && !second) {
            onlyFirst += 1;
        } else if (!first && second) {
            onlySecond += 1;
        } else {
            neither += 1;
        }
    }

    return { both, onlyFirst, onlySecond, neither, pairs: count };
}

export function breakEvenPerExtraSolve(first, second) {
    // Above this $/solve value the more accurate harness is the better buy.
    const solveGap = second.solved - first.solved;
    if (solveGap === 0) {
        return null;
    }

    const costGap = second.totalCost - first.totalCost;
    if (solveGap < 0) {
        return null;
    }

    return costGap / solveGap;
}

export function formatCost(cost, complete) {
    const magnitude = Math.abs(cost);
    // Eval attempts on cheap models cost fractions of a cent, so fixed
    // 2-decimal formatting renders every real run as $0.00. Precision
    // widens as the value shrinks; raw figures stay in report.json.
    const decimals = magnitude === 0 ? 2 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2;
    const text = `$${cost.toFixed(decimals)}`;

    return complete ? text : `≥ ${text}`;
}
