import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTimeoutStore } from "../extensions/delegation/settings.mjs";
import { LIMITS, timeoutLimits } from "../extensions/delegation/protocol.mjs";

function fixture(t) {
    // Match the store's spelling, including Windows short/long TEMP path aliases.
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-delegation-settings-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    return { dir, file: path.join(dir, "specpi", "delegation", "settings.json"), store: createTimeoutStore(dir) };
}

test("timeout defaults and numeric bounds are explicit and finite", () => {
    assert.equal(LIMITS.jobMs, 600_000);
    assert.equal(LIMITS.batchMs, 1_200_000);
    assert.deepEqual(timeoutLimits(60), { jobMs: 3_600_000, batchMs: 7_200_000 });
    assert.deepEqual(timeoutLimits(1), { jobMs: 60_000, batchMs: 120_000 });
    for (const value of [0, -1, 61, 1.5, NaN, Infinity, "10", undefined, null]) {
        assert.throws(() => timeoutLimits(value), /whole number/);
    }
});

test("preference reads are non-mutating; saves survive a new store and back up only own settings", (t) => {
    const { dir, file, store } = fixture(t);
    assert.equal(store.load(), 10);
    assert.deepEqual(fs.readdirSync(dir), []);
    store.save(15);
    const previous = fs.readFileSync(file, "utf8");
    assert.equal(createTimeoutStore(dir).load(), 15);
    store.save(60);
    assert.equal(createTimeoutStore(dir).load(), 60);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), {
        content: previous,
        sha256: createHash("sha256").update(previous).digest("hex"),
    });
    store.save(10);
    assert.equal(createTimeoutStore(dir).load(), 10);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["settings.json", "settings.json.bak"]);
});

test("invalid or unsafe settings fail closed without exposing contents or overwriting them", (t) => {
    const { file, store } = fixture(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const content of [
        "private sentinel",
        "null",
        "[]",
        '{"schema":1,"timeoutMinutes":61}',
        '{"schema":1,"timeoutMinutes":10,"extra":true}',
        "x".repeat(4097),
    ]) {
        fs.writeFileSync(file, content);
        assert.throws(() => store.load(), /Cannot read delegation settings/);
        assert.throws(() => store.save(20), /Cannot save delegation settings/);
        assert.equal(fs.readFileSync(file, "utf8"), content);
    }

    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(() => store.load(), /Cannot read/);
    assert.throws(() => store.save(20), /Cannot save/);
});

test("failed backup or settings promotion preserves previous bytes and cleans staging files", (t) => {
    const { file, store } = fixture(t);
    store.save(15);
    const previous = fs.readFileSync(file, "utf8");
    const rename = fs.renameSync;
    let rejectedPath;
    let injectedFailures = 0;
    t.mock.method(fs, "renameSync", (from, to) => {
        if (to === rejectedPath) {
            injectedFailures += 1;
            throw new Error("synthetic failure");
        }

        return rename(from, to);
    });
    for (const target of [`${file}.bak`, file]) {
        rejectedPath = target;
        injectedFailures = 0;
        assert.throws(() => store.save(30), /active timeout is unchanged/);
        assert.equal(injectedFailures, 1, "the intended promotion must trigger the injected failure");
        assert.equal(fs.readFileSync(file, "utf8"), previous);
        assert.equal(store.load(), 15);
        assert.deepEqual(
            fs.readdirSync(path.dirname(file)).sort(),
            target === file ? ["settings.json", "settings.json.bak"] : ["settings.json"],
        );
    }
});

test("hardlinks and directory links cannot redirect preference IO", (t) => {
    const { dir, file, store } = fixture(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const target = path.join(dir, "target.json");
    const content = '{"schema":1,"timeoutMinutes":15}';
    fs.writeFileSync(target, content);
    fs.linkSync(target, file);
    assert.throws(() => store.load(), /Cannot read/);
    assert.throws(() => store.save(30), /Cannot save/);
    assert.equal(fs.readFileSync(target, "utf8"), content);
    fs.rmSync(file);
    fs.rmdirSync(path.dirname(file));
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.dirname(file), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => store.load(), /Cannot read/);
    assert.throws(() => store.save(30), /Cannot save/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
});
