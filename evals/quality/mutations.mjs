import fs from "node:fs";
import path from "node:path";

// One plausible incomplete repair or compatibility regression per task. Applied
// to the qualified reference, so rejection demonstrates more than seed coverage.
export const wrongRepairs = {
    "page-boundary": ["main.mjs", "total >", "total >=", "inclusive final boundary"],
    "explicit-zero": ["main.mjs", "options.retries ?? 3", "options.retries || 3", "falsy override lost"],
    "caller-migration": [
        "billing/invoice.mjs",
        'cents, { currency: "GBP" }',
        'cents, "GBP"',
        "missed secondary caller",
    ],
    "path-boundary": ["main.mjs", 'root === "/" || ', "", "filesystem root omitted"],
    "stale-check": [
        "main.mjs",
        "Object.keys(before.inputs).length === Object.keys(after.inputs).length && ",
        "",
        "added inputs ignored",
    ],
    "browser-persistence": ["app.mjs", "if (!value)", "if (false)", "blank overwrites stored value"],
    "existing-reuse": ["status.mjs", '?? "Unknown"', '?? "Missing"', "fallback compatibility changed"],
    "intentional-interface": [
        "main.mjs",
        "if (this.#formatters.has(name))",
        "if (false)",
        "extension duplicate contract removed",
    ],
    "unicode-tail": [
        "main.mjs",
        "Buffer.byteLength(character + result)",
        "(character + result).length",
        "code-unit length mistaken for byte length",
    ],
    "stable-sort": ["main.mjs", "b.priority - a.priority", "a.priority - b.priority", "wrong sort direction"],
    "csv-record": ["main.mjs", "if (quoted) { throw", "if (false) { throw", "unterminated quoted field accepted"],
    "config-precedence": [
        "main.mjs",
        "cli[key] ?? env[key] ?? defaults[key]",
        "cli[key] || env[key] || defaults[key]",
        "false and zero lost",
    ],
    "ttl-cache": [
        "main.mjs",
        "this.now() >= entry.expires",
        "this.now() > entry.expires",
        "exact deadline remains valid",
    ],
    "inflight-invalidation": [
        "cache.mjs",
        "if (pending.get(key) === request) { pending.delete(key); }",
        "pending.delete(key);",
        "old rejection evicts a replacement",
    ],
    "once-reentrancy": [
        "main.mjs",
        "fired = true; remove(); callback(...args);",
        "callback(...args); fired = true; remove();",
        "remove after reentrant callback",
    ],
    "bounded-map": [
        "main.mjs",
        "results[index] = await work(items[index], index)",
        "results.push(await work(items[index], index))",
        "completion order instead of input order",
    ],
    "abort-retry": [
        "main.mjs",
        "            signal?.throwIfAborted();\n            return value;",
        "            return value;",
        "late successful value bypasses cancellation",
    ],
    "transaction-rollback": ["main.mjs", "[...before].reverse()", "before", "forward rollback order"],
    "schema-migration": [
        "main.mjs",
        "structuredClone(settings)",
        "{ ...settings }",
        "nested plugin configuration aliased",
    ],
    "canonical-key": [
        "main.mjs",
        "Object.keys(value).sort()",
        "Object.keys(value)",
        "nested insertion order leaks into identity",
    ],
    "pagination-merge": [
        "merge.mjs",
        "result.get(item.id).revision < item.revision",
        "result.get(item.id).revision <= item.revision",
        "equal revision replaces first value",
    ],
    "archive-boundary": [
        "main.mjs",
        "!/[. ]$/u.test(part)",
        "true",
        "trailing-dot and trailing-space aliases admitted",
    ],
    "stream-lines": [
        "main.mjs",
        'if (char === "\\r" && pending[index + 1] === "\\n")',
        "if (false)",
        "CRLF counted twice",
    ],
    "tenant-cache": [
        "cache.mjs",
        "[tenant, normalized.labels, normalized.archived]",
        "[normalized.labels, normalized.archived]",
        "tenant missing from identity",
    ],
    "public-hooks": [
        "main.mjs",
        "item !== entry",
        "item.callback !== callback",
        "duplicate registrations share disposal",
    ],
    "lazy-iterator": ["main.mjs", "if (!exhausted)", "if (false)", "iterator cleanup removed"],
    "browser-search-race": [
        "app.mjs",
        'if (current === generation) { status.textContent = "Error"; }',
        'status.textContent = "Error";',
        "stale rejection overwrites current success",
    ],
    "browser-storage-failure": [
        "app.mjs",
        'localStorage.setItem("preference", value);\n        saved.textContent = value; status.textContent = "Saved";',
        'saved.textContent = value; status.textContent = "Saved";\n        localStorage.setItem("preference", value);',
        "visible saved state updated before write succeeds",
    ],
    "repo-output-streams": [
        "extensions/background-tasks/core.mjs",
        "this.decoders[stream].end()",
        '""',
        "decoder never flushed on finalization",
    ],
    "repo-slot-admission": [
        "extensions/background-tasks/core.mjs",
        'task.cleanup !== "confirmed"',
        'task.cleanup === "pending"',
        "unconfirmed cleanup no longer occupies a slot",
    ],
    "repo-receipt-freshness": [
        "extensions/background-tasks/verification.mjs",
        "receipt.outcome.exitCode === 0",
        "receipt.outcome.exitCode !== null",
        "nonzero exits treated as passing",
    ],
    "repo-command-redaction": [
        "extensions/command-guard/redact.mjs",
        "|access_token)=)",
        ")=)",
        "access_token query class missed",
    ],
};

export function applyWrongRepair(id, root) {
    const mutation = wrongRepairs[id];
    if (!mutation) {
        throw new Error(`No wrong-repair qualification for ${id}.`);
    }

    const [file, before, after] = mutation;
    const target = path.join(root, file);
    const source = fs.readFileSync(target, "utf8");
    if (!source.includes(before) || before === after) {
        throw new Error(`Wrong-repair mutation drifted: ${id}`);
    }

    fs.writeFileSync(target, source.replace(before, after));
}
