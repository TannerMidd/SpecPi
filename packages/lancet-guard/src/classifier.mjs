// LANCET inference in Node: tokenize, run the INT8 ONNX encoder over the command on the CPU, pool
// its output, apply the risk head, calibrate, threshold.
//
// This is a port of LANCET Nano's `classify.py` (LancetNano, format `semantic-windowed-1`) and must
// give the same answers: the same input contract, the same `review` reasons, the same calibrated
// score and the same band -- `risky` when the risk logit is at or above `riskyLogitThreshold`,
// `review` at or above `reviewLogitThreshold`, otherwise `not_flagged`. A command longer than one
// 512-token window is split into overlapping windows and every token is pooled exactly once, so
// nothing is truncated. The encoder runs on the same ONNX Runtime release (1.30.0) with the same
// thread settings, on the CPU execution provider only; the head runs here in float64, as NumPy runs
// it there. Command text is a model input and is never executed.
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
const SHELLS = new Set(["bash", "powershell", "cmd"]);
// classify.py frames every window with these ids rather than looking them up.
const BOS = 1;
const EOS = 2;

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

/** The tokenizer from a verified model directory. */
export function loadTokenizer(directory) {
    return new ByteLevelBpe(
        JSON.parse(readVerified(directory, "vocab.json").toString("utf8")),
        readVerified(directory, "merges.txt").toString("utf8"),
    );
}

function checkMeta(meta) {
    const input = meta?.input;
    if (
        meta?.format !== "semantic-windowed-1" ||
        meta.kind !== "codet5p-encoder-windowed" ||
        !Number.isFinite(meta.reviewLogitThreshold) ||
        !Number.isFinite(meta.riskyLogitThreshold) ||
        meta.reviewLogitThreshold > meta.riskyLogitThreshold ||
        !Number.isFinite(meta.reviewThreshold) ||
        !Number.isFinite(meta.riskyThreshold) ||
        !Number.isFinite(meta.calibration?.scale) ||
        !Number.isFinite(meta.calibration?.bias) ||
        !Number.isInteger(input?.windowTokens) ||
        !Number.isInteger(input.overlapTokens) ||
        input.overlapTokens < 0 ||
        input.overlapTokens >= input.windowTokens - 2 ||
        !Number.isInteger(input.maxUtf8Bytes)
    ) {
        throw new Error("Unsupported LANCET model metadata");
    }

    return meta;
}

/**
 * The head's float32 tensors from head.bin, laid out as head.json says, widened to float64 as
 * classify.py widens head.npz. Anything but the expected tensors and shapes is refused.
 */
function readHead(spec, bytes) {
    const hidden = spec?.hidden;
    const shapes = new Map([
        ["projection", [hidden, 2 * hidden]],
        ["norm_weight", [hidden]],
        ["norm_bias", [hidden]],
        ["head_weight", [2, hidden]],
        ["head_bias", [2]],
    ]);
    if (
        spec?.format !== "lancet-web-head-1" ||
        spec.dtype !== "float32" ||
        spec.byteOrder !== "little" ||
        spec.order !== "C" ||
        !Number.isInteger(hidden) ||
        hidden <= 0 ||
        !Number.isFinite(spec.normEps) ||
        spec.normEps <= 0 ||
        !Array.isArray(spec.tensors) ||
        spec.tensors.length !== shapes.size
    ) {
        throw new Error("Unsupported LANCET head metadata");
    }

    const head = { hidden, eps: spec.normEps };
    for (const tensor of spec.tensors) {
        const shape = shapes.get(tensor?.name);
        const count = shape?.reduce((product, size) => product * size, 1);
        if (
            !shape ||
            Object.hasOwn(head, tensor.name) ||
            JSON.stringify(tensor.shape) !== JSON.stringify(shape) ||
            tensor.bytes !== count * 4 ||
            !Number.isInteger(tensor.offset) ||
            tensor.offset < 0 ||
            tensor.offset + tensor.bytes > bytes.length
        ) {
            throw new Error("Unsupported LANCET head metadata");
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset + tensor.offset, tensor.bytes);
        const values = new Float64Array(count);
        for (let index = 0; index < count; index++) {
            values[index] = view.getFloat32(index * 4, true);
        }

        head[tensor.name] = values;
    }

    return head;
}

/**
 * Overlapping windows over `payload`, as classify.py's `windows`: each holds up to `size - 2`
 * tokens framed by <s> ... </s>, consecutive windows share `overlap` tokens, and `owned` marks
 * every payload token in exactly one window.
 */
