import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    VERSION,
    normalizeSearch,
    structuralSearch,
    parseSource,
    resolveBinary,
} from "../extensions/structural-search/core.mjs";
import { createSnapshot } from "../extensions/delegation/snapshot.mjs";
import { readIntegrations } from "../extensions/structural-search/config.mjs";
import { changeStructuralRuntime, structuralRuntimeStatus } from "../scripts/structural-runtime.mjs";

const repo = path.resolve(import.meta.dirname, "..");
function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-structural-test-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "sample.ts"), "const é = 1;\r\ntarget(42);\r\n");
    const runtime = path.join(root, "runtime");
    const platform = {
        "win32-x64": "win32-x64-msvc",
        "linux-x64": "linux-x64-gnu",
        "darwin-x64": "darwin-x64",
        "darwin-arm64": "darwin-arm64",
    }[`${process.platform}-${process.arch}`];
    const packageDir = path.join(runtime, "node_modules", "@ast-grep", `cli-${platform}`);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: VERSION }));
    fs.writeFileSync(
        path.join(packageDir, process.platform === "win32" ? "ast-grep.exe" : "ast-grep"),
        "fixture executable; never run",
    );

    return { root, runtime };
}

const input = { language: "typescript", pattern: "target($A)", paths: ["sample.ts"] };
test("structural schema cannot introduce rewrite, shell, rules or directory discovery", () => {
    assert.equal(normalizeSearch(input).timeoutMs, 10000);
    for (const change of [
        { rewrite: "" },
        { command: "echo x" },
        { config: "evil.yml" },
        { paths: ["."] },
        { paths: ["file.py"] },
        { maxResults: 101 },
        { timeoutMs: 31000 },
        { pattern: "" },
        { language: "__proto__" },
    ]) {
        assert.throws(() => normalizeSearch({ ...input, ...change }));
    }
});
test("parent byte seam preserves original UTF-8/CRLF and clears buffers on success and failure", async (t) => {
    const { root } = fixture(t);
    const snapshot = createSnapshot(root, ["sample.ts"]);
    let retained;
    await snapshot.withSourceBytes("s1", async (bytes) => {
        retained = bytes;
        assert.equal(bytes.toString(), "const é = 1;\r\ntarget(42);\r\n");
    });
    assert.ok(retained.every((byte) => byte === 0));
    await assert.rejects(
        snapshot.withSourceBytes("s1", (bytes) => {
            retained = bytes;
            throw new Error("test");
        }),
    );
    assert.ok(retained.every((byte) => byte === 0));
    fs.writeFileSync(path.join(root, "sample.ts"), "changed");
    await assert.rejects(snapshot.withSourceBytes("s1", () => assert.fail("must not read changed source")));
    snapshot.destroy();
    await assert.rejects(snapshot.withSourceBytes("s1", () => {}));
});
test("search enforces selection before parsing and reports bounded partial evidence", async (t) => {
    const { root, runtime } = fixture(t);
    let calls = 0;
    const parser = async (_exe, directory, _spec, bytes) => {
        calls += 1;
        assert.equal(fs.readFileSync(path.join(directory, "sgconfig.yml"), "utf8"), "ruleDirs: []\n");
        assert.match(bytes.toString(), /target\(42\)/u);
        const start = bytes.indexOf("target(42)");

        return Array.from({ length: 110 }, () => ({
            text: "target(42)",
            range: { byteOffset: { start, end: start + 10 } },
        }));
    };

    const options = { cwd: root, runtimeDir: runtime, parser };
    for (const paths of [["../sample.ts"], [".pi/secret.ts"], ["sample.ts", "sample.ts"]]) {
        await assert.rejects(structuralSearch({ ...input, paths }, options));
    }

    assert.equal(calls, 0);
    const value = await structuralSearch({ ...input, maxResults: 2 }, options);
    assert.equal(value.status, "partial");
    assert.equal(value.matches.length, 2);
    assert.equal(value.matches[0].start.line, 2);
    assert.equal(value.matches[0].start.byteColumn, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 24576);
});
test("policy is rechecked before parsing and source metadata cannot bypass quotas", async (t) => {
    const { root, runtime } = fixture(t);
    let calls = 0;
    await assert.rejects(
        structuralSearch(input, {
            cwd: root,
            runtimeDir: runtime,
            admit: async () => {
                if (++calls > 1) {
                    throw new Error("locked");
                }
            },
            parser: async () => assert.fail("denied dispatch"),
        }),
        /locked/u,
    );
    const signal = AbortSignal.abort();
    await assert.rejects(structuralSearch(input, { cwd: root, runtimeDir: runtime, signal }), /cancelled/u);
    fs.writeFileSync(path.join(root, "sample.ts"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(
        structuralSearch(input, {
            cwd: root,
            runtimeDir: runtime,
            parser: async () => assert.fail("oversized source"),
        }),
        /quota/u,
    );
});
test("configuration defaults on, preserves explicit choices and rejects malformed and linked inputs", (t) => {
    const { root } = fixture(t);
    assert.equal(readIntegrations(path.join(root, "missing-agent")).structuralSearch.enabled, true);
    assert.equal(readIntegrations(root).structuralSearch.enabled, true);
    fs.mkdirSync(path.join(root, "specpi"));
    assert.equal(readIntegrations(root).structuralSearch.enabled, true);
    const file = path.join(root, "specpi", "tool-integrations.json");
    for (const enabled of [false, true]) {
        fs.writeFileSync(file, JSON.stringify({ schema: 1, structuralSearch: { enabled }, other: 7 }));
        assert.equal(readIntegrations(root).structuralSearch.enabled, enabled);
        assert.equal(readIntegrations(root).other, 7);
    }

    // Content corruption is repairable by an explicit selection and names the file; link/shape failures are not.
    const thrown = (fn) => {
        try {
            fn();
        } catch (error) {
            return error;
        }

        assert.fail("expected a rejected configuration");
    };

    for (const content of ['{"schema":1,"structuralSearch":{"enabled":"yes"}}', "{ broken", '{"schema":2}']) {
        fs.writeFileSync(file, content);
        const error = thrown(() => readIntegrations(root));
        assert.equal(error.corruptIntegrations, true, content);
        assert.ok(error.message.includes(file), error.message);
    }

    fs.unlinkSync(file);
    fs.linkSync(path.join(root, "sample.ts"), file);
    const shape = thrown(() => readIntegrations(root));
    assert.match(shape.message, /regular file/u);
    assert.equal(shape.corruptIntegrations, undefined);
    assert.ok(shape.message.includes(file), shape.message);
});
function runtimeFixture(t) {
    const { root, runtime } = fixture(t);
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);

    return {
        stateDir,
        sourceDir: path.join(repo, "structural-runtime"),
        enabled: true,
        warnings: [],
        run: (_cmd, args, options) => {
            assert.deepEqual(args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
            fs.cpSync(path.join(runtime, "node_modules"), path.join(options.cwd, "node_modules"), { recursive: true });
        },
        smoke() {},
    };
}

test("structural runtime promotion, rollback, removal and integrity are transactional without acquisition", (t) => {
    const params = runtimeFixture(t);
    const { stateDir, warnings } = params;
    let smokes = 0;
    params.smoke = () => {
        smokes += 1;
    };

    const installed = changeStructuralRuntime(params);
    assert.equal(structuralRuntimeStatus(stateDir, params.sourceDir).installed, true);
    assert.equal(smokes, 2);
    installed.rollback();
    assert.equal(fs.existsSync(path.join(stateDir, "structural-runtime")), false);
    changeStructuralRuntime(params).commit();
    const retired = changeStructuralRuntime({ ...params, enabled: false });
    assert.equal(fs.existsSync(path.join(stateDir, "structural-runtime")), false);
    retired.rollback();
    assert.equal(structuralRuntimeStatus(stateDir, params.sourceDir).installed, true);
    const marker = path.join(stateDir, "structural-runtime", "specpi-runtime.json");
    fs.writeFileSync(marker, "{}");
    assert.equal(structuralRuntimeStatus(stateDir, params.sourceDir).installed, false);
    assert.throws(
        () =>
            changeStructuralRuntime({
                ...params,
                smoke: () => {
                    throw new Error("failed smoke");
                },
            }),
        /failed smoke/u,
    );
    assert.equal(fs.readFileSync(marker, "utf8"), "{}");
    changeStructuralRuntime({ ...params, enabled: false }).commit();
    assert.equal(fs.existsSync(path.join(stateDir, "structural-runtime")), true);
    assert.ok(warnings.some((warning) => warning.includes("Preserved")));
});
test("runtime retirement preserves non-binary changes and legacy ownership markers", async (t) => {
    const changes = {
        lockfile(directory) {
            fs.appendFileSync(path.join(directory, "package-lock.json"), "\n");
        },
        addedFile(directory) {
            fs.writeFileSync(path.join(directory, "local-notes.json"), "{}");
        },
        markerPermissions(directory) {
            const file = path.join(directory, "specpi-runtime.json");
            fs.chmodSync(file, (fs.statSync(file).mode & 0o7777) ^ 0o200);
        },
        filePermissions(directory) {
            const file = path.join(directory, "package.json");
            // Windows models read-only permission; POSIX must also preserve special-bit-only changes.
            fs.chmodSync(file, process.platform === "win32" ? 0o444 : (fs.statSync(file).mode & 0o7777) ^ 0o1000);
        },
        removedFile(directory) {
            fs.unlinkSync(path.join(directory, "package.json"));
        },
        emptyDirectory(directory) {
            fs.mkdirSync(path.join(directory, "local-directory"));
        },
        linkedDirectory(directory) {
            fs.symlinkSync(
                path.dirname(directory),
                path.join(directory, "local-link"),
                process.platform === "win32" ? "junction" : "dir",
            );
        },
        legacyMarker(directory) {
            const file = path.join(directory, "specpi-runtime.json");
            const marker = JSON.parse(fs.readFileSync(file, "utf8"));
            marker.schema = 1;
            delete marker.treeHash;
            fs.writeFileSync(file, JSON.stringify(marker));
        },
    };
    for (const [name, change] of Object.entries(changes)) {
        await t.test(name, (t) => {
            const params = runtimeFixture(t);
            changeStructuralRuntime(params).commit();
            const directory = path.join(params.stateDir, "structural-runtime");
            change(directory);
            assert.equal(structuralRuntimeStatus(params.stateDir, params.sourceDir).installed, false);
            changeStructuralRuntime({ ...params, enabled: false }).commit();
            assert.ok(fs.existsSync(directory));
            assert.match(params.warnings.join("\n"), /Preserved/u);
            changeStructuralRuntime(params).commit();
            assert.equal(structuralRuntimeStatus(params.stateDir, params.sourceDir).installed, true);
            const previous = fs
                .readdirSync(params.stateDir)
                .find((name) => name.startsWith(".structural-runtime-previous-"));
            assert.ok(previous, "replacement preserves the unverified prior tree");
        });
    }
});
test("runtime fingerprinting does not read through directory links", (t) => {
    const params = runtimeFixture(t);
    changeStructuralRuntime(params).commit();
    const directory = path.join(params.stateDir, "structural-runtime");
    const link = path.join(directory, "outside-link");
    fs.symlinkSync(path.dirname(directory), link, process.platform === "win32" ? "junction" : "dir");
    let traversals = 0;
    for (const name of ["readFileSync", "readdirSync"]) {
        const original = fs[name];
        t.mock.method(fs, name, (target, ...args) => {
            const resolved = path.resolve(target);
            if (resolved === link || resolved.startsWith(`${link}${path.sep}`)) {
                traversals += 1;
                throw new Error("directory link traversed");
            }

            return original(target, ...args);
        });
    }

    try {
        assert.equal(structuralRuntimeStatus(params.stateDir, params.sourceDir).installed, false);
        assert.equal(traversals, 0, "a caught traversal failure must not masquerade as safe fingerprinting");
    } finally {
        t.mock.restoreAll();
    }
});
test("runtime commit reports the exact retained path when retirement cleanup fails", (t) => {
    const params = runtimeFixture(t);
    changeStructuralRuntime(params).commit();
    const retired = changeStructuralRuntime({ ...params, enabled: false });
    const previous = path.join(
        params.stateDir,
        fs.readdirSync(params.stateDir).find((name) => name.startsWith(".structural-runtime-previous-")),
    );
    t.mock.method(fs, "rmSync", () => {
        throw Object.assign(new Error("injected retirement cleanup failure"), { code: "EACCES" });
    });
    try {
        retired.commit();
    } finally {
        t.mock.restoreAll();
    }

    assert.ok(fs.existsSync(previous));
    assert.ok(
        params.warnings.some(
            (warning) => warning.includes(previous) && warning.includes("injected retirement cleanup failure"),
        ),
    );
});
test("runtime commit rechecks the retired directory before recursive deletion", (t) => {
    const params = runtimeFixture(t);
    changeStructuralRuntime(params).commit();
    const retired = changeStructuralRuntime({ ...params, enabled: false });
    const previous = fs.readdirSync(params.stateDir).find((name) => name.startsWith(".structural-runtime-previous-"));
    const file = path.join(params.stateDir, previous, "late-notes.json");
    fs.writeFileSync(file, "preserve this change");
    retired.commit();
    assert.equal(fs.readFileSync(file, "utf8"), "preserve this change");
    assert.match(params.warnings.join("\n"), /Preserved/u);
});
test("runtime rollback restores the previous directory even when recursive cleanup fails", (t) => {
    const params = runtimeFixture(t);
    changeStructuralRuntime(params).commit();
    const directory = path.join(params.stateDir, "structural-runtime");
    const original = "modified prior binary";
    fs.writeFileSync(resolveBinary(directory), original);
    const replacement = changeStructuralRuntime(params);
    const remove = fs.rmSync;
    t.mock.method(fs, "rmSync", (target, options) => {
        if (path.resolve(target).startsWith(`${params.stateDir}${path.sep}`)) {
            throw Object.assign(new Error("injected cleanup failure"), { code: "EACCES" });
        }

        return remove(target, options);
    });
    let errors;
    try {
        errors = replacement.rollback();
    } finally {
        t.mock.restoreAll();
    }

    assert.match(errors.join("\n"), /cleanup failure/u);
    assert.equal(fs.readFileSync(resolveBinary(directory), "utf8"), original);
    assert.ok(fs.readdirSync(params.stateDir).some((name) => name.startsWith(".structural-runtime-failed-")));
    assert.deepEqual(replacement.rollback(), []);
    assert.equal(fs.readFileSync(resolveBinary(directory), "utf8"), original);
});
test(
    "real pinned parser finds structures across layout, ignores strings, isolates config and returns byte ranges",
    { skip: process.env.SPECPI_STRUCTURAL_TESTS !== "1" },
    async (t) => {
        const { root } = fixture(t);
        const runtimeDir = process.env.SPECPI_STRUCTURAL_RUNTIME ?? path.join(repo, "structural-runtime");
        fs.writeFileSync(path.join(root, "sgconfig.yml"), "customLanguages: [INVALID]\n");
        const cases = [
            ["typescript", "sample.ts", 'const é = 1; target(42);\r\ntarget (\n  9\n); "target(0)";', "target($A)", 2],
            ["javascript", "sample.js", "target(1); /* target(0) */", "target($A)", 1],
            ["jsx", "sample.jsx", '<Panel label="hello" />', '<Panel label="$A" />', 1],
            ["tsx", "sample.tsx", '<Panel label="hello" />', '<Panel label="$A" />', 1],
            ["python", "sample.py", 'target(1)\n"target(0)"', "target($A)", 1],
            ["python", "negative.py", "value = -amount\n", "-amount", 1],
        ];
        for (const [language, file, content, pattern, count] of cases) {
            fs.writeFileSync(path.join(root, file), content);
            const value = await structuralSearch(
                { language, pattern, paths: [file] },
                { cwd: root, runtimeDir, signal: AbortSignal.timeout(10000) },
            );
            assert.equal(value.status, "complete");
            assert.equal(value.matches.length, count, language);
            if (language === "typescript") {
                assert.equal(value.matches[0].start.byteColumn, Buffer.byteLength("const é = 1; ") + 1);
            }
        }

        const empty = await structuralSearch(
            { ...input, pattern: "unseen($A)" },
            { cwd: root, runtimeDir, signal: AbortSignal.timeout(10000) },
        );
        assert.equal(empty.matches.length, 0);
        assert.equal(empty.status, "complete");
        const directory = path.join(root, "neutral");
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, "sgconfig.yml"), "ruleDirs: []\n");
        const executable = resolveBinary(runtimeDir);
        await assert.rejects(
            parseSource(executable, directory, input, Buffer.from("target(1);"), AbortSignal.timeout(10000), {
                remaining: 1,
            }),
            (error) => error.status === "partial",
        );
        const cancelled = new AbortController();
        const running = parseSource(
            executable,
            directory,
            input,
            Buffer.from("target(1);\n".repeat(50000)),
            cancelled.signal,
        );
        cancelled.abort();
        await assert.rejects(running, (error) => error.status === "cancelled");
        await assert.rejects(
            structuralSearch(
                { ...input, pattern: "foo();bar()" },
                { cwd: root, runtimeDir, signal: AbortSignal.timeout(10000) },
            ),
        );
    },
);
