// Independent reference implementations qualify graders; never sent to a model.
export const challengeReference = {
    "unicode-tail": {
        "main.mjs": `export function tailText(text, budget) {
    let result = "";
    for (const character of [...text].reverse()) {
        if (Buffer.byteLength(character + result) > budget) { break; }
        result = character + result;
    }
    return result;
}
`,
    },
    "stable-sort": {
        "main.mjs": `export function sortedJobs(jobs) { return [...jobs].sort((a, b) => b.priority - a.priority); }
`,
    },
    "csv-record": {
        "main.mjs": `export function parseRecord(record) {
    const fields = [];
    let field = "";
    let quoted = false;
    let closed = false;
    for (let index = 0; index < record.length; index += 1) {
        const character = record[index];
        if (quoted) {
            if (character === '"') {
                if (record[index + 1] === '"') { field += '"'; index += 1; }
                else { quoted = false; closed = true; }
            } else { field += character; }
        } else if (character === ",") {
            fields.push(field); field = ""; closed = false;
        } else if (closed) { throw new Error("Characters after closing quote"); }
        else if (character === '"') {
            if (field.length) { throw new Error("Quote in unquoted field"); }
            quoted = true;
        } else { field += character; }
    }
    if (quoted) { throw new Error("Unterminated quote"); }
    return [...fields, field];
}
`,
    },
    "config-precedence": {},
    "ttl-cache": {},
    "inflight-invalidation": {
        "cache.mjs": `import { startLoad } from "./loader.mjs";
export function createCache(load) {
    const values = new Map();
    const pending = new Map();
    return {
        get(key) {
            if (values.has(key)) { return Promise.resolve(values.get(key)); }
            if (pending.has(key)) { return pending.get(key); }
            const request = startLoad(load, key).then((value) => {
                if (pending.get(key) === request) { values.set(key, value); pending.delete(key); }
                return value;
            }, (error) => {
                if (pending.get(key) === request) { pending.delete(key); }
                throw error;
            });
            pending.set(key, request);
            return request;
        },
        invalidate(key) { values.delete(key); pending.delete(key); },
    };
}
`,
    },
    "once-reentrancy": {
        "main.mjs": `export class Events {
    #listeners = new Map();
    on(name, callback) {
        const entry = { callback };
        const list = this.#listeners.get(name) ?? [];
        list.push(entry); this.#listeners.set(name, list);
        return () => { this.#listeners.set(name, (this.#listeners.get(name) ?? []).filter((item) => item !== entry)); };
    }
    once(name, callback) {
        let fired = false;
        const remove = this.on(name, (...args) => {
            if (fired) { return; }
            fired = true; remove(); callback(...args);
        });
        return remove;
    }
    emit(name, ...args) { for (const entry of [...(this.#listeners.get(name) ?? [])]) { entry.callback(...args); } }
}
`,
    },
    "bounded-map": {
        "main.mjs": `export async function mapLimit(items, limit, work) {
    if (!Number.isInteger(limit) || limit < 1) { throw new Error("Invalid limit"); }
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    let failure;
    const worker = async () => {
        while (!failed && next < items.length) {
            const index = next++;
            try { results[index] = await work(items[index], index); }
            catch (error) { if (!failed) { failed = true; failure = error; } }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failed) { throw failure; }
    return results;
}
`,
    },
    "abort-retry": {
        "main.mjs": `export async function retry(operation, { attempts, signal, sleep }) {
    if (!Number.isInteger(attempts) || attempts < 1) { throw new Error("Invalid attempts"); }
    for (let index = 0; index < attempts; index += 1) {
        signal?.throwIfAborted();
        try {
            const value = await operation(index, signal);
            signal?.throwIfAborted();
            return value;
        } catch (error) {
            signal?.throwIfAborted();
            if (index + 1 === attempts) { throw error; }
        }
        await sleep(10, signal);
    }
}
`,
    },
    "transaction-rollback": {
        "main.mjs": `import { snapshot } from "./store.mjs";
export async function applyBatch(store, changes) {
    if (new Set(changes.map((change) => change.name)).size !== changes.length) { throw new Error("Duplicate target"); }
    const before = await snapshot(store, changes.map((change) => change.name));
    try {
        for (const change of changes) { await store.write(change.name, change.value); }
        return true;
    } catch (error) {
        const failures = [];
        for (const item of [...before].reverse()) {
            try {
                if (item.exists) { await store.write(item.name, item.value); }
                else { await store.remove(item.name); }
            } catch (rollback) { failures.push(rollback); }
        }
        if (failures.length) { throw new AggregateError([error, ...failures], "Batch and rollback failed"); }
        throw error;
    }
}
`,
    },
    "schema-migration": {
        "main.mjs": `export function migrate(settings) {
    if (settings.version !== 1 && settings.version !== 2) { throw new Error("Unsupported version"); }
    const result = structuredClone(settings);
    if (result.version === 1) {
        result.version = 2;
        if (Object.hasOwn(result, "theme")) {
            result.display = { ...result.display, theme: result.theme };
            delete result.theme;
        }
    }
    return result;
}
`,
    },
    "canonical-key": {
        "main.mjs": `export function canonicalKey(value) {
    if (Array.isArray(value)) { return "[" + value.map(canonicalKey).join(",") + "]"; }
    if (value !== null && typeof value === "object") {
        return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalKey(value[key])).join(",") + "}";
    }
    return JSON.stringify(value);
}
`,
    },
    "pagination-merge": {
        "merge.mjs": `export function mergeItems(items) {
    const result = new Map();
    for (const item of items) {
        if (!result.has(item.id) || result.get(item.id).revision < item.revision) { result.set(item.id, item); }
    }
    return [...result.values()];
}
`,
        "main.mjs": `import { mergeItems } from "./merge.mjs";
export async function collect(fetchPage) {
    let cursor = null;
    const seen = new Set();
    const items = [];
    do {
        const page = await fetchPage(cursor);
        items.push(...page.items);
        cursor = page.nextCursor;
        if (cursor !== null) {
            if (seen.has(cursor)) { throw new Error("Repeated cursor"); }
            seen.add(cursor);
        }
    } while (cursor !== null);
    return mergeItems(items);
}
`,
    },
    "archive-boundary": {
        "main.mjs": `export function safeEntry(name) {
    if (typeof name !== "string" || !name || /[\\\\:\\u0000-\\u001f\\u007f]/u.test(name)) { return false; }
    const parts = name.replace(/\\/$/u, "").split("/");
    return parts.every((part) => part && part !== "." && part !== ".." && !/[. ]$/u.test(part));
}
`,
    },
    "stream-lines": {
        "main.mjs": `import { StringDecoder } from "node:string_decoder";
export function createLines(emit) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let ended = false;
    const drain = (final) => {
        let start = 0;
        for (let index = 0; index < pending.length; index += 1) {
            const char = pending[index];
            if (char === "\\r" || char === "\\n") {
                if (char === "\\r" && index + 1 === pending.length && !final) { break; }
                emit(pending.slice(start, index));
                if (char === "\\r" && pending[index + 1] === "\\n") { index += 1; }
                start = index + 1;
            }
        }
        pending = pending.slice(start);
    };
    return {
        write(chunk) {
            if (ended) { throw new Error("Stream ended"); }
            pending += decoder.write(chunk); drain(false);
        },
        end() {
            if (ended) { return; }
            ended = true; pending += decoder.end(); drain(true);
            if (pending) { emit(pending); pending = ""; }
        },
    };
}
`,
    },
    "tenant-cache": {
        "cache.mjs": `export function memoizeReport(load) {
    const values = new Map();
    return (tenant, query) => {
        const normalized = { labels: [...new Set(query.labels)].sort(), archived: query.archived };
        const key = JSON.stringify([tenant, normalized.labels, normalized.archived]);
        if (!values.has(key)) {
            const request = Promise.resolve().then(() => load(tenant, normalized)).catch((error) => {
                if (values.get(key) === request) { values.delete(key); }
                throw error;
            });
            values.set(key, request);
        }
        return values.get(key);
    };
}
`,
    },
    "public-hooks": {},
    "lazy-iterator": {
        "main.mjs": `export function* take(source, count) {
    if (count === 0) { return; }
    const iterator = source[Symbol.iterator]();
    let exhausted = false;
    let failed = false;
    try {
        for (let index = 0; index < count; index += 1) {
            const item = iterator.next();
            if (item.done) { exhausted = true; return; }
            yield item.value;
        }
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        if (!exhausted) {
            try { iterator.return?.(); }
            catch (error) { if (!failed) { throw error; } }
        }
    }
}
`,
    },
    "browser-search-race": {
        "app.mjs": `const form = document.querySelector("form");
const results = document.querySelector("#results");
const status = document.querySelector('[role="status"]');
let generation = 0;
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = ++generation;
    const query = form.elements.query.value.trim();
    results.replaceChildren();
    status.textContent = query ? "Loading" : "";
    if (!query) { return; }
    try {
        const response = await fetch("/search?q=" + encodeURIComponent(query));
        if (!response.ok) { throw new Error("HTTP failure"); }
        const data = await response.json();
        if (current !== generation) { return; }
        results.replaceChildren(...data.items.map((item) => { const li = document.createElement("li"); li.textContent = item; return li; }));
        status.textContent = "Ready";
    } catch { if (current === generation) { status.textContent = "Error"; } }
});
`,
    },
    "browser-storage-failure": {
        "app.mjs": `const form = document.querySelector("form");
const saved = document.querySelector("#saved");
const status = document.querySelector('[role="status"]');
let initial = "light";
try { const value = localStorage.getItem("preference"); if (["light", "dark"].includes(value)) { initial = value; } } catch {}
saved.textContent = initial;
form.elements.theme.value = initial;
form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        const value = form.elements.theme.value;
        localStorage.setItem("preference", value);
        saved.textContent = value; status.textContent = "Saved";
    } catch { status.textContent = "Could not save"; }
});
`,
    },
};
