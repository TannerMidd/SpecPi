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

    it("scores and decides as classify.py does, on the CPU", async (t) => {
        // The fixture was recorded on Windows x64, and on x64 Node matches it to rounding error. ONNX
        // Runtime's INT8 kernels are not the same on every CPU family: on Apple Silicon, CI measured
        // scores up to 0.031 away from the x64 reference. That is the runtime, not this port, since
        // token ids are checked exactly above and the calibration is the same code everywhere. So
        // elsewhere scores get a 0.05 tolerance; a gross port bug would still fail it. Decisions must
        // match everywhere. They did on every fixture case on Apple Silicon with the pinned runtime,
        // but a command near a threshold could land in another band on another CPU, and if one ever
        // does, this is where it should show up rather than be tolerated away.
        const tolerance = process.arch === "x64" ? 1e-9 : 0.05;
        const ort = createRequire(import.meta.url)("onnxruntime-node");
        const classifier = await LancetClassifier.load(REAL, ort);
        const decisions = [];
        const scores = [];
        let largest = 0;
        try {
            for (const row of cases) {
                const result = await classifier.score(row.command, row.shell);
                const label = JSON.stringify(row.command).slice(0, 80);
                assert.equal(result.executionAuthorized, false);
                if (result.classification !== row.classification) {
                    decisions.push(`${label}: ${result.classification} vs ${row.classification}`);
                }

                if (row.score === null || result.score === null) {
                    if (row.score !== result.score) {
                        scores.push(`${label}: ${result.score} vs ${row.score}`);
                    }

                    continue;
                }

                const difference = Math.abs(result.score - row.score);
                largest = Math.max(largest, difference);
                if (difference >= tolerance) {
                    scores.push(`${label}: ${result.score} vs ${row.score}`);
                }
            }
        } finally {
            await classifier.release();
        }

        t.diagnostic(`${process.platform}/${process.arch}: largest score difference ${largest}`);
        assert.deepEqual(decisions, [], "decisions differ from classify.py");
        assert.deepEqual(scores, [], `scores differ by ${tolerance} or more`);
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
