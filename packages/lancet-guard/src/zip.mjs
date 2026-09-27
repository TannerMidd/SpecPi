// A deliberately small ZIP reader: enough to take named files out of one pinned release archive.
//
// It reads the central directory, finds entries by exact name, and inflates each one to a size
// cap. It refuses what it does not need to support rather than guessing: ZIP64, multi-disk
// archives, encrypted entries and any compression other than stored or Deflate. The archive's own
// SHA-256 is checked before this runs, and every extracted file is checked again after it, so this
// code decides nothing about trust; it only has to fail rather than misread.

import fs from "node:fs";
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function fail(message) {
    throw new Error(`Unsupported or damaged model archive: ${message}`);
}

function read(handle, position, length) {
    const buffer = Buffer.alloc(length);
    const got = fs.readSync(handle, buffer, 0, length, position);
    if (got !== length) {
        fail("unexpected end of file");
    }

    return buffer;
}

/** The central-directory records for `names`, keyed by name. */
function locate(handle, size, names) {
    // The end-of-central-directory record is within the last 22 + 65,535 bytes (its comment).
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = read(handle, size - tailLength, tailLength);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
        if (tail.readUInt32LE(index) === EOCD) {
            end = index;
            break;
        }
    }

    if (end < 0) {
        fail("no end of central directory");
    }

    const disk = tail.readUInt16LE(end + 4);
    const entries = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (disk !== 0 || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
        fail("multi-disk or ZIP64 archive");
    }

    if (directoryOffset + directorySize > size) {
        fail("central directory out of range");
    }

    const directory = read(handle, directoryOffset, directorySize);
    const wanted = new Set(names);
    const found = new Map();
    let cursor = 0;
    for (let count = 0; count < entries; count++) {
        if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL) {
            fail("bad central directory entry");
        }

        const flags = directory.readUInt16LE(cursor + 8);
        const method = directory.readUInt16LE(cursor + 10);
        const compressed = directory.readUInt32LE(cursor + 20);
        const uncompressed = directory.readUInt32LE(cursor + 24);
        const nameLength = directory.readUInt16LE(cursor + 28);
        const extraLength = directory.readUInt16LE(cursor + 30);
        const commentLength = directory.readUInt16LE(cursor + 32);
        const offset = directory.readUInt32LE(cursor + 42);
        const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
        cursor += 46 + nameLength + extraLength + commentLength;
        if (!wanted.has(name)) {
            continue;
        }

        if (found.has(name)) {
            fail(`duplicate entry ${name}`);
        }

        if (flags & 0x1) {
            fail(`encrypted entry ${name}`);
        }

        if (method !== 0 && method !== 8) {
            fail(`compression method ${method} for ${name}`);
        }

        if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) {
            fail(`ZIP64 entry ${name}`);
        }

        found.set(name, { method, compressed, uncompressed, offset });
    }

    for (const name of names) {
        if (!found.has(name)) {
            fail(`missing ${name}`);
        }
    }

    return found;
}

/**
 * Extract the named entries from the archive at `file`, each capped at `limits[name]` bytes.
 * Returns a Map of name to Buffer.
 *
 * @param {string} file
 * @param {Record<string, number>} limits
 */
export function extractEntries(file, limits) {
    const names = Object.keys(limits);
    const handle = fs.openSync(file, "r");
    try {
        const size = fs.fstatSync(handle).size;
        const entries = locate(handle, size, names);
        const out = new Map();
        for (const name of names) {
            const entry = entries.get(name);
            if (entry.uncompressed !== limits[name]) {
                fail(`${name} is the wrong size`);
            }

            const header = read(handle, entry.offset, 30);
            if (header.readUInt32LE(0) !== LOCAL) {
                fail(`bad local header for ${name}`);
            }

            const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
            if (start + entry.compressed > size) {
                fail(`${name} data out of range`);
            }

            const data = read(handle, start, entry.compressed);
            const bytes = entry.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: limits[name] });
            if (bytes.length !== limits[name]) {
                fail(`${name} inflated to the wrong size`);
            }

            out.set(name, bytes);
        }

        return out;
    } finally {
        fs.closeSync(handle);
    }
}
