"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const { sensitivePath } = require("./context");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_COUNT = 8;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 40_000_000;
const MAX_CONTAINER_PARTS = 4_096;
const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }

    return crc >>> 0;
});

function malformed() {
    throw new Error("This image is malformed or incomplete. Choose a valid PNG, JPEG, GIF, or WebP image.");
}

function dimensions(width, height) {
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
        throw new Error("Images must be no larger than 16,384 pixels per side and 40 million pixels in total.");
    }

    return { width, height };
}

function pngDimensions(buffer) {
    let offset = 8;
    let result;
    let imageBytes = 0;
    let palette = false;
    let indexed = false;
    let chunks = 0;
    while (offset + 12 <= buffer.length) {
        if (++chunks > MAX_CONTAINER_PARTS) {
            malformed();
        }

        const length = buffer.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > buffer.length) {
            malformed();
        }

        const type = buffer.toString("ascii", offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/u.test(type)) {
            malformed();
        }

        let crc = 0xffffffff;
        for (let index = offset + 4; index < end - 4; index++) {
            crc = CRC_TABLE[(crc ^ buffer[index]) & 255] ^ (crc >>> 8);
        }

        if ((crc ^ 0xffffffff) >>> 0 !== buffer.readUInt32BE(end - 4)) {
            malformed();
        }

        if (type === "IHDR") {
            if (result || offset !== 8 || length !== 13) {
                malformed();
            }

            result = dimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12));
            const depth = buffer[offset + 16];
            const color = buffer[offset + 17];
            const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (
                !depths[color]?.includes(depth) ||
                buffer[offset + 18] !== 0 ||
                buffer[offset + 19] !== 0 ||
                buffer[offset + 20] > 1
            ) {
                malformed();
            }

            indexed = color === 3;
        } else if (!result) {
            malformed();
        } else if (type === "PLTE") {
            if (palette || imageBytes || length === 0 || length > 768 || length % 3 !== 0) {
                malformed();
            }

            palette = true;
        } else if (type === "IDAT") {
            imageBytes += length;
        } else if (type === "fcTL") {
            if (length !== 26) {
                malformed();
            }

            const frame = dimensions(buffer.readUInt32BE(offset + 12), buffer.readUInt32BE(offset + 16));
            if (
                buffer.readUInt32BE(offset + 20) + frame.width > result.width ||
                buffer.readUInt32BE(offset + 24) + frame.height > result.height
            ) {
                malformed();
            }
        } else if (type === "IEND") {
            if (length !== 0 || end !== buffer.length || imageBytes <= 6 || (indexed && !palette)) {
                malformed();
            }

            return result;
        } else if (type[0] === type[0].toUpperCase()) {
            malformed();
        }

        offset = end;
    }

    return malformed();
}

function jpegDimensions(buffer) {
    let offset = 2;
    let result;
    let scanned = false;
    let entropyBytes = 0;
    while (offset < buffer.length) {
        if (buffer[offset++] !== 255) {
            malformed();
        }

        while (buffer[offset] === 255) {
            offset++;
        }

        const marker = buffer[offset++];
        if (marker === 0xd9) {
            if (!result || !scanned || !entropyBytes || offset !== buffer.length) {
                malformed();
            }

            return result;
        }

        if (
            marker === undefined ||
            marker === 0 ||
            marker === 0xd8 ||
            (marker >= 0xd0 && marker <= 0xd7) ||
            offset + 2 > buffer.length
        ) {
            malformed();
        }

        const length = buffer.readUInt16BE(offset);
        const end = offset + length;
        if (length < 2 || end > buffer.length) {
            malformed();
        }

        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            if (result || length < 11 || length !== 8 + 3 * buffer[offset + 7]) {
                malformed();
            }

            result = dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
        }

        offset = end;
        if (marker === 0xda) {
            if (!result || length < 6) {
                malformed();
            }

            scanned = true;
            while (offset < buffer.length) {
                if (buffer[offset] !== 255) {
                    entropyBytes++;
                    offset++;
                } else if (buffer[offset + 1] === 0 || (buffer[offset + 1] >= 0xd0 && buffer[offset + 1] <= 0xd7)) {
                    entropyBytes++;
                    offset += 2;
                } else {
                    break;
                }
            }
        }
    }

    return malformed();
}