export function windows(payload, size, overlap) {
    const capacity = size - 2;
    if (payload.length === 0 || !(overlap >= 0 && overlap < capacity)) {
        throw new Error("Empty input or invalid window contract");
    }

    const result = [];
    let start = 0;
    let previousEnd = 0;
    let pooled = 0;
    while (start < payload.length) {
        const end = Math.min(payload.length, start + capacity);
        const owned = [0];
        for (let index = start; index < end; index++) {
            owned.push(index >= previousEnd ? 1 : 0);
            pooled += index >= previousEnd ? 1 : 0;
        }

        owned.push(0);
        result.push({ ids: [BOS, ...payload.slice(start, end), EOS], owned });
        if (end === payload.length) {
            break;
        }

        previousEnd = end;
        start = end - overlap;
    }

    if (pooled !== payload.length) {
        throw new Error("Every token must be pooled exactly once");
    }

    return result;
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
        const meta = checkMeta(JSON.parse(readVerified(directory, "model.json").toString("utf8")));
        const head = readHead(
            JSON.parse(readVerified(directory, "head.json").toString("utf8")),
            readVerified(directory, "head.bin"),
        );
        const tokenizer = loadTokenizer(directory);
        const model = readVerified(directory, "encoder-int8.onnx");
        const session = await ort.InferenceSession.create(model, {
            executionProviders: ["cpu"],
            intraOpNumThreads: 4,
            interOpNumThreads: 1,
            graphOptimizationLevel: "all",
        });

        return new LancetClassifier(meta, tokenizer, head, session, ort);
    }

    constructor(meta, tokenizer, head, session, ort) {
        this.meta = checkMeta(meta);
        this.tokenizer = tokenizer;
        this.head = head;
        this.session = session;
        this.ort = ort;
    }

    /** Token ids and their windows, or the reason the input needs review. Mirrors LancetNano.reject. */
    encode(command, shell = "bash") {
        if (!SHELLS.has(shell)) {
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

        if (encoder.encode(command).length > this.meta.input.maxUtf8Bytes) {
            return { reason: "raw-input-too-long" };
        }

        const ids = this.tokenizer.encode(command);

        return { ids, windows: windows(ids, this.meta.input.windowTokens, this.meta.input.overlapTokens) };
    }

    /** [risk, ask] logits, as LancetNano.logits; the ask logit is a diagnostic and never sets the band. */
    async logits(parts) {
        const { hidden: width, projection, norm_weight, norm_bias, head_weight, head_bias, eps } = this.head;
        const total = new Float64Array(width);
        const maximum = new Float64Array(width).fill(-Infinity);
        let count = 0;
        for (const { ids, owned } of parts) {
            const shape = [1, ids.length];
            const outputs = await this.session.run({
                input_ids: new this.ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
                attention_mask: new this.ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
            });
            const hidden = outputs[this.session.outputNames[0]];
            if (hidden.dims.length !== 3 || hidden.dims[1] !== ids.length || hidden.dims[2] !== width) {
                throw new Error("Unexpected LANCET encoder output");
            }

            // Sum this window's owned rows first and then add them to the total, as NumPy does.
            const data = hidden.data;
            const sum = new Float64Array(width);
            for (let row = 0; row < ids.length; row++) {
                if (!owned[row]) {
                    continue;
                }

                const offset = row * width;
                for (let column = 0; column < width; column++) {
                    const value = data[offset + column];
                    sum[column] += value;
                    if (value > maximum[column]) {
                        maximum[column] = value;
                    }
                }

                count++;
            }

            for (let column = 0; column < width; column++) {
                total[column] += sum[column];
            }
        }

        // projection @ [mean, max], then LayerNorm with NumPy's population variance.
        const pooled = new Float64Array(2 * width);
        for (let column = 0; column < width; column++) {
            pooled[column] = total[column] / count;
            pooled[width + column] = maximum[column];
        }

        const z = new Float64Array(width);
        let mean = 0;
        for (let row = 0; row < width; row++) {
            let value = 0;
            for (let column = 0; column < 2 * width; column++) {
                value += projection[row * 2 * width + column] * pooled[column];
            }

            z[row] = value;
            mean += value;
        }

        mean /= width;
        let variance = 0;
        for (let row = 0; row < width; row++) {
            variance += (z[row] - mean) ** 2;
        }

        const deviation = Math.sqrt(variance / width + eps);
        for (let row = 0; row < width; row++) {
            z[row] = ((z[row] - mean) / deviation) * norm_weight[row] + norm_bias[row];
        }

        return [0, 1].map((label) => {
            let value = 0;
            for (let row = 0; row < width; row++) {
                value += head_weight[label * width + row] * z[row];
            }

            return value + head_bias[label];
        });
    }

    async score(command, shell = "bash") {
        const { windows: parts, reason } = this.encode(command, shell);
        if (!parts) {
            return result(this.meta, { reason });
        }

        const [risk, ask] = await this.logits(parts);
        if (!Number.isFinite(risk) || !Number.isFinite(ask)) {
            return result(this.meta, { reason: "nonfinite-model-output" });
        }

        const { scale, bias } = this.meta.calibration;
        const calibrated = scale * risk + bias;
        const score =
            calibrated >= 0 ? 1 / (1 + Math.exp(-calibrated)) : Math.exp(calibrated) / (1 + Math.exp(calibrated));
        const band =
            risk >= this.meta.riskyLogitThreshold
                ? "risky"
                : risk >= this.meta.reviewLogitThreshold
                  ? "review"
                  : "not_flagged";

        return result(this.meta, {
            score,
            classification: band,
            riskLogit: risk,
            windows: parts.length,
            reason: band === "review" ? "uncertainty-band" : null,
        });
    }

    async release() {
        await this.session.release?.();
    }
}
