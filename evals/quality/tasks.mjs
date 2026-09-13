export const baselineCommit = "6f63ef8fdfff7f5409fdf71f6e5f1362a61aedd6";

// Sanitized reproductions of common harness/application failures, not private session extracts.
// The oracle and reference repairs live outside the materialized candidate workspace.
export const tasks = [
    {
        id: "page-boundary",
        category: "small-fix",
        request:
            "Fix pageInfo so a full final page does not offer a nonexistent next page. Preserve its API and empty-list behavior.",
        acceptance: ["Exact final pages stop", "Partial and empty pages stop", "Earlier pages continue"],
        review: "Do not add a pagination framework for this boundary correction.",
        files: {
            "main.mjs": `export function pageInfo(total, page, size) {
    return { hasNext: total >= (page + 1) * size, count: Math.max(0, Math.min(size, total - page * size)) };
}
`,
        },
    },
    {
        id: "explicit-zero",
        category: "small-fix",
        request:
            "A retry budget of zero must disable retries; an omitted or null budget must use the default of three. Preserve retryDelay's public API.",
        acceptance: ["Explicit zero is preserved", "Omitted/null values use three", "Positive values stay unchanged"],
        review: "Avoid broad input normalization that changes the supported contract.",
        files: {
            "main.mjs": `export function retryDelay(options = {}) {
    return { retries: options.retries || 3, delayMs: options.delayMs ?? 100 };
}
`,
        },
    },
    {
        id: "caller-migration",
        category: "multi-file",
        request:
            "Migrate formatAmount from a positional currency argument to an options object with currency. Update every in-repository caller and preserve the existing cart and invoice output. The formatter is an internal module; its old positional signature need not remain supported.",
        acceptance: ["New options signature works", "Cart still formats EUR", "Invoice still formats GBP"],
        review: "Find the invoice caller as well as the top-level cart entry point; keep one formatter.",
        files: {
            "format.mjs": `export function formatAmount(cents, currency = "USD") {
    return currency + " " + (cents / 100).toFixed(2);
}
`,
            "main.mjs": `import { formatAmount } from "./format.mjs";
export function cartTotal(cents) {
    return formatAmount(cents, "EUR");
}
`,
            "billing/invoice.mjs": `import { formatAmount } from "../format.mjs";
export function invoiceTotal(cents) {
    return formatAmount(cents, "GBP");
}
`,
        },
    },
    {
        id: "path-boundary",
        category: "security-boundary",
        request:
            "Fix isWithin so a sibling directory whose name begins with the root name is excluded. Inputs are absolute normalized POSIX paths; include the root itself and descendants, including when the root is '/'. Do not widen the supported input contract.",
        acceptance: ["Root and descendants accepted", "Prefix siblings rejected", "Filesystem root handled"],
        review: "Preserve the trust boundary; do not substitute string truncation for containment.",
        files: {
            "main.mjs": `export function isWithin(root, candidate) {
    return candidate.startsWith(root);
}
`,
        },
    },
    {
        id: "stale-check",
        category: "verification",
        request:
            "Fix receiptFresh so changing any declared source, test or config bytes invalidates a receipt even when Git HEAD is unchanged. Preserve order independence. Inputs are objects mapping relative paths to UTF-8 strings. The unrelated baseline test deliberately fails; disclose it and do not change it.",
        acceptance: [
            "Identical inputs pass regardless of key order",
            "Changed/added/deleted input invalidates",
            "Unrelated failure is preserved",
        ],
        review: "The input manifest defines the bound; do not claim this verifies external dependencies or requirement coverage.",
        files: {
            "main.mjs": `export function receiptFresh(before, after) {
    return before.head === after.head;
}
`,
            "known-baseline.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
test("upstream service fixture is unavailable", () => {
    assert.equal("unavailable", "ready");
});
`,
        },
    },
    {
        id: "browser-persistence",
        category: "browser",
        request:
            "The name form says it saved but loses the name after reload. Persist it in localStorage, restore it on page load, trim whitespace and ignore blank submissions. Keep text safe when the name contains HTML characters. The page is served on a fresh local origin.",
        acceptance: [
            "Submit persists across reload",
            "Blank input does not overwrite",
            "HTML-like input is displayed as text",
        ],
        review: "Exercise the actual browser flow; seeing a 'Saved' label is insufficient.",
        files: {
            "index.html": `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Profile</title>
<form><label>Name <input name="name"></label><button>Save</button></form>
<p role="status"></p><p id="saved"></p>
<script type="module" src="./app.mjs"></script></html>
`,
            "app.mjs": `const form = document.querySelector("form");
const saved = document.querySelector("#saved");
form.addEventListener("submit", (event) => {
    event.preventDefault();
    saved.textContent = form.elements.name.value;
    document.querySelector('[role="status"]').textContent = "Saved";
});
`,
        },
    },
    {
        id: "existing-reuse",
        category: "simplicity",
        request:
            "The list view shows raw status codes while the detail view shows labels. Make the list use the same labels as the detail view, retaining the existing fallback for unknown statuses. Use the existing source of truth instead of duplicating the mapping.",
        acceptance: ["Known labels agree", "Unknown fallback agrees", "A single status-label mapping remains"],
        review: "Check existing statusLabel before introducing another mapping or formatter abstraction.",
        files: {
            "status.mjs": `const labels = { pending: "Awaiting review", done: "Complete" };
export function statusLabel(value) {
    return labels[value] ?? "Unknown";
}
`,
            "detail.mjs": `import { statusLabel } from "./status.mjs";
export function detail(value) {
    return "Status: " + statusLabel(value);
}
`,
            "main.mjs": `export function list(values) {
    return values.map((value) => "Status: " + value);
}
`,
        },
    },
    {
        id: "intentional-interface",
        category: "negative-control",
        request:
            "Review this formatter registry for unnecessary complexity. Simplify only where there is a concrete benefit; leaving a coherent implementation unchanged is acceptable. Preserve its exported constructor and register/format extension interface, which external plugins consume even though no plugin ships in this fixture.",
        acceptance: [
            "External registration still works",
            "Duplicate registration still fails",
            "Unknown formats still fail",
        ],
        review: "Do not remove the intentional extension point because local consumers are absent. No change can be the correct outcome.",
        files: {
            "main.mjs": `export class FormatterRegistry {
    #formatters = new Map();
    register(name, format) {
        if (this.#formatters.has(name)) {
            throw new Error("Duplicate formatter");
        }
        this.#formatters.set(name, format);
    }
    format(name, value) {
        const format = this.#formatters.get(name);
        if (!format) {
            throw new Error("Unknown formatter");
        }
        return format(value);
    }
}
`,
        },
    },
];