function gifDimensions(buffer) {
    if (buffer.length < 14) {
        malformed();
    }

    const result = dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
    let offset = 13 + (buffer[10] & 128 ? 3 * 2 ** ((buffer[10] & 7) + 1) : 0);
    let frames = 0;
    let blocks = 0;
    function skipBlocks() {
        let bytes = 0;
        while (offset < buffer.length) {
            const length = buffer[offset++];
            if (length === 0) {
                return bytes;
            }

            offset += length;
            bytes += length;
        }

        return malformed();
    }

    while (offset < buffer.length) {
        if (++blocks > MAX_CONTAINER_PARTS) {
            malformed();
        }

        const marker = buffer[offset++];
        if (marker === 0x3b) {
            if (!frames || offset !== buffer.length) {
                malformed();
            }

            return result;
        }

        if (marker === 0x21) {
            offset++;
            skipBlocks();
        } else if (marker === 0x2c) {
            if (offset + 9 > buffer.length) {
                malformed();
            }

            const frame = dimensions(buffer.readUInt16LE(offset + 4), buffer.readUInt16LE(offset + 6));
            if (
                buffer.readUInt16LE(offset) + frame.width > result.width ||
                buffer.readUInt16LE(offset + 2) + frame.height > result.height
            ) {
                malformed();
            }

            const flags = buffer[offset + 8];
            offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
            const codeSize = buffer[offset++];
            if (!(codeSize >= 2 && codeSize <= 8) || !skipBlocks()) {
                malformed();
            }

            frames++;
        } else {
            malformed();
        }
    }

    return malformed();
}

function webpBitstream(type, data) {
    if (type === "VP8 ") {
        if (
            data.length <= 10 ||
            (data[0] & 1) !== 0 ||
            !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a])) ||
            data.readUIntLE(0, 3) >>> 5 === 0 ||
            data.readUIntLE(0, 3) >>> 5 >= data.length - 10
        ) {
            malformed();
        }

        return dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
    }

    if (type === "VP8L") {
        if (data.length <= 5 || data[0] !== 0x2f || (data[4] & 0xe0) !== 0) {
            malformed();
        }

        const bits = data.readUInt32LE(1);

        return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }

    return null;
}

function webpChunks(buffer, start = 12) {
    const chunks = [];
    let offset = start;
    while (offset + 8 <= buffer.length) {
        if (chunks.length >= MAX_CONTAINER_PARTS) {
            malformed();
        }

        const size = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + size;
        const padded = end + (size % 2);
        if (padded > buffer.length || (size % 2 && buffer[end] !== 0)) {
            malformed();
        }

        chunks.push({ type: buffer.toString("ascii", offset, offset + 4), data: buffer.subarray(offset + 8, end) });
        offset = padded;
    }

    if (offset !== buffer.length) {
        malformed();
    }

    return chunks;
}

function webpDimensions(buffer) {
    if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
        malformed();
    }

    let result;
    let images = 0;
    let animation = false;
    let animationHeader = false;
    for (const { type, data } of webpChunks(buffer)) {
        if (type === "VP8X") {
            if (result || data.length !== 10 || data[0] & 0xc1 || data.readUIntLE(1, 3) !== 0) {
                malformed();
            }

            result = dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
            animation = Boolean(data[0] & 2);
        } else if (type === "ANIM") {
            if (!animation || animationHeader || data.length !== 6) {
                malformed();
            }

            animationHeader = true;
        } else if (type === "ANMF") {
            if (!animationHeader || !result || data.length < 24) {
                malformed();
            }

            const frame = dimensions(data.readUIntLE(6, 3) + 1, data.readUIntLE(9, 3) + 1);
            if (
                data.readUIntLE(0, 3) * 2 + frame.width > result.width ||
                data.readUIntLE(3, 3) * 2 + frame.height > result.height ||
                data[15] & 0xfc
            ) {
                malformed();
            }

            const bitstreams = webpChunks(data, 16)
                .map((chunk) => webpBitstream(chunk.type, chunk.data))
                .filter(Boolean);
            if (
                bitstreams.length !== 1 ||
                bitstreams[0].width !== frame.width ||
                bitstreams[0].height !== frame.height
            ) {
                malformed();
            }

            images++;
        } else {
            const frame = webpBitstream(type, data);
            if (frame) {
                if (
                    animation ||
                    images ||
                    (result && (result.width !== frame.width || result.height !== frame.height))
                ) {
                    malformed();
                }

                result = frame;
                images++;
            }
        }
    }

    if (!result || !images) {
        malformed();
    }

    return result;
}

function inspectImage(buffer) {
    if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return { mimeType: "image/png", ...pngDimensions(buffer) };
    }

    if (buffer[0] === 255 && buffer[1] === 0xd8) {
        return { mimeType: "image/jpeg", ...jpegDimensions(buffer) };
    }

    if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
        return { mimeType: "image/gif", ...gifDimensions(buffer) };
    }

    if (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        return { mimeType: "image/webp", ...webpDimensions(buffer) };
    }

    return malformed();
}

