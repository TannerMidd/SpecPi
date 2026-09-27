import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MODEL_ARCHIVE } from "../src/model-manifest.mjs";
import { installModel, modelDirectory, modelState, modelVerified } from "../src/model-store.mjs";

// The real release ZIP, when one is available, lets the success path run against the real bytes:
// LANCET_MODEL_ARCHIVE=<path to lancet-v0.4.0-nano-cpu-int8.zip>. Without it that case is skipped;
// CI covers it end to end by downloading the model through installModel itself.
const ARCHIVE = process.env.LANCET_MODEL_ARCHIVE;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lancet-store-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function agentDir(name) {
    return path.join(temporary, name);
}

function response(body, { status = 200, url = "", length } = {}) {
    const bytes = Buffer.from(body);

    return {
        ok: status >= 200 && status < 300,
        status,
        url,
        headers: new Headers(length === undefined ? {} : { "content-length": String(length) }),
        body: (async function* () {
            yield bytes;
        })(),
    };
}

function leftovers(dir) {
    const parent = path.dirname(modelDirectory(dir));

    return fs.existsSync(parent) ? fs.readdirSync(parent) : [];
}

describe("model download", () => {
    it("fetches only the pinned GitHub release archive", async () => {
        const requested = [];
        await assert.rejects(
            installModel({
                agentDir: agentDir("urls"),
                fetchImpl: async (url) => {
                    requested.push(url);

                    return response("not the model");
                },
            }),
            /checksum/u,
        );
        assert.deepEqual(requested, [MODEL_ARCHIVE.url]);
        assert.ok(MODEL_ARCHIVE.url.startsWith("https://github.com/TannerMidd/LANCET-model/releases/download/"));
    });

    it("refuses wrong bytes and leaves nothing behind", async () => {
        const dir = agentDir("wrong");
        await assert.rejects(installModel({ agentDir: dir, fetchImpl: async () => response("x") }), /checksum/u);
        assert.equal(modelState(modelDirectory(dir)).installed, false);
        assert.deepEqual(leftovers(dir), []);
    });

    it("refuses a body larger than the pinned archive without reading it all", async () => {
        const dir = agentDir("large");
        await assert.rejects(
            installModel({
                agentDir: dir,
                fetchImpl: async () => ({ ...response(""), body: [Buffer.alloc(MODEL_ARCHIVE.bytes + 1)] }),
            }),
            /larger than the pinned archive/u,
        );
        assert.deepEqual(leftovers(dir), []);
    });

    it("refuses a declared size that does not match", async () => {
        await assert.rejects(
            installModel({ agentDir: agentDir("declared"), fetchImpl: async () => response("x", { length: 12 }) }),
            /wrong size/u,
        );
    });

    it("refuses HTTP errors and redirects off HTTPS", async () => {
        await assert.rejects(
            installModel({ agentDir: agentDir("404"), fetchImpl: async () => response("", { status: 404 }) }),
            /HTTP 404/u,
        );
        await assert.rejects(
            installModel({
                agentDir: agentDir("http"),
                fetchImpl: async () => response("x", { url: "http://example.invalid/model" }),
            }),
            /off HTTPS/u,
        );
    });

    it("keeps a damaged earlier copy in place when a download fails", async () => {
        const dir = agentDir("damaged");
        const target = modelDirectory(dir);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "model.json"), "{}");
        await assert.rejects(installModel({ agentDir: dir, fetchImpl: async () => response("x") }));
        assert.equal(fs.readFileSync(path.join(target, "model.json"), "utf8"), "{}");
        assert.deepEqual(leftovers(dir), [path.basename(target)]);
    });

    it(
        "installs the real archive, replacing a damaged copy, then leaves a verified one alone",
        { skip: !ARCHIVE && "LANCET_MODEL_ARCHIVE not set" },
        async () => {
            const dir = agentDir("real");
            const target = modelDirectory(dir);
            fs.mkdirSync(target, { recursive: true });
            fs.writeFileSync(path.join(target, "model.json"), "{}");
            const first = await installModel({
                agentDir: dir,
                fetchImpl: async () => ({ ...response(""), body: fs.createReadStream(ARCHIVE) }),
            });
            assert.equal(first.reason, "downloaded");
            assert.ok(modelVerified(target));
            assert.deepEqual(fs.readdirSync(target).sort(), ["model-int8.onnx", "model.json", "tokenizer.json"]);
            assert.deepEqual(leftovers(dir), [path.basename(target)], "no staging, archive or replaced copy left");
            const second = await installModel({
                agentDir: dir,
                fetchImpl: async () => {
                    throw new Error("must not download again");
                },
            });
            assert.equal(second.reason, "already-current");
        },
    );
});
