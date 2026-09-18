import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnvFile, parseEnvText } from "../scripts/eval-env.mjs";

test("eval env-file parses values, comments and quotes", () => {
    const entries = parseEnvText(
        [
            "# comment",
            "",
            "EVAL_FORWARD_URL=https://example.test/v1/chat/completions",
            'EVAL_FORWARD_KEY="quoted-key"',
            "EVAL_FORWARD_MODEL='single-quoted'",
            "EMPTY=",
        ].join("\n"),
    );
    assert.deepEqual(entries, [
        ["EVAL_FORWARD_URL", "https://example.test/v1/chat/completions"],
        ["EVAL_FORWARD_KEY", "quoted-key"],
        ["EVAL_FORWARD_MODEL", "single-quoted"],
        ["EMPTY", ""],
    ]);
});

test("eval env-file rejects malformed lines without echoing secrets", () => {
    assert.throws(() => parseEnvText("NO_SEPARATOR_HERE"), /Malformed env-file line/u);
    assert.throws(() => parseEnvText("9BAD=value"), /Malformed env-file variable name/u);
});

test("eval env-file fills gaps without overriding real environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-env-"));
    try {
        const file = path.join(dir, "test.env");
        fs.writeFileSync(file, "SPECPI_EVAL_PROBE_NEW=from-file\nSPECPI_EVAL_PROBE_OLD=from-file\n");
        const environment = { SPECPI_EVAL_PROBE_OLD: "from-env" };
        const loaded = loadEnvFile(file, environment);
        assert.equal(loaded.entries, 2);
        assert.equal(loaded.loaded, 1);
        assert.equal(environment.SPECPI_EVAL_PROBE_NEW, "from-file");
        assert.equal(environment.SPECPI_EVAL_PROBE_OLD, "from-env");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("eval env-file fails closed on a missing file", () => {
    assert.throws(() => loadEnvFile(path.join(os.tmpdir(), "specpi-eval-env-does-not-exist")), /ENOENT/u);
});
