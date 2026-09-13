// Authored, public fixtures. Requirements are visible; acceptance inputs and
// reference solutions stay outside the candidate workspace. Difficulty is an
// initial design label, not an observed model score.
export const challengeTasks = [
    {
        id: "unicode-tail",
        category: "text-editing",
        difficulty: "easy",
        request:
            "tailText receives valid UTF-8 text and a nonnegative integer byte budget. Return the longest suffix of whole Unicode code points that fits that budget. Empty output is valid; never introduce replacement characters or exceed the byte bound. Preserve the exported function.",
        acceptance: ["Byte limit", "Whole code points", "Zero and oversized budgets"],
        files: {
            "main.mjs": `export function tailText(text, budget) {
    return Buffer.from(text).subarray(-budget).toString("utf8");
}
`,
        },
    },
    {
        id: "stable-sort",
        category: "compatibility",
        difficulty: "easy",
        request:
            "sortedJobs must return jobs in descending numeric priority, retaining input order for equal priorities. Callers retain and may freeze the input array. Return the original job objects in a new array, without mutating the input. Negative and zero priorities are supported.",
        acceptance: ["Correct numeric order", "Stable ties", "Input and object identity preserved"],
        files: {
            "main.mjs": `export function sortedJobs(jobs) {
    return jobs.sort((a, b) => b.priority - a.priority);
}
`,
        },
    },
    {
        id: "csv-record",
        category: "parsing",
        difficulty: "medium",
        request:
            "Implement parseRecord for one CSV record without its trailing record separator. Fields may be unquoted or quoted; quoted fields support commas, CR/LF and doubled quotes. Preserve empty and trailing fields. Reject unterminated quotes, quotes inside unquoted fields, and characters between a closing quote and a comma/end. Do not trim or coerce field text. An empty record is one empty field.",
        acceptance: ["Quoted separators and escaped quotes", "Empty fields", "Malformed input rejected"],
        files: {
            "main.mjs": `export function parseRecord(record) {
    return record.split(",");
}
`,
        },
    },
    {
        id: "config-precedence",
        category: "negative-control",
        domain: "configuration",
        difficulty: "easy",
        request:
            "Assess resolveOptions against this supported API and change it only if necessary. It accepts cli/env objects and defaults. Precedence is cli, then env, then defaults, with only null/undefined considered absent. False, zero and empty string are explicit values. Only keys present in defaults are returned. Never mutate inputs or add validation that narrows this contract.",
        acceptance: ["Falsy overrides survive", "Nullish precedence", "Only declared keys"],
        files: {
            "main.mjs": `export function resolveOptions(cli, env, defaults) {
    return Object.fromEntries(Object.keys(defaults).map((key) => [key, cli[key] ?? env[key] ?? defaults[key]]));
}
`,
        },
    },
    {
        id: "ttl-cache",
        category: "negative-control",
        domain: "state",
        difficulty: "medium",
        request:
            "Review TtlCache for a demonstrated contract violation and repair only if needed. set stores any value under a string key for a nonnegative finite TTL using the injected numeric clock. get returns undefined for absent/expired entries. Expiration includes the exact deadline. Zero TTL never hits. Reading must not extend lifetime. Replacing a key resets its TTL. Values are intentionally shared by reference.",
        acceptance: ["Deadline boundary", "No sliding expiry", "Replacement and falsy values"],
        files: {
            "main.mjs": `export class TtlCache {
    #values = new Map();
    constructor(now) { this.now = now; }
    set(key, value, ttl) { this.#values.set(key, { value, expires: this.now() + ttl }); }
    get(key) {
        const entry = this.#values.get(key);
        if (!entry || this.now() >= entry.expires) {
            this.#values.delete(key);
            return undefined;
        }
        return entry.value;
    }
}
`,
        },
    },
    {
        id: "inflight-invalidation",
        category: "concurrency",
        difficulty: "hard",
        request:
            "The async cache sometimes returns a value from before invalidation. Repair createCache across cache.mjs and its loader boundary. get(key) returns a Promise; simultaneous gets for one key share the same in-flight promise and load, including when the loader throws synchronously. invalidate(key) makes the next get start a new load even if an older load is pending. Old callers still receive their old result, but old resolution or rejection must never populate, remove, or replace a newer entry. Failures are not cached; successful undefined values are cached. Different keys are independent.",
        acceptance: [
            "In-flight identity and deduplication",
            "Invalidation with both settlement orders",
            "Rejection retry and undefined caching",
        ],
        files: {
            "cache.mjs": `import { startLoad } from "./loader.mjs";
export function createCache(load) {
    const values = new Map();
    const pending = new Map();
    return {
        get(key) {
            if (values.has(key)) { return Promise.resolve(values.get(key)); }
            if (pending.has(key)) { return pending.get(key); }
            const request = startLoad(load, key).then((value) => {
                values.set(key, value);
                pending.delete(key);
                return value;
            }, (error) => {
                pending.delete(key);
                throw error;
            });
            pending.set(key, request);
            return request;
        },
        invalidate(key) { values.delete(key); pending.delete(key); },
    };
}
`,
            "loader.mjs": `export function startLoad(load, key) {
    return Promise.resolve().then(() => load(key));
}
`,
            "main.mjs": `export { createCache } from "./cache.mjs";
`,
        },
    },
    {
        id: "once-reentrancy",
        category: "concurrency",
        difficulty: "medium",
        request:
            "Fix Events.once for re-entrant emits. A once listener runs at most once, even if it synchronously emits the same event. Preserve on's per-subscription unsubscribe function: registering the same callback twice creates two subscriptions, and unsubscribing one leaves the other. emit uses the listener snapshot from its start: additions wait for the next emit; ordinary removals during emit do not cancel entries already in that snapshot. Removing a once subscription before emit prevents it. Preserve event arguments and callback exceptions.",
        acceptance: ["Once under nested emit", "Duplicate subscriptions", "Snapshot iteration semantics"],
        files: {
            "main.mjs": `export class Events {
    #listeners = new Map();
    on(name, callback) {
        const list = this.#listeners.get(name) ?? [];
        list.push(callback);
        this.#listeners.set(name, list);
        return () => { this.#listeners.set(name, (this.#listeners.get(name) ?? []).filter((item) => item !== callback)); };
    }
    once(name, callback) {
        const remove = this.on(name, (...args) => { callback(...args); remove(); });
        return remove;
    }
    emit(name, ...args) {
        for (const callback of [...(this.#listeners.get(name) ?? [])]) { callback(...args); }
    }
}
`,
        },
    },
    {
        id: "bounded-map",
        category: "concurrency",
        difficulty: "hard",
        request:
            "mapLimit(items, limit, work) must execute at most limit jobs concurrently, dispatch each item once with its index, and return results in input order. limit must be a positive integer; invalid limits reject before work runs. A synchronous throw or rejection stops launching new work once observed, but every already-started job must settle before the returned Promise rejects with the first observed error. Successful empty input returns []. Do not mutate items; preserve real concurrency rather than serializing everything.",
        acceptance: [
            "Bounded concurrent dispatch",
            "Ordered results",
            "Drain started jobs on failure",
            "Invalid limits",
        ],
        files: {
            "main.mjs": `export async function mapLimit(items, limit, work) {
    const results = [];
    for (let index = 0; index < items.length; index += limit) {
        results.push(...await Promise.all(items.slice(index, index + limit).map(work)));
    }
    return results;
}
`,
        },
    },
    {
        id: "abort-retry",
        category: "cancellation",
        difficulty: "hard",
        request:
            "Repair retry(operation, { attempts, signal, sleep }). attempts is a positive integer total attempt count. operation receives the zero-based index and signal. Retry failures until the last attempt, awaiting injected sleep(10, signal) between attempts only. Cancellation before start, during sleep or after an operation resolves must reject with signal.reason and prevent further operations. A sleep rejection is terminal. The final operation error is preserved. Validate attempts before doing work. Do not add timers; the injected sleep owns waiting.",
        acceptance: [
            "Total attempt count and terminal error",
            "Cancellation at three boundaries",
            "No extra sleeps or operations",
        ],
        files: {
            "main.mjs": `export async function retry(operation, { attempts, signal, sleep }) {
    for (let index = 0; index <= attempts; index += 1) {
        try { return await operation(index, signal); }
        catch (error) {
            if (index === attempts) { throw error; }
            await sleep(10, signal);
        }
    }
}
`,
        },
    },
    {
        id: "transaction-rollback",
        category: "persistence",
        difficulty: "hard",
        request:
            "applyBatch writes a batch through the injected async store. Fix partial failure recovery. Capture every distinct target's existence/value before any write. Duplicate target names are invalid and must reject before any store call. Operations run in order. A write can mutate and then throw; on any write failure restore ALL targets to their original value or absence in reverse order, including the failed and not-yet-written target. Return true only on full success. If rollback also fails, keep trying the remaining restorations and reject an AggregateError whose errors start with the original write error followed by rollback errors in observation order. If rollback succeeds, rethrow the original error object. Snapshot failures perform no writes. The store uses has/read/write/remove and all values are strings.",
        acceptance: [
            "Success and duplicate preflight",
            "Mutate-then-throw rollback",
            "Absent file restoration",
            "Rollback errors aggregated",
        ],
        files: {
            "store.mjs": `export async function snapshot(store, names) {
    const result = [];
    for (const name of names) {
        const exists = await store.has(name);
        result.push({ name, exists, value: exists ? await store.read(name) : undefined });
    }
    return result;
}
`,
            "main.mjs": `import { snapshot } from "./store.mjs";
export async function applyBatch(store, changes) {
    const before = await snapshot(store, changes.map((change) => change.name));
    const written = [];
    try {
        for (const change of changes) { await store.write(change.name, change.value); written.push(change.name); }
        return true;
    } catch (error) {
        for (const name of written.reverse()) {
            const item = before.find((entry) => entry.name === name);
            if (item.exists) { await store.write(name, item.value); } else { await store.remove(name); }
        }
        throw error;
    }
}
`,
        },
    },
    {
        id: "schema-migration",
        category: "configuration",
        difficulty: "medium",
        request:
            "migrate upgrades schema 1 settings to schema 2 by moving the own top-level theme property to display.theme. Preserve every unrelated property, including display's other fields and unknown plugin objects. The legacy theme wins if both exist, including an empty string. If no legacy theme exists, do not invent one. Schema 2 inputs return an independent deep clone unchanged. Reject unknown/missing versions. Inputs are JSON objects with optional object display. Do not mutate any input or share nested objects with the result.",
        acceptance: [
            "Selective migration",
            "Unknown settings survive",
            "Idempotence and deep independence",
            "Unsupported version rejected",
        ],
        files: {
            "main.mjs": `export function migrate(settings) {
    return { ...settings, version: 2, display: { theme: settings.theme || "dark" } };
}
`,
        },
    },
    {
        id: "canonical-key",
        category: "parsing",
        difficulty: "medium",
        request:
            "canonicalKey generates a deterministic string for JSON values. Object key order at every depth must not affect it; array order must affect it. Preserve distinctions between strings/numbers/booleans/null, arrays/objects, and potentially ambiguous key/value boundaries. Inputs are acyclic JSON values; numbers are finite. Do not mutate them. Property names such as __proto__ are ordinary own data keys. No cryptographic hash is required.",
        acceptance: [
            "Recursive object order independence",
            "Array/type distinctions",
            "Adversarial keys and boundaries",
        ],
        files: {
            "main.mjs": `export function canonicalKey(value) {
    if (value && typeof value === "object") {
        return Object.keys(value).sort().map((key) => key + ":" + canonicalKey(value[key])).join(",");
    }
    return String(value);
}
`,
        },
    },
    {
        id: "pagination-merge",
        category: "multi-file",
        difficulty: "medium",
        request:
            "collect(fetchPage) consumes pages starting with cursor null. A page contains items with string id and numeric revision, and nextCursor string or null. Empty pages can have a next cursor and must continue. Stop only at null. Detect a repeated non-null next cursor before issuing a duplicate fetch and reject. Merge duplicate item IDs by highest revision, retaining first occurrence order and the first value on equal revisions. Fetch sequentially and do not mutate page data. Preserve fetch errors.",
        acceptance: ["Empty pages continue", "Stable merge by revision", "Cursor cycles fail", "No source mutation"],
        files: {
            "merge.mjs": `export function mergeItems(items) { return [...new Map(items.map((item) => [item.id, item])).values()]; }
`,
            "main.mjs": `import { mergeItems } from "./merge.mjs";
export async function collect(fetchPage) {
    let cursor = null;
    const items = [];
    do {
        const page = await fetchPage(cursor);
        items.push(...page.items);
        cursor = page.items.length ? page.nextCursor : null;
    } while (cursor !== null);
    return mergeItems(items);
}
`,
        },
    },
    {
        id: "archive-boundary",
        category: "security-boundary",
        difficulty: "medium",
        request:
            "safeEntry checks an archive entry name before extraction on either Windows or POSIX. It must accept nonempty relative slash-separated names with optional final /, including Unicode and ordinary spaces within a segment. Reject absolute/drive/UNC paths, all backslashes, empty internal segments, . or .. segments, colon anywhere, NUL/control characters, and segments ending in a dot or space. Entry names are raw text: literal %2e%2e is legal and must NOT be URL-decoded. Do not touch the filesystem.",
        acceptance: [
            "Cross-platform traversal denied",
            "Special Windows spelling denied",
            "Ordinary relative paths preserved",
        ],
        files: {
            "main.mjs": `export function safeEntry(name) {
    return typeof name === "string" && !name.includes("../") && !name.startsWith("/");
}
`,
        },
    },
    {
        id: "stream-lines",
        category: "text-editing",
        difficulty: "hard",
        request:
            "createLines(emit) incrementally decodes valid UTF-8 Buffer chunks and emits text lines. Delimiters are LF, CRLF and standalone CR. A CR split from a following LF counts once. Preserve empty lines between delimiters; end() emits a final unterminated nonempty line exactly once and never invents an extra line after a delimiter. UTF-8 characters can span chunks. write after end must throw; a repeated end is harmless. Empty writes are harmless. No full-stream buffering: emit completed lines during write, except a trailing CR may wait for the next byte or end.",
        acceptance: [
            "Every byte split of UTF-8 and CRLF",
            "Empty and terminal lines",
            "Incremental emission and lifecycle",
        ],
        files: {
            "main.mjs": `export function createLines(emit) {
    let pending = "";
    return {
        write(chunk) {
            pending += chunk.toString("utf8");
            const parts = pending.split("\\n");
            pending = parts.pop();
            for (const line of parts) { emit(line); }
        },
        end() { emit(pending); pending = ""; },
    };
}
`,
        },
    },
    {
        id: "tenant-cache",
        category: "security-boundary",
        difficulty: "hard",
        request:
            "The report service is occasionally showing another tenant's result. Fix identity across api.mjs, cache.mjs and transport.mjs. Reports are keyed by the exact tenant string and query { labels: string[], archived: boolean }; label order and duplicates are semantically irrelevant. Tenant/label strings can contain delimiters and __proto__. Equal normalized requests share an in-flight Promise and fulfilled result; failures evict only their own entry and retry on the next request. Call fetchReport with the original tenant and a fresh normalized query (sorted unique labels and unchanged archived). Never mutate caller input. Preserve synchronous transport throws as Promise rejections. Different tenant, label sets or archived flags must not share data.",
        acceptance: [
            "Tenant isolation and collision-free identity",
            "Equivalent query deduplication",
            "Failure retry",
            "Immutable normalized transport",
        ],
        files: {
            "api.mjs": `import { memoizeReport } from "./cache.mjs";
import { requestReport } from "./transport.mjs";
export function createReports(fetchReport) {
    return memoizeReport((tenant, query) => requestReport(fetchReport, tenant, query));
}
`,
            "cache.mjs": `export function memoizeReport(load) {
    const values = new Map();
    return (tenant, query) => {
        const key = query.labels.sort().join(",");
        if (!values.has(key)) { values.set(key, Promise.resolve(load(tenant, query))); }
        return values.get(key);
    };
}
`,
            "transport.mjs": `export function requestReport(fetchReport, tenant, query) { return fetchReport(tenant, query); }
`,
        },
    },
    {
        id: "public-hooks",
        category: "negative-control",
        domain: "compatibility",
        difficulty: "medium",
        request:
            "Assess Pipeline for a concrete problem before simplifying it. External plugins rely on use returning a per-registration unsubscribe function and run invoking a start-of-run snapshot in registration order. Hooks may be async and transform a value; failures stop the pipeline. Duplicate callback registrations are independent. Plugin changes during a run affect later runs only. Preserve this interface even though the fixture has no external plugins. No-op is acceptable.",
        acceptance: [
            "Async ordered transforms",
            "Independent registration disposal",
            "Run snapshot and failure semantics",
        ],
        files: {
            "main.mjs": `export class Pipeline {
    #hooks = [];
    use(callback) {
        const entry = { callback };
        this.#hooks.push(entry);
        return () => { this.#hooks = this.#hooks.filter((item) => item !== entry); };
    }
    async run(value) {
        const hooks = [...this.#hooks];
        for (const hook of hooks) { value = await hook.callback(value); }
        return value;
    }
}
`,
        },
    },
    {
        id: "lazy-iterator",
        category: "compatibility",
        domain: "compatibility",
        difficulty: "hard",
        request:
            "Review take(source, count) for a demonstrated API violation and repair only if necessary. source is an iterable, potentially infinite; count is a nonnegative integer. It returns a lazy iterable yielding up to count source values. Zero count must not acquire the source iterator. Never pull one extra value. Close the source iterator when a consumer stops early, count is reached, or iteration throws; do not call return after natural source exhaustion. Preserve yielded identities and source exceptions. External callers depend on laziness.",
        acceptance: ["No eager or extra reads", "Early and error cleanup", "Natural exhaustion and zero count"],
        files: {
            "main.mjs": `export function* take(source, count) {
    if (count === 0) { return; }
    const iterator = source[Symbol.iterator]();
    let exhausted = false;
    try {
        for (let index = 0; index < count; index += 1) {
            const item = iterator.next();
            if (item.done) { exhausted = true; return; }
            yield item.value;
        }
    } finally {
        if (!exhausted) { iterator.return?.(); }
    }
}
`,
        },
    },
    {
        id: "browser-search-race",
        category: "browser",
        difficulty: "hard",
        request:
            "Fix the search form so the latest submitted query owns results and status. Requests can resolve or reject in any order. Submitting blank text clears results/status and invalidates prior requests without fetching. Trim nonblank queries, encode them in /search?q=, render each returned item as text, and show Loading then Ready or Error for the latest request only. Clearing/replacing results must not remove the input or submit button. A response has JSON { items: string[] }; a non-OK HTTP response is an error. Keep form keyboard submission usable.",
        acceptance: [
            "Out-of-order success and rejection",
            "Blank invalidation",
            "Safe text and HTTP errors",
            "Keyboard usability",
        ],
        files: {
            "index.html": `<!doctype html><html lang="en"><meta charset="utf-8"><title>Search</title>
<form><label>Query <input name="query"></label><button>Search</button></form><p role="status"></p><ul id="results"></ul>
<script type="module" src="./app.mjs"></script></html>
`,
            "app.mjs": `const form = document.querySelector("form");
const results = document.querySelector("#results");
const status = document.querySelector('[role="status"]');
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "Loading";
    try {
        const response = await fetch("/search?q=" + form.elements.query.value);
        const data = await response.json();
        results.innerHTML = data.items.map((item) => "<li>" + item + "</li>").join("");
        status.textContent = "Ready";
    } catch { status.textContent = "Error"; }
});
`,
        },
    },
    {
        id: "browser-storage-failure",
        category: "browser",
        difficulty: "medium",
        request:
            "Repair the preference form's handling of localStorage failures. The existing key is preference and valid values are light/dark. Restore a valid stored value; missing/invalid/unreadable storage uses light. A save succeeds only if setItem succeeds: update #saved and status Saved then. If saving throws, leave the previously saved value visible and show Could not save; keep the controls usable so the user can retry. Input selection may differ from saved value after failure. Never claim a failed write was saved. Preserve the existing key and values.",
        acceptance: [
            "Restore existing values",
            "Unreadable and invalid storage fallback",
            "Failed write preserves saved state",
            "Retry succeeds",
        ],
        files: {
            "index.html": `<!doctype html><html lang="en"><meta charset="utf-8"><title>Preference</title>
<form><label>Theme <select name="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label><button>Save</button></form>
<p id="saved"></p><p role="status"></p><script type="module" src="./app.mjs"></script></html>
`,
            "app.mjs": `const form = document.querySelector("form");
const saved = document.querySelector("#saved");
const status = document.querySelector('[role="status"]');
saved.textContent = localStorage.getItem("preference") || "light";
form.elements.theme.value = saved.textContent;
form.addEventListener("submit", (event) => {
    event.preventDefault();
    saved.textContent = form.elements.theme.value;
    status.textContent = "Saved";
    localStorage.setItem("preference", saved.textContent);
});
`,
        },
    },
];
