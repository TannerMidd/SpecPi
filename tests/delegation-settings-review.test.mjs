import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTimeoutStore } from "../extensions/delegation/settings.mjs";

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-timeout-review-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return root;
}

test("every accepted maximum-size preference can be backed up and replaced repeatedly", (t) => {
    const root = fixture(t);
    const dir = path.join(root, "specpi", "delegation");
    const file = path.join(dir, "settings.json");
    fs.mkdirSync(dir, { recursive: true });
    const compact = '{"schema":1,"timeoutMinutes":10}';
    const padded = compact + "\n".repeat(4096 - Buffer.byteLength(compact));
    fs.writeFileSync(file, padded);
    const store = createTimeoutStore(root);
    assert.equal(store.load(), 10);
    store.save(15);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).content, padded);
    assert.ok(fs.statSync(`${file}.bak`).size > 4096);
    store.save(30);
    assert.equal(store.load(), 30);
    store.save(10);
    assert.equal(store.load(), 10);
});

test("trusted agent-directory aliases work without allowing links in owned preference state", (t) => {
    const root = fixture(t);
    const real = path.join(root, "real");
    const alias = path.join(root, "alias");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    // Models system aliases such as macOS /var -> /private/var and a not-yet-created agent dir.
    const store = createTimeoutStore(path.join(alias, "agent", "nested"));
    assert.equal(store.load(), 10);
    assert.deepEqual(fs.readdirSync(real), []);
    store.save(15);
    const actualAgentDir = path.join(real, "agent", "nested");
    assert.equal(createTimeoutStore(actualAgentDir).load(), 15);
    assert.equal(createTimeoutStore(path.join(alias, "agent", "nested")).load(), 15);
    const ownDir = path.join(actualAgentDir, "specpi", "delegation");
    fs.renameSync(ownDir, `${ownDir}-moved`);
    fs.symlinkSync(`${ownDir}-moved`, ownDir, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => store.load(), /Cannot read delegation settings/);
    assert.throws(() => store.save(30), /Cannot save delegation settings/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(`${ownDir}-moved`, "settings.json"), "utf8")).timeoutMinutes, 15);
});
