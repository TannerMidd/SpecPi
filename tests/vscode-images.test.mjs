import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import imagesModule from "../vscode/src/images.js";

const { normalizeImage, collectImageAttachment, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, MAX_IMAGE_COUNT } =
    imagesModule;
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFElEQVR4AWKSi5r2H4SZGKAAzgAAAAD//+cbP58AAAAGSURBVAMAWfEEIZxk5/sAAAAASUVORK5CYII=";
const JPEG =
    "/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ8ANYif/9k=";
const GIF = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=";
const WEBP = "UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8iJf/LPn8NnHv/5BcsLriMAAAA==";
const WEBP_LOSSLESS = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const FIXTURES = [
    ["png", PNG, 2, 3],
    ["jpeg", JPEG, 2, 3],
    ["gif", GIF, 1, 1],
    ["webp", WEBP, 2, 3],
    ["webp", WEBP_LOSSLESS, 1, 1],
];

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "specpi-images-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));

    return directory;
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function pngWithDimensions(width, height) {
    const buffer = Buffer.from(PNG, "base64");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer.writeUInt32BE(crc32(buffer.subarray(12, 29)), 29);

    return buffer.toString("base64");
}

function webpWithChunks(chunks) {
    const buffer = Buffer.concat(
        chunks.map(([type, data]) => {
            const header = Buffer.alloc(8);
            header.write(type);
            header.writeUInt32LE(data.length, 4);

            return Buffer.concat([header, data, ...(data.length % 2 ? [Buffer.from([0])] : [])]);
        }),
    );
    const header = Buffer.alloc(12);
    header.write("RIFF");
    header.writeUInt32LE(buffer.length + 4, 4);
    header.write("WEBP", 8);

    return Buffer.concat([header, buffer]);
}

test("image normalization supports real PNG, JPEG, GIF, lossy and lossless WebP with reliable dimensions", () => {
    for (const [format, data, width, height] of FIXTURES) {
        assert.deepEqual(normalizeImage({ data, mimeType: `image/${format}`, name: `example.${format}` }), {
            type: "image",
            data,
            mimeType: `image/${format}`,
            width,
            height,
            byteLength: Buffer.from(data, "base64").length,
            name: `example.${format}`,
        });
    }

    assert.equal(normalizeImage({ data: PNG, mimeType: " IMAGE/PNG " }).mimeType, "image/png");
    assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
    assert.equal(MAX_IMAGE_TOTAL_BYTES, 20 * 1024 * 1024);
    assert.equal(MAX_IMAGE_COUNT, 8);
});

