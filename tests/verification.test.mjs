import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { OutputRing, TaskRunner, terminateOwned } from "../extensions/background-tasks/core.mjs";
import {
    VERIFY_LIMITS,
    VerificationRegistry,
    captureInputs,
    normalizeVerification,
    verificationOutput,
} from "../extensions/background-tasks/verification.mjs";
import { createTaskContract, validateTaskContract } from "../extensions/workflow-controls/task-contract.mjs";
import {
    currentReceipts,
    requiredCheckEvidence,
    selectRequiredChecks,
} from "../extensions/workflow-controls/verification.mjs";
import { validateChallengeSubmission } from "../extensions/workflow-controls/challenge.mjs";

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-check-")));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "main.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "check.js"), "console.log('checked');\n");
    fs.writeFileSync(path.join(root, "config.json"), "{}\n");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return root;
}

test("declared input snapshots bind initially clean sources, tests, config and added files", (t) => {
    const root = fixture(t);
    const inputs = ["src/", "check.js", "config.json"];
    const before = captureInputs(root, inputs);
    assert.equal(before.files.length, 3);
    assert.equal(captureInputs(root, [...inputs].reverse()).digest, before.digest);
    for (const file of ["src/main.js", "check.js", "config.json"]) {
        const original = fs.readFileSync(path.join(root, file));
        fs.appendFileSync(path.join(root, file), "changed");
        assert.notEqual(captureInputs(root, inputs).digest, before.digest);
        fs.writeFileSync(path.join(root, file), original);
    }

    fs.writeFileSync(path.join(root, "src", "new.js"), "new");
    assert.notEqual(captureInputs(root, inputs).digest, before.digest);
    fs.unlinkSync(path.join(root, "check.js"));
    assert.throws(() => captureInputs(root, inputs));
});

test("verification manifests reject private state, traversal, link escapes and oversized inventories", (t) => {
    const root = fixture(t);
    for (const inputs of [
        [],
        ["../check.js"],
        ["/check.js"],
        ["C:check.js"],
        [".env"],
        [".npmrc"],
        [".netrc"],
        ["id_ed25519"],
        ["auth.json.backup"],
        [".pi/agent/auth.json"],
        ["src//main.js"],
        ["src/../check.js"],
        ["src/*"],
        ["src/main.js", "src/main.js"],
        Array(41).fill("check.js"),
    ]) {
        assert.throws(() => captureInputs(root, inputs));
    }

    fs.mkdirSync(path.join(root, "private-fixture"));
    fs.symlinkSync(
        path.join(root, "private-fixture"),
        path.join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() => captureInputs(root, ["escape/"]), /links/);
    fs.linkSync(path.join(root, "check.js"), path.join(root, "linked.js"));
    assert.throws(() => captureInputs(root, ["linked.js"]), /unlinked/);
    fs.writeFileSync(path.join(root, "large.js"), Buffer.alloc(VERIFY_LIMITS.bytes + 1));
    assert.throws(() => captureInputs(root, ["large.js"]), /8 MiB/);
    for (let index = 0; index < 256; index += 1) {
        fs.writeFileSync(path.join(root, "src", `f${index}.js`), "x");
    }

    assert.throws(() => captureInputs(root, ["src/"]), /256 files/);
    assert.throws(
        () => normalizeVerification({ command: "echo check", inputs: ["check.js"], cwd: path.dirname(root) }, root),
        /within the active workspace/,
    );
});

test("receipt registry refuses forged, stale, changed-during-run, failed and cross-workspace evidence", (t) => {
    const root = fixture(t);
    const other = fixture(t);
    const binding = normalizeVerification({ command: "echo check", inputs: ["src/", "config.json"] }, root);
    const before = captureInputs(root, binding.inputs);
    const registry = new VerificationRegistry();
    const outcome = { status: "exited", exitCode: 0, cleanup: "confirmed", reason: "command exited" };
    const receipt = registry.add(binding, before, before, outcome, {});
    assert.equal(registry.resolve(receipt.id, root).status, "passed");
    receipt.outcome.exitCode = 17;
    assert.equal(
        registry.resolve(receipt.id, root).outcome.exitCode,
        0,
        "returned objects cannot mutate stored evidence",
    );
    assert.equal(registry.resolve("invented", root).status, "unknown");
    assert.equal(registry.resolve(receipt.id, other).status, "unknown");
    fs.writeFileSync(path.join(root, "config.json"), "changed");
    assert.equal(registry.resolve(receipt.id, root).status, "stale");
    const after = captureInputs(root, binding.inputs);
    const changed = registry.add(binding, before, after, outcome, {});
    assert.equal(registry.resolve(changed.id, root).status, "stale");
    fs.unlinkSync(path.join(root, "config.json"));
    const unavailable = registry.resolve(changed.id, root);
    assert.equal(unavailable.status, "stale");
    assert.equal(unavailable.root, root);
    assert.equal(unavailable.specDigest, changed.specDigest);
    assert.deepEqual(unavailable.inputs, changed.inputs);
    assert.match(unavailable.reason, /unavailable/);
    fs.writeFileSync(path.join(root, "config.json"), "changed");
    for (const failure of [
        { exitCode: 1 },
        { status: "killed", reason: "timeout" },
        { cleanup: "unconfirmed" },
        { exitCode: null },
        { reason: "verification cancelled" },
    ]) {
        const failed = registry.add(binding, after, after, { ...outcome, ...failure }, {});
        assert.equal(registry.resolve(failed.id, root).status, "failed");
    }

    registry.invalidate();
    assert.equal(registry.resolve(receipt.id, root).status, "unknown");
    let first;
    for (let index = 0; index < 33; index += 1) {
        const current = registry.add(binding, after, after, outcome, {});
        first ??= current.id;
    }

    assert.equal(registry.receipts.size, 32);
    assert.equal(registry.resolve(first, root).status, "unknown");
});

