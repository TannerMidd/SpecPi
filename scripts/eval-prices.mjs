#!/usr/bin/env node
// Frozen price math for evals. Costs come from proxy-logged token usage
// multiplied by evals/prices.json, never from harness self-reports.
// Unknown models are reported as lower bounds, never as zero.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pricesFile = path.join(root, "evals", "prices.json");

export function loadPrices() {
    const parsed = JSON.parse(fs.readFileSync(pricesFile, "utf8"));
    if (parsed.schema !== 1 || typeof parsed.models !== "object" || parsed.models === null) {
        throw new Error("evals/prices.json has an unsupported schema");
    }

    return parsed;
}

export function priceUsage(prices, model, usage = {}) {
    // Contract: inputTokens EXCLUDES cached tokens; cachedTokens is the
    // reread portion priced at the cache rate. OpenAI-style usage reports
    // prompt_tokens inclusively, so proxy call sites must subtract first —
    // otherwise cached tokens are charged twice (full price plus cache
    // price) and cache-heavy harnesses read artificially expensive.
    // reasoningTokens are generated tokens billed at the output rate, and
    // harnesses that report them apart (OpenCode) EXCLUDE them from
    // outputTokens. OpenAI-style completion_tokens already include them,
    // so the proxy path leaves this zero rather than counting them twice.
    const entry = prices.models?.[model];
    const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
    const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
    const reasoning = Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0;
    const cached = Number.isFinite(usage.cachedTokens) ? usage.cachedTokens : 0;
    const cacheWrite = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
    if (!entry) {
        return { cost: 0, complete: false, reason: `no price for model ${model}` };
    }

    const inputCost = (input / 1_000_000) * (entry.inputPerMTok ?? 0);
    const outputCost = ((output + reasoning) / 1_000_000) * (entry.outputPerMTok ?? 0);
    const cacheCost = (cached / 1_000_000) * (entry.cacheReadPerMTok ?? 0);
    const cacheWriteCost = (cacheWrite / 1_000_000) * (entry.cacheWritePerMTok ?? 0);
    const cost = inputCost + outputCost + cacheCost + cacheWriteCost;
    // Cache writes bill separately on some providers. Pricing them at zero
    // by default would silently undercount a cache-heavy harness, so an
    // unpriced write is a lower bound, exactly like an unknown model.
    if (cacheWrite > 0 && !Number.isFinite(entry.cacheWritePerMTok)) {
        return { cost, complete: false, reason: `no cache-write price for model ${model}` };
    }

    return { cost, complete: true, reason: "" };
}

// The single place attempt usage becomes money. The runner prices a live
// attempt through it and the renderers reprice stored attempts through it,
// so an archived report is always read under the current rules rather than
// whatever was in force the day it was written. Both inputs it needs —
// logged usage and the frozen list — are kept in the report.
export function priceAttempt(prices, model, { native, totals, sessionMint } = {}) {
    const priced = native
        ? priceUsage(prices, model, {
              inputTokens: native.inputTokens,
              outputTokens: native.outputTokens,
              reasoningTokens: native.reasoningTokens,
              cachedTokens: native.cachedTokens,
              cacheWriteTokens: native.cacheWriteTokens,
          })
        : // Proxy prompt_tokens arrive inclusive of cache rereads, and
          // OpenAI-style completion_tokens already include reasoning.
          priceUsage(prices, model, {
              inputTokens: Math.max(0, (totals?.inputTokens ?? 0) - (totals?.cachedTokens ?? 0)),
              outputTokens: totals?.outputTokens ?? 0,
              cachedTokens: totals?.cachedTokens ?? 0,
          });
    // The session mint is real spend, but it is eval plumbing: only proxy
    // harnesses need one, and it carries OpenCode's own system prompt and
    // tool schema, so folding it into the harness figure bills the Pi
    // family for OpenCode's context. It stays its own term.
    const mint = sessionMint
        ? priceUsage(prices, model, {
              inputTokens: sessionMint.inputTokens,
              outputTokens: sessionMint.outputTokens,
              reasoningTokens: sessionMint.reasoningTokens,
              cachedTokens: sessionMint.cachedTokens,
              cacheWriteTokens: sessionMint.cacheWriteTokens,
          })
        : null;

    return {
        modelCost: priced.cost,
        mintCost: mint?.cost ?? 0,
        cost: priced.cost + (mint?.cost ?? 0),
        costComplete: priced.complete && (mint?.complete ?? true),
    };
}

// Reprice every attempt in a loaded report in place. Reports written before
// the cost split carry the mint's logged usage but not its price, so this
// recovers the split without rewriting the run artifact it came from.
export function repriceReport(report, prices = loadPrices()) {
    for (const cell of report?.results ?? []) {
        for (const attempt of cell.attempts ?? []) {
            Object.assign(
                attempt,
                priceAttempt(prices, report.model, {
                    native: attempt.native,
                    totals: attempt.tokens,
                    sessionMint: attempt.sessionMint,
                }),
            );
        }
    }

    return report;
}

export function sumCosts(attempts) {
    let total = 0;
    let complete = true;
    for (const attempt of attempts) {
        total += attempt.cost ?? 0;
        if (attempt.costComplete === false) {
            complete = false;
        }
    }

    return { total, complete };
}