test("image normalization requires canonical bounded base64 and matching supported media type", () => {
    for (const data of [null, "", "a".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4)]) {
        assert.throws(() => normalizeImage({ data, mimeType: "image/png" }), /5 MiB/u);
    }

    for (const data of [
        `${PNG}\n`,
        `data:image/png;base64,${PNG}`,
        PNG.slice(0, -1),
        `${PNG.slice(0, -1)}-`,
        "AA=A",
        "AB==",
        "====",
        Buffer.from(PNG, "base64"),
    ]) {
        assert.throws(() => normalizeImage({ data, mimeType: "image/png" }));
    }

    assert.throws(
        () => normalizeImage({ data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64"), mimeType: "image/png" }),
        /5 MiB/u,
    );
    assert.throws(() => normalizeImage({ data: PNG, mimeType: "image/jpeg" }), /does not match/u);
    for (const mimeType of ["image/svg+xml", "text/html", "image/bmp", "image/png; charset=utf-8", undefined]) {
        assert.throws(() => normalizeImage({ data: PNG, mimeType }), /not supported/u);
    }

    for (const source of [
        "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        "<html><script>alert(1)</script></html>",
        "plain text",
    ]) {
        assert.throws(
            () => normalizeImage({ data: Buffer.from(source).toString("base64"), mimeType: "image/png" }),
            /malformed/u,
        );
    }
});

test("image normalization strips path and control characters from optional display names", () => {
    assert.equal(
        normalizeImage({ data: PNG, mimeType: "image/png", name: "C:\\folder\\my\n\u202eimage.png" }).name,
        "my��image.png",
    );
    assert.equal(normalizeImage({ data: PNG, mimeType: "image/png", name: "folder/π image.png" }).name, "π image.png");
    assert.equal(normalizeImage({ data: PNG, mimeType: "image/png", name: "a".repeat(1000) }).name.length, 255);
    assert.equal(Object.hasOwn(normalizeImage({ data: PNG, mimeType: "image/png", name: {} }), "name"), false);
});

test("image dimension limits reject zero, oversized sides, and pixel bombs before decoding pixels", () => {
    for (const [width, height] of [
        [0, 3],
        [2, 0],
        [16_385, 1],
        [1, 16_385],
        [10_000, 10_000],
        [0xffffffff, 0xffffffff],
    ]) {
        assert.throws(
            () => normalizeImage({ data: pngWithDimensions(width, height), mimeType: "image/png" }),
            /pixels/u,
        );
    }

    const gif = Buffer.from(GIF, "base64");
    gif.writeUInt16LE(65535, 6);
    assert.throws(() => normalizeImage({ data: gif.toString("base64"), mimeType: "image/gif" }), /pixels/u);
    const jpeg = Buffer.from(JPEG, "base64");
    const frame = jpeg.indexOf(Buffer.from([255, 0xc0]));
    jpeg.writeUInt16BE(65535, frame + 5);
    assert.throws(() => normalizeImage({ data: jpeg.toString("base64"), mimeType: "image/jpeg" }), /pixels/u);
    const extended = Buffer.alloc(10);
    extended.writeUIntLE(16_384, 4, 3);
    const webp = webpWithChunks([
        ["VP8X", extended],
        ["VP8 ", Buffer.from(WEBP, "base64").subarray(20)],
    ]);
    assert.throws(() => normalizeImage({ data: webp.toString("base64"), mimeType: "image/webp" }), /pixels/u);
});

test("image structural checks reject every truncated fixture and appended HTML", () => {
    for (const [format, data] of FIXTURES) {
        const buffer = Buffer.from(data, "base64");
        for (let length = 0; length < buffer.length; length++) {
            assert.throws(
                () =>
                    normalizeImage({
                        data: buffer.subarray(0, length).toString("base64"),
                        mimeType: `image/${format}`,
                    }),
                `${format} truncation ${length}`,
            );
        }

        assert.throws(
            () =>
                normalizeImage({
                    data: Buffer.concat([buffer, Buffer.from("<script>alert(1)</script>")]).toString("base64"),
                    mimeType: `image/${format}`,
                }),
            /malformed/u,
        );
    }
});

test("PNG validates CRC, chunk lengths, required image data, and header methods", () => {
    const bytes = Buffer.from(PNG, "base64");
    const corrupt = Buffer.from(bytes);
    corrupt[45] ^= 1;
    assert.throws(() => normalizeImage({ data: corrupt.toString("base64"), mimeType: "image/png" }), /malformed/u);
    const noPixels = Buffer.concat([bytes.subarray(0, 33), bytes.subarray(bytes.length - 12)]);
    assert.throws(() => normalizeImage({ data: noPixels.toString("base64"), mimeType: "image/png" }), /malformed/u);
    const oversizedChunk = Buffer.from(bytes);
    oversizedChunk.writeUInt32BE(0xffffffff, 33);
    assert.throws(
        () => normalizeImage({ data: oversizedChunk.toString("base64"), mimeType: "image/png" }),
        /malformed/u,
    );
    const badDepth = Buffer.from(bytes);
    badDepth[24] = 3;
    badDepth.writeUInt32BE(crc32(badDepth.subarray(12, 29)), 29);
    assert.throws(() => normalizeImage({ data: badDepth.toString("base64"), mimeType: "image/png" }), /malformed/u);
});

test("JPEG requires a frame, nonempty scan, and complete segment boundaries", () => {
    const bytes = Buffer.from(JPEG, "base64");
    const scan = bytes.indexOf(Buffer.from([255, 0xda]));
    assert.throws(
        () =>
            normalizeImage({
                data: Buffer.concat([bytes.subarray(0, scan), Buffer.from([255, 0xd9])]).toString("base64"),
                mimeType: "image/jpeg",
            }),
        /malformed/u,
    );
    const oversizedSegment = Buffer.from(bytes);
    oversizedSegment.writeUInt16BE(0xffff, 4);
    assert.throws(
        () => normalizeImage({ data: oversizedSegment.toString("base64"), mimeType: "image/jpeg" }),
        /malformed/u,
    );
});

test("GIF validates frame rectangles, compressed block boundaries, and required image blocks", () => {
    const bytes = Buffer.from(GIF, "base64");
    const badFrame = Buffer.from(bytes);
    badFrame.writeUInt16LE(2, 20);
    assert.throws(() => normalizeImage({ data: badFrame.toString("base64"), mimeType: "image/gif" }), /malformed/u);
    const noImage = Buffer.concat([bytes.subarray(0, 19), Buffer.from([0x3b])]);
    assert.throws(() => normalizeImage({ data: noImage.toString("base64"), mimeType: "image/gif" }), /malformed/u);
    const badBlock = Buffer.from(bytes);
    badBlock[30] = 255;
    assert.throws(() => normalizeImage({ data: badBlock.toString("base64"), mimeType: "image/gif" }), /malformed/u);
});

test("WebP validates RIFF sizes, chunk padding, bitstreams, and extended canvas consistency", () => {
    const bytes = Buffer.from(WEBP, "base64");
    const wrongSize = Buffer.from(bytes);
    wrongSize.writeUInt32LE(0xffffffff, 4);
    assert.throws(() => normalizeImage({ data: wrongSize.toString("base64"), mimeType: "image/webp" }), /malformed/u);
    const extended = Buffer.alloc(10);
    extended.writeUIntLE(1, 4, 3);
    extended.writeUIntLE(2, 7, 3);
    const extendedWebp = webpWithChunks([
        ["VP8X", extended],
        ["VP8 ", bytes.subarray(20)],
    ]);
    assert.equal(normalizeImage({ data: extendedWebp.toString("base64"), mimeType: "image/webp" }).height, 3);
    extended[4] = 4;
    assert.throws(
        () =>
            normalizeImage({
                data: webpWithChunks([
                    ["VP8X", extended],
                    ["VP8 ", bytes.subarray(20)],
                ]).toString("base64"),
                mimeType: "image/webp",
            }),
        /malformed/u,
    );
    assert.throws(
        () => normalizeImage({ data: webpWithChunks([["VP8X", extended]]).toString("base64"), mimeType: "image/webp" }),
        /malformed/u,
    );
    const badPadding = Buffer.from(WEBP_LOSSLESS, "base64");
    badPadding[badPadding.length - 1] = 1;
    assert.throws(() => normalizeImage({ data: badPadding.toString("base64"), mimeType: "image/webp" }), /malformed/u);
    const emptyPartition = Buffer.from(bytes.subarray(20));
    emptyPartition.writeUIntLE(16, 0, 3);
    assert.throws(
        () =>
            normalizeImage({
                data: webpWithChunks([["VP8 ", emptyPartition]]).toString("base64"),
                mimeType: "image/webp",
            }),
        /malformed/u,
    );
});

test("animated GIF and WebP require frame data inside their declared canvas", () => {
    const gif = Buffer.from(GIF, "base64");
    const animatedGif = Buffer.concat([gif.subarray(0, -1), gif.subarray(19)]);
    assert.equal(normalizeImage({ data: animatedGif.toString("base64"), mimeType: "image/gif" }).width, 1);

    const canvas = Buffer.alloc(10);
    canvas[0] = 2;
    canvas.writeUIntLE(1, 4, 3);
    canvas.writeUIntLE(2, 7, 3);
    const frame = Buffer.alloc(16);
    frame.writeUIntLE(1, 6, 3);
    frame.writeUIntLE(2, 9, 3);
    const imageChunks = Buffer.from(WEBP, "base64").subarray(12);
    const animatedWebp = webpWithChunks([
        ["VP8X", canvas],
        ["ANIM", Buffer.alloc(6)],
        ["ANMF", Buffer.concat([frame, imageChunks])],
    ]);
    assert.equal(normalizeImage({ data: animatedWebp.toString("base64"), mimeType: "image/webp" }).height, 3);
    frame.writeUIntLE(1, 0, 3);
    const escaped = webpWithChunks([
        ["VP8X", canvas],
        ["ANIM", Buffer.alloc(6)],
        ["ANMF", Buffer.concat([frame, imageChunks])],
    ]);
    assert.throws(() => normalizeImage({ data: escaped.toString("base64"), mimeType: "image/webp" }), /malformed/u);
});

test("image container scans bound adversarial chunk counts", () => {
    const chunks = Array.from({ length: 4097 }, () => ["JUNK", Buffer.alloc(0)]);
    chunks.push(["VP8 ", Buffer.from(WEBP, "base64").subarray(20)]);
    assert.throws(
        () => normalizeImage({ data: webpWithChunks(chunks).toString("base64"), mimeType: "image/webp" }),
        /malformed/u,
    );
});

test("image file attachments use actual format and explicit local paths outside any workspace", async (t) => {
    const directory = await fixture(t);
    const filePath = path.join(directory, "π screenshot.wrong-extension");
    await fs.writeFile(filePath, Buffer.from(PNG, "base64"));
    const image = await collectImageAttachment({ filePath });
    assert.equal(image.kind, "image");
    assert.equal(image.type, "image");
    assert.equal(image.label, "π screenshot.wrong-extension");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.width, 2);
    assert.equal(image.height, 3);
    assert.equal(image.byteLength, 95);
    assert.equal(image.data, PNG);
    assert.match(image.id, /^[a-f0-9-]+$/u);
    assert.match(image.detail, /2 × 3/u);
});

