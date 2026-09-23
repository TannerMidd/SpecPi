// All advisor state and question text cross this boundary before transmission. Samples are
// redacted, not anonymized. A hard byte cap must not silently remove the evidence being judged.
import path from "node:path";

export const MAX_STATE_BYTES = 1024;

const REDACTIONS = Object.freeze([
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, "[key]"],
    // Assignment redaction comes first: later token redactors may consume its closing quote.
    [
        /(?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[=:]\s*(?:"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|(?:bearer\s+)?[^\s,;}]+)/gi,
        "[credential]",
    ],
    [/\b(?:authorization\s*:\s*)?bearer\s+\S+/gi, "[credential]"],
    [/\b[A-Za-z0-9_-]*sk-[A-Za-z0-9_-]{8,}\b/g, "[key]"],
    [/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, "[key]"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[jwt]"],
    [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
    [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]"],
    [/\b(?:https?|ftp|ssh|file):\/\/\S+/gi, "[url]"],
]);

/** Only paths under the workspace may keep their relative tail. No filesystem access. */
export function relativize(value, root) {
    const text = String(value ?? "").replaceAll("\\", "/");
    const windows = root && /^[A-Za-z]:[/\\]/u.test(root);
    const normalizedRoot = root
        ? (windows ? path.win32.resolve(root) : root.startsWith("/") ? path.posix.resolve(root) : path.resolve(root))
              .replaceAll("\\", "/")
              .replace(/\/$/u, "")
        : undefined;

    return text.replace(/(^|[\s([{"'`=:])((?:[A-Za-z]:\/|\/|~\/)[^\s)\]}"'`<>]*)/gu, (_all, prefix, absolute) => {
        const comparable = windows ? absolute.toLowerCase() : absolute;
        const base = windows ? normalizedRoot?.toLowerCase() : normalizedRoot;
        if (base && comparable === base) {
            return `${prefix}.`;
        }

        if (base && comparable.startsWith(`${base}/`)) {
            const tail = absolute.slice(normalizedRoot.length + 1);
            // A lexical prefix alone is not containment: /workspace/../private is outside it.
            if (!tail.split("/").includes("..")) {
                return `${prefix}${tail}`;
            }
        }

        return `${prefix}[path]`;
    });
}

export function compact(value, maxLength = 240) {
    return String(value ?? "")
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maxLength);
}

export function redact(value, root) {
    // Normalize before matching; otherwise full-width delimiters become secrets after redaction.
    let text = String(value ?? "").normalize("NFKC");
    for (const [pattern, replacement] of REDACTIONS) {
        text = text.replace(pattern, replacement);
    }

    return relativize(text, root);
}

export function looksAbsolute(value) {
    const text = String(value ?? "").replaceAll("\\", "/");

    return text.startsWith("/") || /^[A-Za-z]:\//u.test(text);
}

const size = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function scrub(value, root, depth = 0) {
    if (depth > 5) {
        return undefined;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        return compact(redact(value, root), MAX_STATE_BYTES);
    }

    if (Array.isArray(value)) {
        return value.slice(0, 200).map((item) => scrub(item, root, depth + 1));
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, 32)
                .map(([key, item]) => [compact(redact(key, root), 64), scrub(item, root, depth + 1)])
                .filter(([, item]) => item !== undefined),
        );
    }

    return undefined;
}

// Per-field value budgets leave room for JSON keys and punctuation inside the shared 1 KiB cap.
// Required structures are never deleted. Source/cluster arrays must remain in one-to-one
// correspondence with their questions; only sampled result/history arrays may lose entries.
const PROFILES = Object.freeze({
    retention: { tool: 48, objective: 192, arguments: 112, result: 480, recent: 96 },
    untrusted: { tool: 48, objective: 192, arguments: 112, result: 480, recent: 96 },
    sources: { question: 224, mode: 16, candidates: 700 },
    gap: { capability: 122, scenario: 182, limitation: 162, workaround: 82, claimedImpact: 20, knownProblems: 300 },
    capability: { request: 402, reasons: 100, withdrawnGroups: 32, workspaceFiles: 360 },
});

/** Fit leaves, not whole fields. Refuse if the structural minimum cannot fit. */
function fit(value, budget, preserveArrays = false) {
    const box = { value };
    while (size(box.value) > budget) {
        const leaves = [];
        const arrays = [];
        const visit = (parent, key) => {
            const item = parent[key];
            if (typeof item === "string" && [...item].length > 16) {
                leaves.push({ parent, key, bytes: size(item) });
            } else if (item && typeof item === "object") {
                if (Array.isArray(item) && item.length > 1 && !preserveArrays) {
                    arrays.push(item);
                }

                for (const child of Object.keys(item)) {
                    visit(item, child);
                }
            }
        };

        visit(box, "value");
        leaves.sort((a, b) => b.bytes - a.bytes);
        if (leaves.length > 0) {
            const { parent, key } = leaves[0];
            const chars = [...parent[key]];
            parent[key] = chars.slice(0, Math.max(16, Math.floor(chars.length / 2))).join("");
        } else if (arrays.length > 0) {
            arrays.sort((a, b) => b.length - a.length);
            arrays[0].splice(Math.floor(arrays[0].length / 2), 1);
        } else {
            return undefined;
        }
    }

    return box.value;
}

function complete(state, input, profile) {
    const text = (value) =>
        typeof value === "string" &&
        value.replace(/\[(?:path|key|credential|url|email|jwt|hex)\]/gu, "").trim().length > 0;
    if (profile === "retention" || profile === "untrusted") {
        return (
            text(state.tool) &&
            (profile !== "retention" || text(state.objective)) &&
            [state.result?.head, state.result?.middle, state.result?.tail].flat().some(text)
        );
    }

    if (profile === "sources") {
        return (
            text(state.question) &&
            ["review", "scout"].includes(state.mode) &&
            Array.isArray(state.candidates) &&
            state.candidates.length === input?.candidates?.length &&
            state.candidates.length >= 2 &&
            state.candidates.every((item) => text(item.id) && text(item.path))
        );
    }

    if (profile === "gap") {
        return (
            text(state.capability) &&
            text(state.scenario) &&
            text(state.limitation) &&
            Array.isArray(state.knownProblems) &&
            state.knownProblems.length === input?.knownProblems?.length &&
            state.knownProblems.every((item) => text(item.id) && text(item.title))
        );
    }

    if (profile === "capability") {
        return text(state.request) && state.withdrawnGroups?.length > 0;
    }

    return true;
}

export function buildState(input, options = {}) {
    const limit = Math.max(
        2,
        Math.min(Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_STATE_BYTES, MAX_STATE_BYTES),
    );
    const scrubbed = scrub(input, options.root) ?? {};
    const profile = PROFILES[options.profile];
    const state = {};
    let fits = true;
    if (profile) {
        for (const [key, budget] of Object.entries(profile)) {
            if (scrubbed[key] === undefined) {
                continue;
            }

            // A filename's distinguishing part is often at its end. Never turn several long
            // candidate paths into identical prefixes just to make their questions fit.
            const fitted =
                key === "candidates"
                    ? size(scrubbed[key]) <= budget
                        ? scrubbed[key]
                        : undefined
                    : fit(scrubbed[key], budget, key === "knownProblems");
            if (fitted === undefined) {
                fits = false;
            } else {
                state[key] = fitted;
            }
        }
    } else {
        const fitted = fit(scrubbed, limit);
        if (fitted === undefined) {
            fits = false;
        } else {
            Object.assign(state, fitted);
        }
    }

    const bytes = size(state);
    const evidenceComplete = fits && bytes <= limit && complete(state, input, options.profile);
    const sampleLines = (result) =>
        [result?.head, result?.middle, result?.tail]
            .flat()
            .filter((line) => typeof line === "string" && line.length > 0).length;
    const coverage = {
        complete: evidenceComplete,
        ...(input?.result
            ? {
                  totalLines: input.result.lines,
                  offeredLines: sampleLines(input.result),
                  sampledLines: sampleLines(state.result),
              }
            : {}),
        ...(input?.candidates
            ? { offeredCandidates: input.candidates.length, includedCandidates: state.candidates?.length ?? 0 }
            : {}),
        ...(input?.knownProblems
            ? { offeredClusters: input.knownProblems.length, includedClusters: state.knownProblems?.length ?? 0 }
            : {}),
    };

    return {
        state: bytes <= limit ? state : {},
        bytes: bytes <= limit ? bytes : 2,
        truncated:
            JSON.stringify(state) !== JSON.stringify(scrubbed) || JSON.stringify(scrubbed) !== JSON.stringify(input),
        ok: evidenceComplete,
        reason: evidenceComplete ? undefined : "incomplete-evidence",
        coverage,
    };
}

/** Questions contain only code-written rubrics and opaque IDs. Scrub text defensively anyway. */
export function buildQuestions(questions, root) {
    const output = {};
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
    for (const [key, question] of Object.entries(questions ?? {})) {
        if (
            !identifier.test(key) ||
            !["noul", "choice", "score"].includes(question?.type) ||
            typeof question.instructions !== "string"
        ) {
            return undefined;
        }

        const clean = (text) => (typeof text === "string" ? redact(text, root) : undefined);
        const criteria =
            question.type === "score"
                ? Array.isArray(question.criteria)
                    ? question.criteria.map(clean)
                    : undefined
                : question.type === "choice" && question.criteria && !Array.isArray(question.criteria)
                  ? Object.fromEntries(Object.entries(question.criteria).map(([id, text]) => [id, clean(text)]))
                  : undefined;
        if (question.type !== "noul" && (!criteria || Object.values(criteria).some((value) => value === undefined))) {
            return undefined;
        }

        if (
            question.type === "choice" &&
            Object.keys(criteria).some((id) => !identifier.test(id) || redact(id, root) !== id)
        ) {
            return undefined;
        }

        output[key] = {
            type: question.type,
            instructions: clean(question.instructions),
            ...(criteria ? { criteria } : {}),
        };
    }

    return Object.keys(output).length > 0 && size(output) <= 32 * 1024 ? output : undefined;
}

/** At most twelve short lines from across the result, not a complete copy or a detector. */
export function outline(text, maxLines = 6, samples = 4) {
    const raw = String(text ?? "");
    // Redact multiline spans before sampling can detach a key body from its BEGIN/END markers.
    const lines = redact(raw).split(/\r?\n/u);
    const head = lines.slice(0, maxLines).map((line) => compact(line, 80));
    const tail = lines.length > maxLines * 2 ? lines.slice(-2).map((line) => compact(line, 80)) : [];
    const from = head.length;
    const to = lines.length - tail.length;
    const middle = [];
    if (samples > 0 && to - from > 0) {
        const step = Math.max(1, Math.floor((to - from) / samples));
        for (let index = from; index < to && middle.length < samples; index += step) {
            const line = compact(lines[index], 80);
            if (line.length > 0) {
                middle.push(line);
            }
        }
    }

    return { bytes: Buffer.byteLength(raw, "utf8"), lines: raw.split(/\r?\n/u).length, head, middle, tail };
}
