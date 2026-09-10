import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { parseSource, resolveBinary } from "./core.mjs";

const runtime = path.resolve(process.argv[2]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-structural-smoke-"));
try {
    fs.writeFileSync(path.join(directory, "sgconfig.yml"), "ruleDirs: []\n");
    const matches = await parseSource(
        resolveBinary(runtime),
        directory,
        { language: "typescript", pattern: "target($A)" },
        Buffer.from('target(42); "target(9)";'),
        AbortSignal.timeout(10000),
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].text, "target(42)");
    console.log("STRUCTURAL_SEARCH_SMOKE=passed");
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
