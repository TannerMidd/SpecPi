import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    promise.catch(() => {});

    return { promise, resolve, reject };
};

const ticks = async () => {
    for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
    }
};

async function withPage(root, chromium, run) {
    if (!chromium) {
        throw new Error("Chromium was not provisioned for the browser oracle.");
    }

    const server = createServer((request, response) => {
        const name = request.url === "/" ? "index.html" : request.url === "/app.mjs" ? "app.mjs" : null;
        if (!name) {
            response.writeHead(404).end();

            return;
        }

        response.setHeader("Content-Type", name.endsWith("html") ? "text/html" : "text/javascript");
        response.end(fs.readFileSync(path.join(root, name)));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.setDefaultTimeout(2500);
        await run(page, `http://127.0.0.1:${server.address().port}/`);
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

export const challengeOracles = {
    "unicode-tail": async ({ load, check }) => {
        const { tailText } = await load("main.mjs");
        await check("whole-codepoint-byte-suffixes", () => {
            const text = "abé😀界z";
            for (const [budget, expected] of [
                [0, ""],
                [1, "z"],
                [3, "z"],
                [4, "界z"],
                [7, "界z"],
                [8, "😀界z"],
                [10, "é😀界z"],
                [99, text],
            ]) {
                assert.equal(tailText(text, budget), expected);
                assert.ok(Buffer.byteLength(tailText(text, budget)) <= budget);
            }

            assert.equal(tailText("", 3), "");
        });
    },
    "stable-sort": async ({ load, check }) => {
        const { sortedJobs } = await load("main.mjs");
        await check("numeric-stable-order-with-frozen-input", () => {
            const jobs = Object.freeze(
                [{ priority: 0 }, { priority: 10 }, { priority: -2 }, { priority: 10 }].map(Object.freeze),
            );
            const result = sortedJobs(jobs);
            assert.deepEqual(result, [jobs[1], jobs[3], jobs[0], jobs[2]]);
            assert.notEqual(result, jobs);
            assert.equal(result[0], jobs[1]);
            assert.deepEqual(sortedJobs(Object.freeze([])), []);
        });
    },
    "csv-record": async ({ load, check }) => {
        const { parseRecord } = await load("main.mjs");
        await check("valid-csv-and-empty-fields", () => {
            for (const [record, expected] of [
                ["", [""]],
                [",,", ["", "", ""]],
                ['"a,b","c""d",', ["a,b", 'c"d', ""]],
                ['"line\r\nnext", x ', ["line\r\nnext", " x "]],
                ['"",a', ["", "a"]],
            ]) {
                assert.deepEqual(parseRecord(record), expected);
            }
        });
        await check("malformed-quotes-rejected", () => {
            for (const value of ['"unclosed', 'a"b', '"a"b', '"a" ,b', 'a,"b']) {
                assert.throws(() => parseRecord(value));
            }
        });
    },
    "config-precedence": async ({ load, check }) => {
        const { resolveOptions } = await load("main.mjs");
        await check("falsy-nullish-and-unknown-keys", () => {
            const defaults = Object.freeze({ retries: 3, label: "base", enabled: true, size: 4 });
            const cli = Object.freeze({ retries: 0, label: "", enabled: false, size: null, extra: 4 });
            assert.deepEqual(resolveOptions(cli, Object.freeze({ size: 8 }), defaults), {
                retries: 0,
                label: "",
                enabled: false,
                size: 8,
            });
            assert.deepEqual(resolveOptions({}, { size: null }, defaults), defaults);
        });
    },
    "ttl-cache": async ({ load, check }) => {
        const { TtlCache } = await load("main.mjs");
        await check("exact-expiration-without-read-extension", () => {
            let now = 0;
            const cache = new TtlCache(() => now);
            const value = { data: true };
            cache.set("x", value, 10);
            now = 9;
            assert.equal(cache.get("x"), value);
            now = 10;
            assert.equal(cache.get("x"), undefined);
            cache.set("x", false, 0);
            assert.equal(cache.get("x"), undefined);
            cache.set("x", 0, 10);
            now = 15;
            assert.equal(cache.get("x"), 0);
            cache.set("x", "", 3);
            now = 17;
            assert.equal(cache.get("x"), "");
            now = 18;
            assert.equal(cache.get("x"), undefined);
        });
    },
    "inflight-invalidation": async ({ load, check }) => {
        const { createCache } = await load("main.mjs");
        await check("old-success-cannot-replace-new-success", async () => {
            const first = deferred();
            const second = deferred();
            let calls = 0;
            const cache = createCache(() => (++calls === 1 ? first.promise : second.promise));
            const old = cache.get("a");
            assert.equal(cache.get("a"), old);
            await ticks();
            cache.invalidate("a");
            const fresh = cache.get("a");
            await ticks();
            second.resolve("new");
            assert.equal(await fresh, "new");
            first.resolve("old");
            assert.equal(await old, "old");
            assert.equal(await cache.get("a"), "new");
            assert.equal(calls, 2);
        });
        await check("old-rejection-cannot-evict-new-pending", async () => {
            const first = deferred();
            const second = deferred();
            let calls = 0;
            const cache = createCache(() => (++calls === 1 ? first.promise : second.promise));
            const old = cache.get("a");
            old.catch(() => {});
            await ticks();
            cache.invalidate("a");
            const fresh = cache.get("a");
            await ticks();
            first.reject(new Error("old"));
            await assert.rejects(old, /old/);
            assert.equal(cache.get("a"), fresh);
            second.resolve(undefined);
            await fresh;
            assert.equal(await cache.get("a"), undefined);
            assert.equal(calls, 2);
        });
        await check("synchronous-failure-retries-and-keys-stay-independent", async () => {
            let calls = 0;
            const cache = createCache((key) => {
                if (++calls === 1) {
                    throw new Error("first");
                }

                return key;
            });
            await assert.rejects(cache.get("a"), /first/);
            assert.equal(await cache.get("a"), "a");
            assert.equal(await cache.get("b"), "b");
        });
    },
    "once-reentrancy": async ({ load, check }) => {
        const { Events } = await load("main.mjs");
        await check("nested-emission-and-duplicate-subscriptions", () => {
            const events = new Events();
            let once = 0;
            let total = 0;
            events.once("x", (value) => {
                once += value;
                if (once < 3) {
                    events.emit("x", value);
                }
            });
            events.emit("x", 1);
            events.emit("x", 1);
            assert.equal(once, 1);
            const callback = () => {
                total += 1;
            };

            const remove = events.on("y", callback);
            events.on("y", callback);
            remove();
            remove();
            events.emit("y");
            assert.equal(total, 1);
            const cancel = events.once("z", callback);
            cancel();
            events.emit("z");
            assert.equal(total, 1);
        });
        await check("snapshot-removals-additions-and-exceptions", () => {
            const events = new Events();
            const seen = [];
            let dispose;
            events.on("x", () => {
                dispose();
                events.on("x", () => seen.push("new"));
            });
            dispose = events.on("x", () => seen.push("old"));
            events.emit("x");
            assert.deepEqual(seen, ["old"]);
            events.emit("x");
            assert.deepEqual(seen, ["old", "new"]);
            const failure = new Error("callback");
            events.once("e", () => {
                throw failure;
            });
            assert.throws(
                () => events.emit("e"),
                (error) => error === failure,
            );
            events.emit("e");
        });
    },
    "bounded-map": async ({ load, check }) => {
        const { mapLimit } = await load("main.mjs");
        await check("concurrent-refill-and-result-order", async () => {
            const gates = Array.from({ length: 4 }, deferred);
            const starts = [];
            let active = 0;
            let maximum = 0;
            const result = mapLimit(Object.freeze([10, 20, 30, 40]), 2, async (value, index) => {
                starts.push(index);
                active += 1;
                maximum = Math.max(maximum, active);
                await gates[index].promise;
                active -= 1;

                return value + index;
            });
            result.catch(() => {});
            await ticks();
            assert.deepEqual(starts, [0, 1]);
            gates[1].resolve();
            await ticks();
            assert.deepEqual(starts, [0, 1, 2]);
            gates[2].resolve();
            await ticks();
            gates[3].resolve();
            gates[0].resolve();
            assert.deepEqual(await result, [10, 21, 32, 43]);
            assert.equal(maximum, 2);
        });
        await check("failure-drains-started-jobs-and-keeps-first-error", async () => {
            const slow = deferred();
            const failure = new Error("first");
            let settled = false;
            const starts = [];
            const result = mapLimit([0, 1, 2, 3], 2, (value) => {
                starts.push(value);

                return value === 0 ? Promise.reject(failure) : slow.promise;
            });
            result.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            await ticks();
            assert.deepEqual(starts, [0, 1]);
            assert.equal(settled, false);
            slow.reject(new Error("later"));
            await assert.rejects(result, (error) => error === failure);
        });
        await check("invalid-limits-and-empty-input", async () => {
            for (const limit of [0, -1, 1.5, NaN]) {
                await assert.rejects(mapLimit([], limit, () => assert.fail("must not run")));
            }

            assert.deepEqual(await mapLimit([], 2, () => assert.fail("empty")), []);
            const failure = new Error("sync");
            await assert.rejects(
                mapLimit([1], 2, () => {
                    throw failure;
                }),
                (error) => error === failure,
            );
        });
    },
    "abort-retry": async ({ load, check }) => {
        const { retry } = await load("main.mjs");
        await check("attempt-count-errors-and-sleep-contract", async () => {
            const failure = new Error("last");
            const calls = [];
            const sleeps = [];
            await assert.rejects(
                retry(
                    (index) => {
                        calls.push(index);
                        throw failure;
                    },
                    { attempts: 3, sleep: async (ms) => sleeps.push(ms) },
                ),
                (error) => error === failure,
            );
            assert.deepEqual(calls, [0, 1, 2]);
            assert.deepEqual(sleeps, [10, 10]);
            for (const attempts of [0, -1, 1.5]) {
                await assert.rejects(retry(() => assert.fail("invalid"), { attempts, sleep: async () => {} }));
            }
        });
        await check("cancellation-before-during-and-after-operation", async () => {
            for (const boundary of ["before", "sleep", "success"]) {
                const controller = new AbortController();
                const reason = new Error(boundary);
                let calls = 0;
                if (boundary === "before") {
                    controller.abort(reason);
                }

                await assert.rejects(
                    retry(
                        () => {
                            calls += 1;
                            if (boundary === "success") {
                                controller.abort(reason);

                                return "late success";
                            }

                            throw new Error("retry");
                        },
                        {
                            attempts: 4,
                            signal: controller.signal,
                            sleep: async () => {
                                controller.abort(reason);
                            },
                        },
                    ),
                    (error) => error === reason,
                );
                assert.equal(calls, boundary === "before" ? 0 : 1);
            }
        });
        await check("sleep-rejection-is-terminal", async () => {
            const failure = new Error("sleep");
            let calls = 0;
            await assert.rejects(
                retry(
                    () => {
                        calls += 1;
                        throw new Error("operation");
                    },
                    {
                        attempts: 5,
                        sleep: async () => {
                            throw failure;
                        },
                    },
                ),
                (error) => error === failure,
            );
            assert.equal(calls, 1);
        });
    },
    "transaction-rollback": async ({ load, check }) => {
        const { applyBatch } = await load("main.mjs");
        const fixture = (fault = () => {}) => {
            const values = new Map([
                ["a", "old-a"],
                ["c", "old-c"],
            ]);
            const log = [];
            const store = Object.fromEntries(
                ["has", "read", "write", "remove"].map((operation) => [
                    operation,
                    async (name, value) => {
                        log.push([operation, name, value]);
                        if (operation === "write") {
                            values.set(name, value);
                        }

                        if (operation === "remove") {
                            values.delete(name);
                        }

                        fault(operation, name, value);

                        return operation === "has" ? values.has(name) : values.get(name);
                    },
                ]),
            );

            return { values, log, store };
        };

        const changes = [
            { name: "a", value: "new-a" },
            { name: "b", value: "new-b" },
            { name: "c", value: "new-c" },
        ];
        await check("success-and-duplicate-preflight", async () => {
            const { values, store } = fixture();
            assert.equal(await applyBatch(store, changes), true);
            assert.deepEqual(Object.fromEntries(values), { a: "new-a", b: "new-b", c: "new-c" });
            const duplicate = fixture();
            await assert.rejects(applyBatch(duplicate.store, [changes[0], changes[0]]));
            assert.deepEqual(duplicate.log, []);
        });
        await check("failed-write-is-rolled-back-including-absence", async () => {
            const failure = new Error("write");
            const { values, log, store } = fixture((operation, name, value) => {
                if (operation === "write" && name === "b" && value === "new-b") {
                    throw failure;
                }
            });
            await assert.rejects(applyBatch(store, changes), (error) => error === failure);
            assert.deepEqual(Object.fromEntries(values), { a: "old-a", c: "old-c" });
            assert.deepEqual(
                log.slice(-3).map(([operation, name]) => [operation, name]),
                [
                    ["write", "c"],
                    ["remove", "b"],
                    ["write", "a"],
                ],
            );
        });
        await check("rollback-continues-and-aggregates-errors", async () => {
            const failure = new Error("write");
            const rollback = new Error("restore");
            const { store, log } = fixture((operation, name, value) => {
                if (operation === "write" && value === "new-b") {
                    throw failure;
                }

                if (operation === "write" && value === "old-c") {
                    throw rollback;
                }
            });
            await assert.rejects(
                applyBatch(store, changes),
                (error) =>
                    error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === rollback,
            );
            assert.equal(log.at(-1)[1], "a");
            const failedRead = fixture((operation) => {
                if (operation === "read") {
                    throw failure;
                }
            });
            await assert.rejects(applyBatch(failedRead.store, changes));
            assert.equal(
                failedRead.log.some(([operation]) => operation === "write" || operation === "remove"),
                false,
            );
        });
    },
    "schema-migration": async ({ load, check }) => {
        const { migrate } = await load("main.mjs");
        await check("selective-deep-migration-and-idempotence", () => {
            const input = { version: 1, theme: "", display: { size: 12, theme: "dark" }, plugins: { a: [1, 2] } };
            const before = structuredClone(input);
            const result = migrate(input);
            assert.deepEqual(result, { version: 2, display: { size: 12, theme: "" }, plugins: { a: [1, 2] } });
            result.plugins.a.push(3);
            assert.deepEqual(input, before);
            const twice = migrate(result);
            assert.deepEqual(twice, result);
            assert.notEqual(twice.plugins, result.plugins);
            assert.deepEqual(migrate({ version: 1, display: { size: 10 } }), { version: 2, display: { size: 10 } });
        });
        await check("unsupported-versions", () => {
            for (const version of [undefined, 0, 3, "1"]) {
                assert.throws(() => migrate({ version }));
            }
        });
    },
    "canonical-key": async ({ load, check }) => {
        const { canonicalKey } = await load("main.mjs");
        await check("recursive-canonicalization-without-mutation", () => {
            const value = Object.freeze({ z: Object.freeze({ b: 2, a: 1 }), a: Object.freeze([3, 2]) });
            assert.equal(canonicalKey(value), canonicalKey({ a: [3, 2], z: { a: 1, b: 2 } }));
        });
        await check("type-boundaries-and-adversarial-property-names", () => {
            const values = [
                null,
                "null",
                1,
                "1",
                false,
                "false",
                [],
                {},
                [1, 2],
                [2, 1],
                { a: "b,c:d" },
                { a: "b", c: "d" },
                JSON.parse('{"__proto__":{"x":1}}'),
            ];
            assert.equal(new Set(values.map(canonicalKey)).size, values.length);
        });
    },
    "pagination-merge": async ({ load, check }) => {
        const { collect } = await load("main.mjs");
        await check("empty-pages-stable-order-and-highest-revision", async () => {
            const a = { id: "a", revision: 3, value: "new" };
            const b = { id: "b", revision: 1 };
            const pages = new Map([
                [null, { items: [a, b], nextCursor: "two" }],
                ["two", { items: [], nextCursor: "three" }],
                [
                    "three",
                    {
                        items: [
                            { id: "a", revision: 1 },
                            { id: "b", revision: 1, value: "tie" },
                            { id: "c", revision: 5 },
                        ],
                        nextCursor: null,
                    },
                ],
            ]);
            const before = structuredClone(pages);
            const cursors = [];
            const result = await collect(async (cursor) => {
                cursors.push(cursor);

                return pages.get(cursor);
            });
            assert.deepEqual(cursors, [null, "two", "three"]);
            assert.deepEqual(result, [a, b, { id: "c", revision: 5 }]);
            assert.deepEqual(pages, before);
        });
        await check("cycles-stop-before-duplicate-fetch-and-errors-propagate", async () => {
            const cursors = [];
            await assert.rejects(
                collect(async (cursor) => {
                    cursors.push(cursor);
                    if (cursors.length > 3) {
                        throw new Error("oracle safety stop");
                    }

                    return { items: [], nextCursor: "repeat" };
                }),
            );
            assert.deepEqual(cursors, [null, "repeat"]);
            const error = new Error("fetch");
            await assert.rejects(
                collect(async () => {
                    throw error;
                }),
                (value) => value === error,
            );
        });
    },
    "archive-boundary": async ({ load, check }) => {
        const { safeEntry } = await load("main.mjs");
        await check("unsafe-path-spellings", () => {
            for (const name of [
                "",
                "/etc/file",
                "../x",
                "x/../y",
                "x/.",
                "./x",
                "C:foo",
                "C:/foo",
                "a:b",
                "\\\\server\\file",
                "a\\b",
                "a//b",
                "a. /b",
                "a./b",
                "x/ ",
                "a\0b",
                "a\nb",
            ]) {
                assert.equal(safeEntry(name), false, JSON.stringify(name));
            }
        });
        await check("valid-paths-are-not-overblocked-or-decoded", () => {
            for (const name of ["a", "src/a.js", "src/", "a b/世界.txt", "%2e%2e/file", "...name/file"]) {
                assert.equal(safeEntry(name), true, name);
            }
        });
    },
    "stream-lines": async ({ load, check }) => {
        const { createLines } = await load("main.mjs");
        await check("all-two-chunk-byte-splits", () => {
            const bytes = Buffer.from("é😀\r\n\rthird\nlast");
            for (let split = 0; split <= bytes.length; split += 1) {
                const lines = [];
                const stream = createLines((value) => lines.push(value));
                stream.write(bytes.subarray(0, split));
                stream.write(bytes.subarray(split));
                stream.end();
                assert.deepEqual(lines, ["é😀", "", "third", "last"], `split ${split}`);
            }
        });
        await check("incremental-emission-and-end-lifecycle", () => {
            const lines = [];
            const stream = createLines((value) => lines.push(value));
            stream.write(Buffer.from("one\ntwo\r"));
            assert.equal(lines[0], "one");
            stream.write(Buffer.from("\n\n"));
            stream.end();
            stream.end();
            assert.deepEqual(lines, ["one", "two", ""]);
            assert.throws(() => stream.write(Buffer.alloc(0)));
            const empty = [];
            createLines((value) => empty.push(value)).end();
            assert.deepEqual(empty, []);
        });
    },
    "tenant-cache": async ({ load, check }) => {
        const { createReports } = await load("api.mjs");
        await check("exact-tenant-and-normalized-query-identity", async () => {
            const calls = [];
            const report = createReports(async (tenant, query) => {
                const value = { tenant, query };
                calls.push(value);

                return value;
            });
            const query = Object.freeze({ labels: Object.freeze(["b", "a", "b"]), archived: false });
            const first = report("tenant:one", query);
            assert.equal(report("tenant:one", { labels: ["a", "b"], archived: false }), first);
            assert.deepEqual(await first, { tenant: "tenant:one", query: { labels: ["a", "b"], archived: false } });
            const variants = [
                ["tenant:two", ["a", "b"], false],
                ["tenant:one", ["a,b"], false],
                ["tenant:one", ["a", "b"], true],
                ["__proto__", ["x:y"], false],
            ];
            for (const [tenant, labels, archived] of variants) {
                assert.notEqual(await report(tenant, { labels, archived }), await first);
            }

            assert.equal(calls.length, 5);
        });
        await check("transport-throw-and-rejection-evict", async () => {
            let calls = 0;
            const failure = new Error("transient");
            const report = createReports(() => {
                calls += 1;
                if (calls === 1) {
                    throw failure;
                }

                if (calls === 2) {
                    return Promise.reject(failure);
                }

                return "ok";
            });
            const query = { labels: [], archived: false };
            await assert.rejects(report("t", query), (error) => error === failure);
            await assert.rejects(report("t", query), (error) => error === failure);
            assert.equal(await report("t", query), "ok");
            assert.equal(calls, 3);
        });
    },
    "public-hooks": async ({ load, check }) => {
        const { Pipeline } = await load("main.mjs");
        await check("independent-disposal-and-snapshot", async () => {
            const pipeline = new Pipeline();
            const double = async (value) => value * 2;
            const dispose = pipeline.use(double);
            pipeline.use(double);
            dispose();
            dispose();
            assert.equal(await pipeline.run(3), 6);
            const other = new Pipeline();
            let remove;
            other.use(async (value) => {
                remove();

                return value + 1;
            });
            remove = other.use(double);
            assert.equal(await other.run(3), 8);
            assert.equal(await other.run(3), 4);
        });
        await check("failure-stops-later-hooks", async () => {
            const pipeline = new Pipeline();
            const error = new Error("plugin");
            pipeline.use(() => {
                throw error;
            });
            pipeline.use(() => assert.fail("must not run"));
            await assert.rejects(pipeline.run(1), (value) => value === error);
        });
    },
    "lazy-iterator": async ({ load, check }) => {
        const { take } = await load("main.mjs");
        const fixture = (maximum = Infinity, fails = false) => {
            const count = { acquired: 0, pulls: 0, closed: 0 };
            const source = {
                [Symbol.iterator]() {
                    count.acquired += 1;

                    return {
                        next() {
                            count.pulls += 1;
                            if (fails) {
                                throw new Error("source");
                            }

                            return { value: count.pulls, done: count.pulls > maximum };
                        },
                        return() {
                            count.closed += 1;

                            return { done: true };
                        },
                    };
                },
            };

            return { source, count };
        };

        await check("lazy-zero-and-exact-pull-count", () => {
            const { source, count } = fixture();
            const iterator = take(source, 2);
            assert.equal(count.acquired, 0);
            assert.deepEqual([...iterator], [1, 2]);
            assert.deepEqual(count, { acquired: 1, pulls: 2, closed: 1 });
            const zero = fixture();
            assert.deepEqual([...take(zero.source, 0)], []);
            assert.equal(zero.count.acquired, 0);
        });
        await check("early-stop-natural-exhaustion-and-source-error", () => {
            const early = fixture();
            for (const value of take(early.source, 5)) {
                assert.equal(value, 1);
                break;
            }

            assert.equal(early.count.closed, 1);
            const short = fixture(1);
            assert.deepEqual([...take(short.source, 4)], [1]);
            assert.equal(short.count.closed, 0);
            const fails = fixture(5, true);
            assert.throws(() => [...take(fails.source, 2)], /source/);
            assert.equal(fails.count.closed, 1);
        });
        await check("source-error-survives-cleanup-error", () => {
            for (const location of ["next", "done", "value"]) {
                for (const cleanup of ["getter", "call"]) {
                    for (const original of [new Error("source"), undefined, 0]) {
                        let closed = 0;
                        const failure = new Error("cleanup");
                        const source = {
                            [Symbol.iterator]() {
                                return {
                                    next() {
                                        if (location === "next") {
                                            throw original;
                                        }

                                        return {
                                            get done() {
                                                if (location === "done") {
                                                    throw original;
                                                }

                                                return false;
                                            },
                                            get value() {
                                                throw original;
                                            },
                                        };
                                    },
                                    get return() {
                                        if (cleanup === "getter") {
                                            closed += 1;
                                            throw failure;
                                        }

                                        return () => {
                                            closed += 1;
                                            throw failure;
                                        };
                                    },
                                };
                            },
                        };
                        let caught = false;
                        try {
                            [...take(source, 1)];
                        } catch (error) {
                            caught = true;
                            assert.equal(error, original);
                        }

                        assert.equal(caught, true);
                        assert.equal(closed, 1);
                    }
                }
            }
        });
        await check("cleanup-error-propagates-without-source-error", () => {
            const failure = new Error("cleanup");
            const source = {
                [Symbol.iterator]() {
                    return {
                        next() {
                            return { value: 1, done: false };
                        },
                        return() {
                            throw failure;
                        },
                    };
                },
            };
            assert.throws(
                () => [...take(source, 1)],
                (error) => error === failure,
            );
        });
    },
    "browser-search-race": async ({ root, chromium, check }) => {
        await check("latest-request-wins-and-blank-invalidates", () =>
            withPage(root, chromium, async (page, url) => {
                await page.addInitScript(() => {
                    window.requests = [];
                    window.fetch = (url) =>
                        new Promise((resolve, reject) => window.requests.push({ url, resolve, reject }));
                });
                await page.goto(url);
                const input = page.getByRole("textbox", { name: "Query" });
                const submit = async (value) => {
                    await input.fill(value);
                    await input.press("Enter");
                };

                await submit("first");
                await submit("  second & third  ");
                assert.equal(await page.evaluate(() => window.requests[1].url), "/search?q=second%20%26%20third");
                await page.evaluate(() =>
                    window.requests[1].resolve({
                        ok: true,
                        json: async () => ({ items: ['<img src=x onerror="window.bad=true">'] }),
                    }),
                );
                await page.waitForFunction(() => document.querySelector('[role="status"]').textContent === "Ready");
                await page.evaluate(() => window.requests[0].reject(new Error("stale")));
                assert.equal(await page.getByRole("status").textContent(), "Ready");
                assert.equal(await page.locator("#results img").count(), 0);
                assert.equal(await page.locator("#results li").textContent(), '<img src=x onerror="window.bad=true">');
                await submit("third");
                await submit("   ");
                await page.evaluate(() =>
                    window.requests[2].resolve({ ok: true, json: async () => ({ items: ["old"] }) }),
                );
                assert.equal(await page.locator("#results").textContent(), "");
                assert.equal(await page.getByRole("status").textContent(), "");
                assert.equal(await page.evaluate(() => window.requests.length), 3);
            }),
        );
        await check("stale-success-and-http-failure", () =>
            withPage(root, chromium, async (page, url) => {
                await page.addInitScript(() => {
                    window.requests = [];
                    window.fetch = (url) => new Promise((resolve) => window.requests.push({ url, resolve }));
                });
                await page.goto(url);
                const input = page.getByRole("textbox", { name: "Query" });
                await input.fill("old");
                await input.press("Enter");
                await input.fill("new");
                await input.press("Enter");
                await page.evaluate(() =>
                    window.requests[1].resolve({ ok: false, json: async () => ({ items: ["invalid"] }) }),
                );
                await page.waitForFunction(() => document.querySelector('[role="status"]').textContent === "Error");
                await page.evaluate(() =>
                    window.requests[0].resolve({ ok: true, json: async () => ({ items: ["obsolete"] }) }),
                );
                assert.equal(await page.getByRole("status").textContent(), "Error");
                assert.equal(await page.locator("#results").textContent(), "");
            }),
        );
    },
    "browser-storage-failure": async ({ root, chromium, check }) => {
        await check("storage-read-fallbacks-and-existing-key", async () => {
            for (const stored of ["dark", "invalid", "throws"]) {
                await withPage(root, chromium, async (page, url) => {
                    await page.addInitScript((value) => {
                        if (value === "throws") {
                            Storage.prototype.getItem = () => {
                                throw new Error("denied");
                            };
                        } else {
                            localStorage.setItem("preference", value);
                        }
                    }, stored);
                    await page.goto(url);
                    assert.equal(await page.locator("#saved").textContent(), stored === "dark" ? "dark" : "light");
                });
            }
        });
        await check("failed-write-never-claims-success-and-can-retry", () =>
            withPage(root, chromium, async (page, url) => {
                await page.addInitScript(() => {
                    const original = Storage.prototype.setItem;
                    window.rejectWrites = true;
                    Storage.prototype.setItem = function (...args) {
                        if (window.rejectWrites) {
                            throw new Error("quota");
                        }

                        return original.apply(this, args);
                    };
                });
                await page.goto(url);
                await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
                await page.getByRole("button", { name: "Save" }).click();
                assert.equal(await page.locator("#saved").textContent(), "light");
                assert.equal(await page.getByRole("status").textContent(), "Could not save");
                await page.evaluate(() => {
                    window.rejectWrites = false;
                });
                await page.getByRole("button", { name: "Save" }).click();
                assert.equal(await page.getByRole("status").textContent(), "Saved");
                assert.equal(await page.evaluate(() => localStorage.getItem("preference")), "dark");
            }),
        );
    },
};

export async function evaluateChallenge(id, root, { chromium } = {}) {
    const oracle = challengeOracles[id];
    if (!oracle) {
        throw new Error(`No challenge oracle for ${id}.`);
    }

    const checks = [];
    const check = async (name, run) => {
        try {
            await run();
            checks.push({ name, status: "passed" });
        } catch (error) {
            checks.push({ name, status: "failed", reason: String(error.message).slice(0, 700) });
        }
    };

    await oracle({ root, chromium, check, load: (file) => import(pathToFileURL(path.join(root, file)).href) });
    if (!checks.length || checks.some((item) => item.status !== "passed")) {
        const error = new Error(
            `Acceptance failed for ${id}: ${checks
                .filter((item) => item.status === "failed")
                .map((item) => item.name)
                .join(", ")}`,
        );
        error.checks = checks;
        throw error;
    }

    return { task: id, acceptance: "passed", checks, maintainability: "requires-human-review" };
}