test("receipt output stays bounded while raw stream digests cover discarded bytes", () => {
    const ring = new OutputRing();
    const bytes = Buffer.from("😀\u001b".repeat(100000));
    ring.append("stdout", bytes.subarray(0, 3));
    ring.append("stdout", bytes.subarray(3));
    ring.append("stderr", Buffer.from("error"));
    const output = verificationOutput(ring);
    assert.ok(Buffer.byteLength(output.text) <= VERIFY_LIMITS.output);
    assert.equal(output.truncated, true);
    assert.equal(output.text.includes("\u001b"), false);
    assert.equal(output.observedStreams.stdout.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(output.observedStreams.stdout.bytes, bytes.length);
    const controls = new OutputRing();
    controls.append("stdout", Buffer.alloc(5000, 1));
    assert.equal(verificationOutput(controls).truncated, true);
    assert.ok(Buffer.byteLength(verificationOutput(controls).text) <= VERIFY_LIMITS.output);
});

test("bounded output never begins inside a control-character escape", () => {
    // safeText expands one control byte to the six ASCII characters \u001b, so a
    // byte-offset cut can leave a "001b" fragment the command never produced.
    for (const filler of ["a", "😀"]) {
        for (let offset = 0; offset < 8; offset += 1) {
            const ring = new OutputRing();
            ring.append("stdout", Buffer.from(filler.repeat(offset) + "\u0007".repeat(9000)));
            const { text } = verificationOutput(ring);
            assert.ok(Buffer.byteLength(text) <= VERIFY_LIMITS.output);
            // Whole escapes only: nothing between them, and no leading fragment.
            assert.equal(text.replaceAll("\\u0007", "").replaceAll(filler, ""), "");
        }
    }
});

test("declared directories skip excluded entries instead of failing the whole capture", (t) => {
    const root = fixture(t);
    const inputs = ["src/", "config.json"];
    const before = captureInputs(root, inputs);
    assert.equal(before.skipped, 0);
    // A build or test run dropping any of these beside declared sources must not
    // make an already-recorded receipt unresolvable.
    fs.writeFileSync(path.join(root, "src", "cache.sqlite"), "binary");
    fs.writeFileSync(path.join(root, "src", "settings.local.json"), "{}");
    fs.mkdirSync(path.join(root, "src", "node_modules"));
    fs.writeFileSync(path.join(root, "src", "node_modules", "index.js"), "module");
    const after = captureInputs(root, inputs);
    assert.equal(after.digest, before.digest);
    assert.equal(after.skipped, 3);
    // An explicitly declared excluded path is still a hard error.
    assert.throws(() => captureInputs(root, ["src/cache.sqlite"]), /private, excluded or unsafe/u);
});

test("excluded names consume the scanned-entry budget", (t) => {
    const root = fixture(t);
    for (let index = 0; index < VERIFY_LIMITS.entries; index += 1) {
        fs.writeFileSync(path.join(root, "src", `cache-${index}.sqlite`), "synthetic cache");
    }

    assert.throws(() => captureInputs(root, ["src/"]), /inventory exceeds its bound/);
});

test("a configured Pi directory nested inside a declared source tree is never read", (t) => {
    const root = fixture(t);
    const privateRoot = path.join(root, "src", "custom-agent-state");
    fs.mkdirSync(privateRoot);
    const canaryPath = path.join(privateRoot, "ordinary-name.mjs");
    fs.writeFileSync(canaryPath, "synthetic private bytes");
    const canary = fs.statSync(canaryPath);
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = privateRoot;
    t.after(() => {
        if (original === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = original;
        }
    });
    const read = fs.readSync;
    let readCanary = false;
    t.mock.method(fs, "readSync", (descriptor, ...args) => {
        const stat = fs.fstatSync(descriptor);
        readCanary ||= stat.dev === canary.dev && stat.ino === canary.ino;

        return read(descriptor, ...args);
    });
    assert.throws(() => captureInputs(root, ["src/"]), /private state/);
    assert.equal(readCanary, false);
});

test("replacing a scanned ancestor cannot redirect a child read outside the workspace", (t) => {
    const root = fixture(t);
    const outside = fixture(t);
    const source = path.join(root, "src");
    fs.writeFileSync(path.join(outside, "main.js"), "synthetic private canary");
    const canary = fs.statSync(path.join(outside, "main.js"));
    const openDirectory = fs.opendirSync;
    const read = fs.readSync;
    let replaced = false;
    t.mock.method(fs, "readSync", (descriptor, ...args) => {
        const stat = fs.fstatSync(descriptor);
        assert.ok(stat.dev !== canary.dev || stat.ino !== canary.ino, "must reject before reading the canary");

        return read(descriptor, ...args);
    });
    t.mock.method(fs, "opendirSync", (...args) => {
        const handle = openDirectory(...args);
        if (path.resolve(args[0]) === source && !replaced) {
            replaced = true;
            // Both move targets are explicitly beneath this disposable fixture.
            fs.renameSync(source, path.join(root, "original-src"));
            fs.symlinkSync(outside, source, process.platform === "win32" ? "junction" : "dir");
        }

        return handle;
    });
    assert.throws(() => captureInputs(root, ["src/"]), /links|directory changed/);
    assert.equal(replaced, true);
});

test("non-canonical root spellings resolve to the same receipts as the canonical one", (t) => {
    const root = fixture(t);
    const spellings = [
        `${root}${path.sep}`,
        path.join(root, "src", ".."),
        ...(process.platform === "win32" ? [root[0].toLowerCase() + root.slice(1)] : []),
    ];
    const registry = new VerificationRegistry();
    const binding = normalizeVerification({ command: "echo check", inputs: ["src/", "config.json"] }, root);
    const before = captureInputs(root, binding.inputs);
    const receipt = registry.add(binding, before, before, {
        status: "exited",
        exitCode: 0,
        cleanup: "confirmed",
        reason: "command exited",
    });
    for (const spelling of spellings) {
        assert.equal(normalizeVerification({ command: "echo check", inputs: ["src/"] }, spelling).root, root);
        assert.equal(registry.resolve(receipt.id, spelling).status, "passed");
        // list() filtered on the caller's spelling, so a trailing separator used to
        // hide every receipt and leave required checks permanently unresolvable.
        assert.deepEqual(
            registry.list(spelling).map((entry) => entry.id),
            [receipt.id],
        );
    }
});

test("human check selection is digest-bound and challenge readiness uses live registry evidence", (t) => {
    const root = fixture(t);
    const task = createTaskContract(
        {
            objective: "Preserve the result",
            requirements: [{ id: "R1", description: "Return the correct value", acceptance: "Check output" }],
        },
        { root, origin: "human" },
    );
    const binding = normalizeVerification({ command: "echo check", inputs: ["src/", "config.json"] }, root);
    const before = captureInputs(root, binding.inputs);
    const registry = new VerificationRegistry();
    const receipt = registry.add(
        binding,
        before,
        before,
        { status: "exited", exitCode: 0, reason: "command exited", cleanup: "confirmed" },
        {},
    );
    const tool = { name: "verify_run", sourceInfo: { path: path.resolve("extensions/background-tasks/index.ts") } };
    let duplicate = false;
    const pi = {
        getAllTools: () => [tool],
        events: {
            emit(_name, request) {
                request.reply(registry.list(request.root));
                if (duplicate) {
                    request.reply(registry.list(request.root));
                }
            },
        },
    };
    const selected = selectRequiredChecks(
        [{ id: "C1", label: "Project check", receiptId: receipt.id, requirementIds: ["R1"] }],
        task,
        currentReceipts(pi, root),
    );
    const bound = createTaskContract({ ...task, requiredChecks: selected }, { root, origin: "human", id: task.id });
    assert.notEqual(bound.digest, task.digest);
    assert.throws(() => validateTaskContract({ ...bound, requiredChecks: [] }), /digest mismatch/);
    assert.throws(
        () =>
            createTaskContract(
                { ...bound, requirements: [{ id: "R2", description: "New", acceptance: "Different" }] },
                { root, origin: "human" },
            ),
        /original requirement/,
    );
    assert.throws(
        () =>
            selectRequiredChecks(
                [{ id: "C1", label: "Check", receiptId: "invented", requirementIds: ["R1"] }],
                task,
                currentReceipts(pi, root),
            ),
        /current session/,
    );
    const submission = {
        verdict: "ready-for-human-review",
        requirements: [{ id: "R1", status: "proven", evidence: "Observed receipt" }],
        contradictions: [],
        falsePositiveChecks: [],
        scopeFindings: [],
        validationGaps: [],
        residualRisks: [],
        nextAction: "",
    };
    const facts = () => ({
        taskContract: bound,
        requiredCheckEvidence: requiredCheckEvidence(bound, currentReceipts(pi, root)),
    });
    assert.equal(validateChallengeSubmission(submission, facts()).verdict, "ready-for-human-review");
    const laterFailure = registry.add(
        binding,
        before,
        before,
        { status: "exited", exitCode: 1, reason: "command exited", cleanup: "confirmed" },
        {},
    );
    assert.equal(facts().requiredCheckEvidence[0].receiptId, laterFailure.id);
    assert.throws(() => validateChallengeSubmission(submission, facts()), /current passing receipt/);
    registry.add(
        binding,
        before,
        before,
        { status: "exited", exitCode: 0, reason: "command exited", cleanup: "confirmed" },
        {},
    );
    tool.sourceInfo.path = path.resolve("replacement/index.ts");
    assert.throws(() => validateChallengeSubmission(submission, facts()), /current passing receipt/);
    tool.sourceInfo.path = path.resolve("extensions/background-tasks/index.ts");
    duplicate = true;
    assert.deepEqual(currentReceipts(pi, root), []);
    duplicate = false;
    fs.appendFileSync(path.join(root, "config.json"), "changed");
    assert.throws(() => validateChallengeSubmission(submission, facts()), /current passing receipt/);
    registry.invalidate();
    assert.equal(facts().requiredCheckEvidence[0].status, "unknown");
    assert.throws(() => validateChallengeSubmission(submission, { taskContract: bound }), /current passing receipt/);
});

test("legacy schema-one task digests remain readable without fabricated required checks", (t) => {
    const root = fixture(t);
    const task = createTaskContract(
        { objective: "Legacy", requirements: [{ description: "Preserve", acceptance: "Check" }] },
        { root, origin: "human" },
    );
    const { digest: _digest, requiredChecks: _checks, ...legacy } = task;
    legacy.schema = 1;
    const digest = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
    const validated = validateTaskContract({ ...legacy, digest });
    assert.equal(validated.schema, 1);
    assert.equal(validated.requiredChecks, undefined);
    assert.throws(() => validateTaskContract({ ...legacy, digest, requiredChecks: [] }), /Legacy/);
});

test("finite checks observe real exit, nonzero, timeout and cancellation using the owned runner", async (t) => {
    const root = fixture(t);
    const runner = new TaskRunner({ terminate: (task) => terminateOwned(task, { graceMs: 30, observeMs: 10000 }) });
    t.after(() => runner.shutdown());
    for (const code of [0, 7]) {
        const binding = normalizeVerification(
            {
                command: `"${process.execPath}" -e "console.log('done');process.exitCode=${code}"`,
                inputs: ["check.js"],
            },
            root,
        );
        const started = await runner.start(binding.spec, 1);
        const result = await runner.wait(started.id);
        assert.equal(result.status, "exited");
        assert.equal(result.exitCode, code);
        assert.equal(result.cleanup, "confirmed");
    }

    const binding = normalizeVerification(
        { command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`, inputs: ["check.js"], timeoutSeconds: 1 },
        root,
    );
    const timed = await runner.start(binding.spec, 1);
    assert.equal((await runner.wait(timed.id)).reason, "timeout");
    const started = await runner.start({ ...binding.spec, timeoutSeconds: 60 }, 1);
    const controller = new AbortController();
    const waiting = runner.wait(started.id, controller.signal);
    controller.abort();
    const cancelled = await waiting;
    assert.equal(cancelled.reason, "verification cancelled");
    assert.equal(cancelled.cleanup, "confirmed");
});

test("late cancellation keeps an evicted completed task's observed outcome", async () => {
    const runner = new TaskRunner();
    const task = {
        id: "evicted-completion",
        spec: { label: "check", command: "check" },
        startedAt: Date.now(),
        cleanup: "pending",
        status: "running",
    };
    runner.tasks.set(task.id, task);
    const controller = new AbortController();
    const waiting = runner.wait(task.id, controller.signal);
    Object.assign(task, { cleanup: "confirmed", status: "exited", exitCode: 0, reason: "command exited" });
    runner.tasks.delete(task.id);
    controller.abort();
    const result = await waiting;
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanup, "confirmed");
});
