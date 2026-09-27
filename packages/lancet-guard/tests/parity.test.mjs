// The Node runtime must give the answers LANCET Nano's Python runtime gives. The fixture was
// recorded with Nano v0.3.0's classify.py (onnxruntime 1.30.0, tokenizers 0.23.2) over authored commands
// chosen to stress the tokenizer: Unicode letters and digits, combining marks, emoji, every
// whitespace class the two regex engines disagree on, special-token spellings, and inputs at and
// past the length limits. Command strings are model inputs only and are never executed.
//
// The model is not in the package, so these run when LANCET_MODEL_DIR points at a verified copy
// (the release ZIP's model/ directory, or what /lancet-guard setup installs) and are skipped
// otherwise.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { LancetClassifier, readVerified } from "../src/classifier.mjs";
import { ByteLevelBpe } from "../src/tokenizer.mjs";

const REAL = process.env.LANCET_MODEL_DIR;
const skip = !REAL && "LANCET_MODEL_DIR not set";
const { cases } = JSON.parse(fs.readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

describe("parity with LANCET Nano's Python runtime", { skip }, () => {
    it("tokenizes exactly as Hugging Face tokenizers does", () => {
        const tokenizer = new ByteLevelBpe(JSON.parse(readVerified(REAL, "tokenizer.json").toString("utf8")));
        const meta = JSON.parse(readVerified(REAL, "model.json").toString("utf8"));
        const classifier = new LancetClassifier(meta, tokenizer, undefined, undefined);
        for (const row of cases) {
            const encoded = classifier.encode(row.command, row.shell);
            if (row.ids) {
                assert.deepEqual(encoded.ids, row.ids, JSON.stringify(row.command).slice(0, 80));
            } else {
                assert.equal(encoded.reason, row.reason, JSON.stringify(row.command).slice(0, 80));
            }
        }
    });

    it("scores and decides exactly as classify.py does, on the CPU", async () => {
        const ort = createRequire(import.meta.url)("onnxruntime-node");
        const classifier = await LancetClassifier.load(REAL, ort);
        try {
            for (const row of cases) {
                const result = await classifier.score(row.command, row.shell);
                const label = JSON.stringify(row.command).slice(0, 80);
                assert.equal(result.classification, row.classification, label);
                assert.equal(result.executionAuthorized, false);
                if (row.score === null) {
                    assert.equal(result.score, null, label);
                } else {
                    assert.ok(Math.abs(result.score - row.score) < 1e-9, `${label}: ${result.score} vs ${row.score}`);
                }
            }
        } finally {
            await classifier.release();
        }
    });

    it("refuses a model file that does not match its pinned digest", () => {
        const copy = fs.mkdtempSync(path.join(os.tmpdir(), "lancet-tamper-"));
        try {
            const bytes = fs.readFileSync(path.join(REAL, "model.json"));
            bytes[bytes.length - 2] ^= 1;
            fs.writeFileSync(path.join(copy, "model.json"), bytes);
            assert.throws(() => readVerified(copy, "model.json"), /checksum/u);
        } finally {
            fs.rmSync(copy, { recursive: true, force: true });
        }
    });
});