test("image file attachments reject nonfiles, oversized content, sensitive paths, and invalid image bodies", async (t) => {
    const directory = await fixture(t);
    await assert.rejects(collectImageAttachment({ filePath: directory }), /Only regular/u);
    await assert.rejects(collectImageAttachment({ filePath: path.join(directory, "missing.png") }), /unavailable/u);
    for (const name of [
        ".env",
        "auth.json",
        "trust.png",
        "credentials.png",
        "history.png",
        "sessions/screenshot.png",
        ".ssh/screenshot.png",
    ]) {
        await assert.rejects(collectImageAttachment({ filePath: path.join(directory, name) }), /cannot be attached/u);
    }

    const filePath = path.join(directory, "large.png");
    await fs.writeFile(filePath, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    await assert.rejects(collectImageAttachment({ filePath }), /5 MiB/u);
    await fs.writeFile(filePath, "<svg></svg>");
    await assert.rejects(collectImageAttachment({ filePath }), /malformed/u);
});

test("image file attachments reject unsafe native paths without opening them", async () => {
    for (const filePath of [
        "relative.png",
        "file:///tmp/image.png",
        "//server/share/image.png",
        "\\\\server\\share\\image.png",
        "\\\\?\\C:\\image.png",
        "\\\\.\\pipe\\image",
        "C:\\image.png:secret",
        "C:\\NUL.png",
        "C:\\CONIN$",
        "C:\\image\u0000.png",
    ]) {
        await assert.rejects(collectImageAttachment({ filePath }), /local image|ordinary local/u);
    }
});

test("image file attachments reject canonical credential aliases and hard links", async (t) => {
    const directory = await fixture(t);
    const privateDirectory = path.join(directory, ".aws");
    await fs.mkdir(privateDirectory);
    await fs.writeFile(path.join(privateDirectory, "image.png"), Buffer.from(PNG, "base64"));
    const linkedDirectory = path.join(directory, "alias");
    await fs.symlink(privateDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
        collectImageAttachment({ filePath: path.join(linkedDirectory, "image.png") }),
        /cannot be attached/u,
    );
    const ordinary = path.join(directory, "ordinary.png");
    await fs.writeFile(ordinary, Buffer.from(PNG, "base64"));
    const hardlinked = path.join(directory, "hardlinked.png");
    await fs.link(ordinary, hardlinked);
    await assert.rejects(collectImageAttachment({ filePath: hardlinked }), /hard links/u);
});

test("image file attachments discard reads when a file grows during collection", async (t) => {
    const directory = await fixture(t);
    const filePath = path.join(directory, "changing.png");
    await fs.writeFile(filePath, Buffer.from(PNG, "base64"));
    const originalOpen = fs.open;
    fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        let changed = false;
        handle.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            if (!changed) {
                changed = true;
                await fs.appendFile(filePath, Buffer.from([0]));
            }

            return result;
        };

        return handle;
    };

    try {
        await assert.rejects(collectImageAttachment({ filePath }), /changed while being attached/u);
    } finally {
        fs.open = originalOpen;
    }
});
