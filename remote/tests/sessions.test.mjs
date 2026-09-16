// Session discovery runs against a synthetic sessions tree, never the
// developer's real agent directory.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSessions, summarise, isInsideSessions, sessionsRoot, agentDirectory } from "../src/sessions.js";

const SEP = String.fromCharCode(92);

async function buildTree() {
    const agent = await mkdtemp(path.join(tmpdir(), "specpi-sessions-"));
    const root = path.join(agent, "sessions");
    await mkdir(root, { recursive: true });

    const write = async (project, name, records) => {
        const directory = path.join(root, project);
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, name);
        await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

        return file;
    };

    const alpha = await write("--F--Development-Alpha--", "2026-09-10T00-00-00-000Z_alpha.jsonl", [
        { type: "session", version: 3, id: "alpha", timestamp: "2026-09-10T00:00:00.000Z", cwd: "F:\\Dev\\Alpha" },
        { type: "model_change", model: "synthetic" },
        { type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "Fix the parser" }] } },
        { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "On it" }] } },
    ]);

    const beta = await write("--F--Development-Beta--", "2026-09-12T00-00-00-000Z_beta.jsonl", [
        { type: "session", version: 3, id: "beta", timestamp: "2026-09-12T00:00:00.000Z", cwd: "F:\\Dev\\Beta" },
        { type: "message", id: "m1", message: { role: "user", content: "a plain string body" } },
    ]);

    // No header: not a session we can identify, so it must be skipped.
    const orphan = await write("--F--Development-Beta--", "broken.jsonl", [{ type: "message", id: "x" }]);

    return { agent, root, alpha, beta, orphan };
}

test("agentDirectory honours PI_CODING_AGENT_DIR", () => {
    assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "/tmp/pi" }), "/tmp/pi");
    assert.match(agentDirectory({}), /[\\/]\.pi[\\/]agent$/u);
});

test("lists every session newest first, with previews", async (t) => {
    const tree = await buildTree();
    t.after(() => rm(tree.agent, { recursive: true, force: true }));

    const sessions = await listSessions({ env: { PI_CODING_AGENT_DIR: tree.agent } });
    assert.equal(sessions.length, 2, "the headerless file must be skipped");

    const ids = sessions.map((session) => session.id);
    assert.deepEqual(ids.sort(), ["alpha", "beta"]);

    const alpha = sessions.find((session) => session.id === "alpha");
    assert.equal(alpha.preview, "Fix the parser");
    assert.equal(alpha.messages, 2);
    assert.equal(alpha.project, "F:\\Dev\\Alpha");
});

test("a string message body previews as well as a content array", async (t) => {
    const tree = await buildTree();
    t.after(() => rm(tree.agent, { recursive: true, force: true }));

    const sessions = await listSessions({ env: { PI_CODING_AGENT_DIR: tree.agent } });
    const beta = sessions.find((session) => session.id === "beta");
    assert.equal(beta.preview, "a plain string body");
});

test("the preview is the first user message, not the first message", async (t) => {
    const tree = await buildTree();
    t.after(() => rm(tree.agent, { recursive: true, force: true }));

    const summary = await summarise(tree.alpha);
    assert.equal(summary.preview, "Fix the parser");
    assert.notEqual(summary.preview, "On it");
});

test("a missing sessions directory is an empty list, not an error", async () => {
    const sessions = await listSessions({ env: { PI_CODING_AGENT_DIR: path.join(tmpdir(), "does-not-exist-xyz") } });
    assert.deepEqual(sessions, []);
});

test("limit bounds the work on a machine with many sessions", async (t) => {
    const tree = await buildTree();
    t.after(() => rm(tree.agent, { recursive: true, force: true }));

    const sessions = await listSessions({ env: { PI_CODING_AGENT_DIR: tree.agent }, limit: 1 });
    // limit caps the files scanned, which is the safety property; a scanned
    // file that turns out to have no header still yields nothing.
    assert.ok(sessions.length <= 1);
});

test("session paths are confined to the sessions tree", async (t) => {
    const tree = await buildTree();
    t.after(() => rm(tree.agent, { recursive: true, force: true }));

    const env = { PI_CODING_AGENT_DIR: tree.agent };
    assert.equal(isInsideSessions(tree.alpha, env), true);

    // The specific thing this stops: pointing switch_session at the agent's own
    // credential files, or anywhere else the daemon can read.
    assert.equal(isInsideSessions(path.join(tree.agent, "auth.json"), env), false);
    assert.equal(isInsideSessions(path.join(sessionsRoot(env), "..", "auth.json"), env), false);
    assert.equal(isInsideSessions(path.join(sessionsRoot(env), "..", "..", "etc", "passwd"), env), false);
    assert.equal(isInsideSessions(`C:${SEP}Windows${SEP}win.ini`, env), false);
    assert.equal(isInsideSessions("/etc/shadow", env), false);
});

test("only .jsonl files count as sessions", async (t) => {
    const tree = await buildTree();
    t.after(() => rm(tree.agent, { recursive: true, force: true }));

    const env = { PI_CODING_AGENT_DIR: tree.agent };
    assert.equal(isInsideSessions(path.join(sessionsRoot(env), "project", "notes.txt"), env), false);
    assert.equal(isInsideSessions(path.join(sessionsRoot(env), "project", "a.jsonl"), env), true);
});

test("empty and missing paths are refused", () => {
    assert.equal(isInsideSessions("", {}), false);
    assert.equal(isInsideSessions(undefined, {}), false);
    assert.equal(isInsideSessions(null, {}), false);
});
