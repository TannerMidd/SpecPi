import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, describe, it } from "node:test";
import { extractEntries } from "../src/zip.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lancet-zip-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

/**
 * A minimal ZIP writer for fixtures. `entries` items: { name, data, method?, flags?, declared?,
 * compressed? } -- `declared` overrides the recorded uncompressed size, `compressed` the stored
 * bytes, so malformed archives can be built on purpose.
 */
function zip(file, entries, { zip64 = false } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const method = entry.method ?? 8;
        const body = entry.compressed ?? (method === 8 ? zlib.deflateRawSync(entry.data) : entry.data);
        const name = Buffer.from(entry.name);
        const size = entry.declared ?? entry.data.length;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(entry.flags ?? 0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(entry.flags ?? 0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += 30 + name.length + body.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));

    return file;
}

const a = Buffer.from("alpha ".repeat(500));
const b = Buffer.from("bravo");

describe("model archive reader", () => {
    it("extracts only the named entries, deflated or stored", () => {
        const file = zip(path.join(temporary, "ok.zip"), [
            { name: "x/other.txt", data: Buffer.from("ignored") },
            { name: "x/a", data: a },
            { name: "x/b", data: b, method: 0 },
        ]);
        const out = extractEntries(file, { "x/a": a.length, "x/b": b.length });
        assert.deepEqual([...out.keys()], ["x/a", "x/b"]);
        assert.ok(out.get("x/a").equals(a));
        assert.ok(out.get("x/b").equals(b));
    });

    it("refuses a missing or duplicated entry", () => {
        const file = zip(path.join(temporary, "missing.zip"), [{ name: "x/a", data: a }]);
        assert.throws(() => extractEntries(file, { "x/a": a.length, "x/b": 1 }), /missing x\/b/u);
        const twice = zip(path.join(temporary, "twice.zip"), [
            { name: "x/a", data: a },
            { name: "x/a", data: a },
        ]);
        assert.throws(() => extractEntries(twice, { "x/a": a.length }), /duplicate/u);
    });

    it("refuses a recorded size other than the pinned one", () => {
        const file = zip(path.join(temporary, "size.zip"), [{ name: "x/a", data: a }]);
        assert.throws(() => extractEntries(file, { "x/a": a.length - 1 }), /wrong size/u);
    });

    it("caps inflation at the pinned size, whatever the header claims", () => {
        // The header claims 10 bytes; the data inflates to far more.
        const file = zip(path.join(temporary, "bomb.zip"), [{ name: "x/a", data: a, declared: 10 }]);
        assert.throws(() => extractEntries(file, { "x/a": 10 }));
    });

    it("refuses encryption, other compression methods and ZIP64", () => {
        const encrypted = zip(path.join(temporary, "enc.zip"), [{ name: "x/a", data: a, flags: 1 }]);
        assert.throws(() => extractEntries(encrypted, { "x/a": a.length }), /encrypted/u);
        const bzip = zip(path.join(temporary, "bz.zip"), [{ name: "x/a", data: a, method: 12, compressed: a }]);
        assert.throws(() => extractEntries(bzip, { "x/a": a.length }), /compression method 12/u);
        const big = zip(path.join(temporary, "z64.zip"), [{ name: "x/a", data: a }], { zip64: true });
        assert.throws(() => extractEntries(big, { "x/a": a.length }), /ZIP64/u);
    });

    it("refuses a file that is not a ZIP", () => {
        const file = path.join(temporary, "not.zip");
        fs.writeFileSync(file, "just text, no directory");
        assert.throws(() => extractEntries(file, { "x/a": 1 }), /no end of central directory/u);
    });
});