function safeName(value) {
    if (typeof value !== "string") {
        return undefined;
    }

    return (
        value
            .replaceAll("\\", "/")
            .split("/")
            .pop()
            .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "�")
            .slice(0, 255)
            .trim() || undefined
    );
}

function normalizeImage({ data, mimeType, name } = {}) {
    const mime = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
    if (!SUPPORTED_MIMES.has(mime)) {
        throw new Error("Attach a PNG, JPEG, GIF, or WebP image. SVG and other image formats are not supported.");
    }

    if (typeof data !== "string" || !data.length || data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
        throw new Error("Each image must contain no more than 5 MiB of data.");
    }

    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
        malformed();
    }

    const buffer = Buffer.from(data, "base64");
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error("Each image must contain no more than 5 MiB of data.");
    }

    if (buffer.toString("base64") !== data) {
        malformed();
    }

    const actual = inspectImage(buffer);
    if (actual.mimeType !== mime) {
        throw new Error("The image format does not match its declared media type.");
    }

    const label = safeName(name);

    // Validate the container, dimensions, and presence of image data here. The
    // browser/provider decoder remains responsible for decoding compressed pixels.
    return { type: "image", data, ...actual, byteLength: buffer.length, ...(label ? { name: label } : {}) };
}

function assertImagePath(filePath) {
    if (
        typeof filePath !== "string" ||
        !path.isAbsolute(filePath) ||
        filePath.length > 32_768 ||
        /[\u0000-\u001f\u007f]/u.test(filePath)
    ) {
        throw new Error("Choose a saved local image file.");
    }

    const normalized = filePath.replaceAll("\\", "/");
    const segments = normalized.replace(/^[a-z]:\//iu, "").split("/");
    if (
        normalized.startsWith("//") ||
        segments.some(
            (segment) =>
                segment.includes(":") ||
                /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(segment) ||
                (segment !== "." && segment !== ".." && /[. ]$/u.test(segment)),
        )
    ) {
        throw new Error(
            "Choose an ordinary local image file. Network paths, devices, and alternate data streams are not supported.",
        );
    }

    if (sensitivePath(filePath)) {
        throw new Error(
            "Private credentials and Pi authentication, trust, sessions, missions, or history cannot be attached.",
        );
    }
}

async function collectImageAttachment({ filePath }) {
    assertImagePath(filePath);
    let canonicalFile;
    try {
        canonicalFile = await fs.realpath(filePath);
    } catch {
        throw new Error("The selected image is unavailable. Check that it still exists.");
    }

    assertImagePath(canonicalFile);
    let handle;
    let buffer;
    try {
        // Inspect before opening so special files such as POSIX FIFOs cannot block.
        const initial = await fs.stat(canonicalFile);
        if (!initial.isFile()) {
            throw new Error("Only regular local image files can be attached.");
        }

        handle = await fs.open(
            canonicalFile,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
        );
        const info = await handle.stat();
        if (!info.isFile() || initial.dev !== info.dev || initial.ino !== info.ino) {
            throw new Error("The selected image changed. Select it again.");
        }

        if (info.nlink !== 1) {
            throw new Error("Files with hard links cannot be safely attached. Select an ordinary image file.");
        }

        if (info.size > MAX_IMAGE_BYTES) {
            throw new Error("Each image must contain no more than 5 MiB of data.");
        }

        const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1));
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
            if (!bytesRead) {
                break;
            }

            length += bytesRead;
        }

        const currentPath = await fs.realpath(filePath);
        const currentInfo = await fs.stat(currentPath);
        const finalInfo = await handle.stat();
        if (
            length !== info.size ||
            currentPath !== canonicalFile ||
            currentInfo.dev !== info.dev ||
            currentInfo.ino !== info.ino ||
            currentInfo.nlink !== 1 ||
            finalInfo.size !== info.size ||
            finalInfo.mtimeMs !== info.mtimeMs ||
            finalInfo.ctimeMs !== info.ctimeMs
        ) {
            throw new Error("The selected image changed while being attached. Select it again.");
        }

        buffer = bytes.subarray(0, length);
    } catch (error) {
        if (error?.code) {
            throw new Error("The selected image could not be read safely. Check that it is available.");
        }

        throw error;
    } finally {
        await handle?.close();
    }

    const actual = inspectImage(buffer);
    const image = normalizeImage({
        data: buffer.toString("base64"),
        mimeType: actual.mimeType,
        name: path.basename(filePath),
    });

    return {
        id: crypto.randomUUID(),
        kind: "image",
        label: image.name || "Image",
        detail: `${image.width} × ${image.height} · ${image.byteLength} bytes`,
        ...image,
    };
}

module.exports = { normalizeImage, collectImageAttachment, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, MAX_IMAGE_COUNT };
