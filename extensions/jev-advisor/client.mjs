// One POST, no SDK. AGENTS.md forbids adding executable dependencies without need, and a single
// JSON request does not need one.
//
// Every failure mode returns `unavailable` rather than throwing: a timeout, an HTTP error, a
// missing key, a malformed body or an unparseable answer all mean "no advice", and the caller runs
// the path it would have run before this extension existed. That is fail-silent, not fail-closed —
// nothing here is ever the reason a tool is blocked.

import { backend, resolveKey } from "./key-source.mjs";

/**
 * Where a key comes from is resolved in key-source.mjs, which follows Pi's own order: the
 * `auth.json` entry `/login openrouter` writes, then the environment variable.
 *
 * Every one of these defaults its route to `backend()` rather than to the string "openrouter", so a
 * no-arg call resolves against the backend actually in force. That matters because it briefly did
 * not: when `apiKey` was first replaced by a re-export of a function whose parameter defaulted to a
 * literal, `apiKey()` returned a stored OpenRouter key under `JEV_BACKEND=typesafe` -- a script's
 * `if (!apiKey())` guard passed and it spent a run, while every request underneath came back
 * `no-key`. The fix belongs at the definition, which is where it now is; a wrapper here would only
 * have hidden that three sibling exports had the same defect.
 */
export { backend, keyEnvName, keyPresent, keySource, keySources, resolveKey as apiKey } from "./key-source.mjs";

export const DEFAULT_MODEL = "jev-1.13.0";
export const OPENROUTER_MODEL = "typesafe/jev-1.13";
// Measured round trip is ~250-400ms through OpenRouter. 800ms left no headroom for a slow call,
// and a timeout costs the advice without saving the latency already spent, so the budget is set
// above the observed spread rather than at it.
export const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 5000;

/** Overridable so tests never reach the network and the eval proxy can price the traffic. */
export function baseUrl() {
    const configured = process.env.TYPESAFE_BASE_URL;
    if (configured && configured.trim().length > 0) {
        return configured.trim().replace(/\/+$/u, "");
    }

    return backend() === "openrouter" ? "https://openrouter.ai" : "https://api.typesafe.ai";
}

// The two services expose the same state/questions body under different paths. Keeping both
// suffixes distinct is also what lets the eval proxy tell the traffic apart and forward it on.
export function endpoint() {
    return `${baseUrl()}${backend() === "openrouter" ? "/api/alpha/decisions" : "/v1/systemone"}`;
}

export function defaultModel() {
    return backend() === "openrouter" ? OPENROUTER_MODEL : DEFAULT_MODEL;
}

/** Choose one option from a set. Up to 255 options; output is free, so rich enums cost nothing. */
export function choice(instructions, criteria) {
    return { type: "choice", instructions, criteria };
}

/** Rate against ordered levels. Two to ten; the returned score may be fractional. */
export function score(instructions, criteria) {
    return { type: "score", instructions, criteria };
}

/** Yes or no as a probability. Returns a bare number with no confidence field. */
export function noul(instructions) {
    return { type: "noul", instructions };
}

function unavailable(reason) {
    return { ok: false, reason, answers: {} };
}

/**
 * Answers are normalized to a single shape so gates never branch on which primitive produced them.
 * A Noul has no confidence, and inventing one would let a caller gate on a number the model never
 * reported, so it stays undefined.
 */
function normalizeAnswer(raw, question) {
    if (!raw || typeof raw !== "object" || !question) {
        return undefined;
    }

    const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
    const confidence = probability(raw.confidence) ? raw.confidence : undefined;
    const distribution = raw.probabilities;
    const validDistribution =
        distribution &&
        typeof distribution === "object" &&
        Object.keys(distribution).length > 0 &&
        Object.values(distribution).every(probability);

    if (question.type === "noul" && probability(raw.noul)) {
        return { kind: "noul", value: raw.noul, probabilities: undefined, confidence: undefined };
    }

    if (question.type === "choice" && typeof raw.choice === "string" && Object.hasOwn(question.criteria, raw.choice)) {
        return {
            kind: "choice",
            value: raw.choice,
            probabilities:
                validDistribution &&
                !Array.isArray(distribution) &&
                Object.keys(distribution).length === Object.keys(question.criteria).length &&
                Object.keys(distribution).every((key) => Object.hasOwn(question.criteria, key))
                    ? distribution
                    : undefined,
            confidence,
        };
    }

    if (
        question.type === "score" &&
        Number.isFinite(raw.score) &&
        raw.score >= 0 &&
        raw.score <= question.criteria.length - 1
    ) {
        return {
            kind: "score",
            value: raw.score,
            // The documented Score distribution is an object; older routes also return arrays.
            probabilities: validDistribution ? distribution : undefined,
            confidence,
        };
    }

    return undefined;
}

/**
 * Ask one batch. Questions are evaluated in parallel against one state, so callers should send
 * every question that state can answer rather than paying for the state again.
 */
export async function ask(state, questions, options = {}) {
    const key = resolveKey(backend());
    if (!key) {
        return unavailable("no-key");
    }

    if (!questions || Object.keys(questions).length === 0) {
        return unavailable("no-questions");
    }

    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 50), MAX_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    const payload = { model: options.model ?? defaultModel(), state, questions };
    try {
        const response = await fetch(endpoint(), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
                // OpenRouter attributes traffic by these; they are ignored by the direct API.
                "HTTP-Referer": "https://pi.dev",
                "X-Title": "specpi-jev-advisor",
            },
            body: JSON.stringify(payload),
            signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
        });
        if (!response.ok) {
            return { ...unavailable(`http-${response.status}`), latencyMs: Date.now() - startedAt };
        }

        const body = await response.json();
        const answers = {};
        for (const [name, raw] of Object.entries(body?.answers ?? {})) {
            const normalized = normalizeAnswer(raw, Object.hasOwn(questions, name) ? questions[name] : undefined);
            if (normalized) {
                answers[name] = normalized;
            }
        }

        if (Object.keys(answers).length === 0) {
            return { ...unavailable("empty-answers"), latencyMs: Date.now() - startedAt };
        }

        return {
            ok: true,
            answers,
            model: typeof body?.model === "string" ? body.model : undefined,
            // Reported by OpenRouter, absent on the direct API. Preferred over an estimate wherever
            // it exists, so the eval cost column rests on logged usage rather than a guess.
            usage: body?.usage && typeof body.usage === "object" ? body.usage : undefined,
            latencyMs: Date.now() - startedAt,
        };
    } catch (error) {
        const reason = error?.name === "AbortError" ? "timeout" : "network";

        return { ...unavailable(reason), latencyMs: Date.now() - startedAt };
    } finally {
        clearTimeout(timer);
    }
}
