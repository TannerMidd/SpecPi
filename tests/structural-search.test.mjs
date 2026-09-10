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
test("configuration is opt-in and rejects malformed and linked inputs", (t) => {
    const { root } = fixture(t);
    assert.equal(readIntegrations(root).structuralSearch.enabled, false);
    fs.mkdirSync(path.join(root, "specpi"));
    const file = path.join(root, "specpi", "tool-integrations.json");
    fs.writeFileSync(file, '{"schema":1,"structuralSearch":{"enabled":true},"other":7}');
    assert.equal(readIntegrations(root).other, 7);
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
test("structural runtime promotion, rollback, removal and integrity are transactional without acquisition", (t) => {
    const { root, runtime } = fixture(t);
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    const warnings = [];
    let smokes = 0;
    const params = {
        stateDir,
        sourceDir: path.join(repo, "structural-runtime"),
        enabled: true,
        warnings,
        run: (_cmd, args, options) => {
            assert.deepEqual(args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
            fs.cpSync(path.join(runtime, "node_modules"), path.join(options.cwd, "node_modules"), { recursive: true });
        },
        smoke: () => {
            smokes += 1;
        },
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
