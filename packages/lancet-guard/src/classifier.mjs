// LANCET inference in Node: tokenize, run the INT8 ONNX graph on the CPU, calibrate, threshold.
//
// This is a port of LANCET Nano's `classify.py` (LancetNano) and must give the same answers: the
// same input contract, the same `review` reasons, the same calibrated score and the same band --
// `risky` at or above `riskyThreshold`, `review` at or above `reviewThreshold`, otherwise
// `not_flagged`. It runs the same ONNX Runtime release (1.30.0) with the same thread settings, on the
// CPU execution provider only. Command text is a model input and is never executed.
//
// Every artifact is verified against pinned SHA-256 digests before it is loaded, so a model
// directory that has been swapped or damaged fails closed instead of scoring.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ByteLevelBpe } from "./tokenizer.mjs";
import { MODEL_FILES } from "./model-manifest.mjs";

const encoder = new TextEncoder();
// Python's str.isspace() set. JavaScript's `\s` differs: it omits U+001C-U+001F and U+0085 and
// adds U+FEFF, so it is spelled out to keep "blank" meaning the same thing on both sides.
const PYTHON_SPACE = /[\t\n\v\f\r\u001c-\u001f \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu;

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Read one artifact and refuse it unless it is exactly the pinned file. */
export function readVerified(directory, name) {
    const expected = MODEL_FILES[name];
    if (!expected) {
        throw new Error(`Unknown LANCET artifact: ${name}`);
    }

    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== expected.bytes) {
        throw new Error(`LANCET artifact is missing or the wrong size: ${name}`);
    }

    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== expected.sha256) {
        throw new Error(`LANCET artifact failed its checksum: ${name}`);
    }

    return bytes;
}

function result(meta, extra) {
    return {
        classification: "review",
        score: null,
        reviewThreshold: meta.reviewThreshold,
        riskyThreshold: meta.riskyThreshold,
        reason: null,
        experimental: true,
        executionAuthorized: false,
        ...extra,
    };
}

export class LancetClassifier {
    /**
     * @param {string} directory verified model directory
     * @param {any} ort the onnxruntime-node module, injected so loading it can fail gracefully
     */
    static async load(directory, ort) {
        const meta = JSON.parse(readVerified(directory, "model.json").toString("utf8"));
        const tokenizer = new ByteLevelBpe(JSON.parse(readVerified(directory, "tokenizer.json").toString("utf8")));
        const model = readVerified(directory, "model-int8.onnx");
        if (
            meta.format !== "lancet-nano-v1" ||
            meta.kind !== "codet5" ||
            !Number.isFinite(meta.reviewThreshold) ||
            !Number.isFinite(meta.riskyThreshold) ||
            meta.reviewThreshold > meta.riskyThreshold ||
            !Number.isFinite(meta.calibration?.scale) ||
            !Number.isFinite(meta.calibration?.bias) ||
            !Number.isInteger(meta.maxTokens) ||
            !Number.isInteger(meta.maxRawBytes)
        ) {
            throw new Error("Unsupported LANCET model metadata");
        }

        const session = await ort.InferenceSession.create(model, {
            executionProviders: ["cpu"],
            intraOpNumThreads: 4,
            interOpNumThreads: 1,
            graphOptimizationLevel: "all",
        });

        return new LancetClassifier(meta, tokenizer, session, ort);
    }

    constructor(meta, tokenizer, session, ort) {
        this.meta = meta;
        this.tokenizer = tokenizer;
        this.session = session;
        this.ort = ort;
        this.bos = tokenizer.tokenId("<s>");
        this.eos = tokenizer.tokenId("</s>");
    }

    /** Token ids, or the reason the input needs review. Mirrors LancetNano.encode. */
    encode(command, shell = "bash") {
        if (shell !== "bash") {
            return { reason: "unsupported-shell" };
        }

        if (typeof command !== "string") {
            return { reason: "command-not-string" };
        }

        if (!command.replace(PYTHON_SPACE, "")) {
            return { reason: "empty-command" };
        }

        if (command.includes("\0")) {
            return { reason: "nul-byte" };
        }

        // A lone surrogate cannot be UTF-8 encoded; Python refuses it, so it is invalid here too.
        if (!command.isWellFormed()) {
            return { reason: "invalid-unicode" };
        }

        if (encoder.encode(command).length > this.meta.maxRawBytes) {
            return { reason: "raw-input-too-long" };
        }

        const ids = [this.bos, ...this.tokenizer.encode(command), this.eos];
        if (ids.length > this.meta.maxTokens) {
            return { reason: "token-input-too-long" };
        }

        return { ids };
    }

    async score(command, shell = "bash") {
        const { ids, reason } = this.encode(command, shell);
        if (!ids) {
            return result(this.meta, { reason });
        }

        const shape = [1, ids.length];
        const feeds = {
            ids: new this.ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
            mask: new this.ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
        };
        const outputs = await this.session.run(feeds);
        const logit = Number(outputs[this.session.outputNames[0]].data[0]);
        if (!Number.isFinite(logit)) {
            return result(this.meta, { reason: "nonfinite-model-output" });
        }

        const { scale, bias } = this.meta.calibration;
        const calibrated = Math.min(60, Math.max(-60, logit * scale + bias));
        const score = 1 / (1 + Math.exp(-calibrated));

        const band =
            score >= this.meta.riskyThreshold ? "risky" : score >= this.meta.reviewThreshold ? "review" : "not_flagged";

        return result(this.meta, {
            score,
            classification: band,
            reason: band === "review" ? "uncertainty-band" : null,
        });
    }

    async release() {
        await this.session.release?.();
    }
}
