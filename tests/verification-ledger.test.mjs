import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
    GATE_CONFIG_RELATIVE,
    MAX_GATES,
    VERIFICATION_LEDGER_ENTRY,
    captureVerificationSnapshot,
    createLedgerRecord,
    describeResolution,
    findGate,
    gateCommandLine,
    normalizeCitedGates,
    normalizeGateConfig,
    readGateConfig,
    resolveGate,
    resolveLedger,
    resolveRequirement,
    restoreLedger,
    snapshotDigest,
    validateLedgerRecord,
} from "../extensions/workflow-controls/ledger.mjs";
import { validateChallengeSubmission } from "../extensions/workflow-controls/challenge.mjs";

function git(root, ...args) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    return result.stdout;
}

function exec(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: options.timeout ?? 30_000,
        maxBuffer: 40 * 1024 * 1024,
    });

    return Promise.resolve({
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    });
}

function createRepository() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-ledger-test-")));
    git(root, "init");
    git(root, "config", "user.email", "ledger@example.invalid");
    git(root, "config", "user.name", "Ledger Test");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.txt"), "a\n");
    fs.writeFileSync(path.join(root, "src", "b.txt"), "b\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");

    return root;
}

function writeGateConfig(root, value) {
    const file = path.join(root, GATE_CONFIG_RELATIVE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));

    return file;
}

const validConfig = {
    schema: 1,
    gates: {
        check: { command: "node", args: ["--version"] },
        unit: { command: "node", args: ["-e", "process.exit(0)"], timeoutMs: 60_000, label: "Unit tests" },
    },
};

test("a project without a gate configuration leaves verification inactive", () => {
    const root = createRepository();
    const config = readGateConfig(root);
    assert.equal(config.active, false);
    assert.deepEqual(config.gates, []);
});

test("a valid gate configuration normalizes into sorted, bounded gates", () => {
    const root = createRepository();
    writeGateConfig(root, validConfig);
    const config = readGateConfig(root);
    assert.equal(config.active, true);
    assert.deepEqual(
        config.gates.map((gate) => gate.id),
        ["check", "unit"],
    );
    assert.equal(config.gates[0].cwd, ".");
    assert.equal(config.gates[1].timeoutMs, 60_000);
    assert.equal(gateCommandLine(config.gates[0]), "node --version");
    assert.equal(findGate(config, "unit").label, "Unit tests");
    assert.equal(findGate(config, "absent"), undefined);
});

test("gate configuration rejects malformed declarations", () => {
    const root = createRepository();
    const cases = [
        [{ schema: 2, gates: { a: { command: "node" } } }, /schema/iu],
        [{ schema: 1 }, /gates object/iu],
        [{ schema: 1, gates: {} }, /1-16 gates/u],
        [{ schema: 1, gates: { "Bad-ID": { command: "node" } } }, /Gate ID must match/u],
        [{ schema: 1, gates: { a: { command: "" } } }, /command/u],
        [{ schema: 1, gates: { a: { command: "node\u0000" } } }, /command/u],
        [{ schema: 1, gates: { a: { command: "node", timeoutMs: 10 } } }, /timeoutMs/u],
        [{ schema: 1, gates: { a: { command: "node", cwd: "../escape" } } }, /not inside the project root/u],
        [{ schema: 1, gates: { a: { command: "node", cwd: "/abs" } } }, /project-relative/u],
        [{ schema: 1, gates: { a: { command: "node", shell: true } } }, /unsupported field/u],
        [{ schema: 1, gates: { a: { command: "node", args: "npm run check" } } }, /arguments/u],
    ];
    for (const [value, pattern] of cases) {
        writeGateConfig(root, value);
        assert.throws(() => readGateConfig(root), pattern, JSON.stringify(value));
    }
});

test("gate configuration rejects more gates than the cap", () => {
    const root = createRepository();
    const gates = {};
    for (let index = 0; index <= MAX_GATES; index += 1) {
        gates[`gate-${index}`] = { command: "node", args: ["--version"] };
    }

    writeGateConfig(root, { schema: 1, gates });
    assert.throws(() => readGateConfig(root), /1-16 gates/u);
});

test("gate configuration rejects unparseable and oversized files", () => {
    const root = createRepository();
    writeGateConfig(root, "{ not json");
    assert.throws(() => readGateConfig(root), /could not be read as JSON/u);

    writeGateConfig(root, { schema: 1, gates: { a: { command: "node", label: "x".repeat(200) } } });
    assert.throws(() => readGateConfig(root), /label/u);

    const file = writeGateConfig(root, validConfig);
    fs.writeFileSync(file, `${JSON.stringify(validConfig)}${" ".repeat(17 * 1024)}`);
    assert.throws(() => readGateConfig(root), /bounded regular file/u);
});

test("a gate cwd cannot reach outside the root through a link", { skip: process.platform === "win32" }, () => {
    const root = createRepository();
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-ledger-outside-")));
    fs.symlinkSync(outside, path.join(root, "escape-link"));
    assert.throws(
        () => normalizeGateConfig({ schema: 1, gates: { a: { command: "node", cwd: "escape-link" } } }, root),
        /not inside the project root/u,
    );

    // An ordinary subdirectory still resolves, so the link check is not simply rejecting everything.
    assert.equal(
        normalizeGateConfig({ schema: 1, gates: { a: { command: "node", cwd: "src" } } }, root).gates[0].cwd,
        "src",
    );
});

test("gate configuration refuses a symlinked file", { skip: process.platform === "win32" }, () => {
    const root = createRepository();
    const target = path.join(root, "elsewhere.json");
    fs.writeFileSync(target, JSON.stringify(validConfig));
    const file = path.join(root, GATE_CONFIG_RELATIVE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
    assert.throws(() => readGateConfig(root), /must not be a link/u);
});

test("a windows override replaces the command and its arguments together", () => {
    const root = createRepository();
    const config = normalizeGateConfig(
        {
            schema: 1,
            gates: {
                check: {
                    command: "npm",
                    args: ["run", "check"],
                    windows: { command: "cmd.exe", args: ["/c", "npm", "run", "check"] },
                },
            },
        },
        root,
    );
    const gate = config.gates[0];
    if (process.platform === "win32") {
        assert.equal(gateCommandLine(gate), "cmd.exe /c npm run check");
    } else {
        assert.equal(gateCommandLine(gate), "npm run check");
    }

    // Fields outside the override still come from the gate itself on every platform.
    assert.equal(gate.timeoutMs, 300_000);
    assert.equal(gate.cwd, ".");
});

test("a batch script is refused when it is declared, not when it is run", () => {
    const root = createRepository();
    // Node cannot spawn a .cmd or .bat without a shell, so such a gate could never produce a result.
    for (const command of ["npm.cmd", "build.BAT"]) {
        assert.throws(
            () => normalizeGateConfig({ schema: 1, gates: { check: { command } } }, root),
            /cannot run without a shell/u,
            command,
        );
    }

    assert.throws(
        () =>
            normalizeGateConfig(
                { schema: 1, gates: { check: { command: "npm", windows: { command: "npm.cmd" } } } },
                root,
            ),
        process.platform === "win32" ? /cannot run without a shell/u : /.*/u,
    );
});

test("a windows override rejects fields it does not support", { skip: process.platform !== "win32" }, () => {
    const root = createRepository();
    assert.throws(
        () =>
            normalizeGateConfig(
                { schema: 1, gates: { check: { command: "npm", windows: { command: "cmd.exe", cwd: "elsewhere" } } } },
                root,
            ),
        /windows override supports only command and args/u,
    );
});

test("snapshot digests distinguish worktree states", async () => {
    const root = createRepository();
    fs.writeFileSync(path.join(root, "src", "a.txt"), "changed\n");
    const first = await captureVerificationSnapshot(root, exec);
    const repeat = await captureVerificationSnapshot(root, exec);
    assert.equal(snapshotDigest(first), snapshotDigest(repeat));

    fs.writeFileSync(path.join(root, "src", "b.txt"), "changed too\n");
    const second = await captureVerificationSnapshot(root, exec);
    assert.notEqual(snapshotDigest(first), snapshotDigest(second));
    assert.equal(snapshotDigest({ indeterminate: true }), undefined);
});

test("a gate recorded against the current worktree resolves as proven", async () => {
    const root = createRepository();
    fs.writeFileSync(path.join(root, "src", "a.txt"), "edited\n");
    const snapshot = await captureVerificationSnapshot(root, exec);
    const record = createLedgerRecord({
        gate: { id: "check", command: "node", args: ["--version"], cwd: "." },
        exitCode: 0,
        snapshot,
        durationMs: 12,
    });
    const resolution = resolveGate(record, snapshot);
    assert.equal(resolution.state, "proven");
    assert.equal(resolution.exitCode, 0);
    assert.deepEqual(resolution.changedSince, []);
    assert.match(describeResolution(resolution), /verified/u);
});

test("an edit after a passing gate makes it stale and names what changed", async () => {
    const root = createRepository();
    fs.writeFileSync(path.join(root, "src", "a.txt"), "edited\n");
    const before = await captureVerificationSnapshot(root, exec);
    const record = createLedgerRecord({
        gate: { id: "check", command: "node", args: ["--version"], cwd: "." },
        exitCode: 0,
        snapshot: before,
        durationMs: 8,
    });

    fs.writeFileSync(path.join(root, "src", "b.txt"), "late edit\n");
    const after = await captureVerificationSnapshot(root, exec);
    const resolution = resolveGate(record, after);
    assert.equal(resolution.state, "stale");
    assert.deepEqual(resolution.changedSince, ["src/b.txt"]);
    assert.match(describeResolution(resolution), /stale.*src\/b\.txt/u);
});

test("a nonzero exit is recorded as failed regardless of the worktree", async () => {
    const root = createRepository();
    const snapshot = await captureVerificationSnapshot(root, exec);
    const record = createLedgerRecord({
        gate: { id: "check", command: "node", args: ["--version"], cwd: "." },
        exitCode: 1,
        snapshot,
        durationMs: 3,
    });
    assert.equal(resolveGate(record, snapshot).state, "failed");
});

test("an indeterminate snapshot can never prove a requirement", () => {
    const indeterminate = { root: "/x", paths: [], fingerprints: {}, indeterminate: true };
    const record = createLedgerRecord({
        gate: { id: "check", command: "node", args: [], cwd: "." },
        exitCode: 0,
        snapshot: indeterminate,
        durationMs: 1,
    });
    assert.equal(record.digest, undefined);
    assert.equal(resolveGate(record, indeterminate).state, "indeterminate");
    assert.equal(resolveGate(undefined, indeterminate).state, "unavailable");
});

test("ledger records reject exit codes the harness did not observe", () => {
    const gate = { id: "check", command: "node", args: [], cwd: "." };
    const snapshot = { root: "/x", paths: [], fingerprints: {}, indeterminate: false };
    for (const exitCode of [undefined, -1, 256, "0", 1.5]) {
        assert.throws(() => createLedgerRecord({ gate, exitCode, snapshot }), /exit code/u);
    }
});

test("restoring a ledger keeps the latest record per gate and honours clears", () => {
    const root = "/repo";
    const record = (gate, exitCode, digest) => ({
        schema: 1,
        gate,
        command: "node --version",
        cwd: ".",
        exitCode,
        root,
        digest,
        paths: [],
        fingerprints: {},
        indeterminate: false,
        startedAt: "2026-09-10T00:00:00.000Z",
        durationMs: 1,
    });
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const entries = [
        {
            type: "custom",
            customType: VERIFICATION_LEDGER_ENTRY,
            data: { kind: "recorded", record: record("check", 1, digestA) },
        },
        {
            type: "custom",
            customType: VERIFICATION_LEDGER_ENTRY,
            data: { kind: "recorded", record: record("check", 0, digestB) },
        },
        {
            type: "custom",
            customType: VERIFICATION_LEDGER_ENTRY,
            data: { kind: "recorded", record: record("unit", 0, digestA) },
        },
    ];
    const restored = restoreLedger(entries, root);
    assert.equal(restored.size, 2);
    assert.equal(restored.get("check").exitCode, 0);
    assert.equal(restored.get("check").digest, digestB);

    const cleared = restoreLedger(
        [...entries, { type: "custom", customType: VERIFICATION_LEDGER_ENTRY, data: { kind: "cleared" } }],
        root,
    );
    assert.equal(cleared.size, 0);

    assert.equal(restoreLedger(entries, "/other-root").size, 0);
    assert.equal(validateLedgerRecord(record("check", 0, "short"), root), undefined);
    assert.equal(validateLedgerRecord({ ...record("check", 0, digestA), schema: 99 }, root), undefined);
});

test("a requirement inherits the worst state among the gates it cites", () => {
    const verification = {
        active: true,
        gates: {
            check: { state: "proven", exitCode: 0, changedSince: [] },
            unit: { state: "stale", exitCode: 0, changedSince: ["src/b.txt"] },
            lint: { state: "failed", exitCode: 1, changedSince: [] },
        },
    };
    assert.equal(resolveRequirement(["check"], verification).state, "proven");
    assert.equal(resolveRequirement(["check", "unit"], verification).state, "stale");
    assert.equal(resolveRequirement(["check", "unit", "lint"], verification).state, "failed");
    assert.equal(resolveRequirement(["absent"], verification).state, "unavailable");
    assert.equal(resolveRequirement([], verification).state, "uncited");
    assert.equal(resolveRequirement(["check"], { active: false, gates: {} }), undefined);
});

test("a hostile changed path cannot open a code span in the rendered challenge", () => {
    const described = describeResolution({
        state: "stale",
        gate: "check",
        changedSince: ["src/`rm -rf`/evil.ts", "src/new\nline.ts"],
    });
    assert.ok(!described.includes("`"), described);
    assert.ok(!described.includes("\n"), described);
    assert.match(described, /%60/u);
});

test("cited gate lists are bounded and well formed", () => {
    assert.deepEqual(normalizeCitedGates(undefined), []);
    assert.deepEqual(normalizeCitedGates(["check", "check"]), ["check"]);
    assert.throws(() => normalizeCitedGates("check"), /at most/u);
    assert.throws(() => normalizeCitedGates(["Bad"]), /declared gate identifiers/u);
    assert.throws(() => normalizeCitedGates(new Array(9).fill("check")), /at most 8 gates/u);
});

test("resolveLedger reports every declared gate, run or not", () => {
    const config = { active: true, gates: [{ id: "check" }, { id: "unit" }] };
    const records = new Map([
        ["check", { gate: "check", exitCode: 0, indeterminate: true, paths: [], fingerprints: {} }],
    ]);
    const resolved = resolveLedger(config, records, { indeterminate: true });
    assert.deepEqual(Object.keys(resolved.gates), ["check", "unit"]);
    assert.equal(resolved.gates.unit.state, "unavailable");
    assert.equal(resolveLedger({ active: false }, records, undefined).active, false);
});

const baseSubmission = {
    generation: "g".repeat(36),
    verdict: "incomplete",
    contradictions: [],
    falsePositiveChecks: [],
    scopeFindings: [],
    validationGaps: [],
    residualRisks: [],
    nextAction: "Keep going",
};

const provenGates = {
    active: true,
    gates: { check: { state: "proven", exitCode: 0, changedSince: [] } },
};

test("an inactive ledger leaves completion challenges exactly as they were", () => {
    const result = validateChallengeSubmission({
        ...baseSubmission,
        requirements: [{ requirement: "Works", status: "proven", evidence: "Ran the tests" }],
    });
    assert.equal(result.requirements[0].status, "proven");
    assert.equal(result.requirements[0].verified, undefined);
    assert.equal(result.verification, undefined);
});

test("gates cannot be cited while verification is inactive", () => {
    assert.throws(
        () =>
            validateChallengeSubmission({
                ...baseSubmission,
                requirements: [{ requirement: "Works", status: "proven", evidence: "x", gates: ["check"] }],
            }),
        /verification is inactive/u,
    );
});

test("a proven claim backed by a current passing gate is accepted", () => {
    const result = validateChallengeSubmission(
        {
            ...baseSubmission,
            requirements: [{ requirement: "Works", status: "proven", evidence: "check passed", gates: ["check"] }],
        },
        { verification: provenGates },
    );
    assert.equal(result.requirements[0].verified.state, "proven");
    assert.deepEqual(result.requirements[0].gates, ["check"]);
    assert.equal(result.verification.active, true);
});

test("a proven claim is rejected when the ledger says the gate is stale", () => {
    assert.throws(
        () =>
            validateChallengeSubmission(
                {
                    ...baseSubmission,
                    requirements: [
                        { requirement: "Works", status: "proven", evidence: "check passed", gates: ["check"] },
                    ],
                },
                {
                    verification: {
                        active: true,
                        gates: { check: { state: "stale", exitCode: 0, changedSince: ["src/b.txt"] } },
                    },
                },
            ),
        /claims proof the ledger does not support: stale.*src\/b\.txt/u,
    );
});

test("a proven claim is rejected when it cites no gate at all", () => {
    assert.throws(
        () =>
            validateChallengeSubmission(
                {
                    ...baseSubmission,
                    requirements: [{ requirement: "Works", status: "proven", evidence: "I checked" }],
                },
                { verification: provenGates },
            ),
        /no gate cited/u,
    );
});

test("a proven claim is rejected when the cited gate never ran or failed", () => {
    for (const [state, exitCode, pattern] of [
        ["unavailable", undefined, /never run/u],
        ["failed", 1, /failed/u],
    ]) {
        assert.throws(
            () =>
                validateChallengeSubmission(
                    {
                        ...baseSubmission,
                        requirements: [{ requirement: "Works", status: "proven", evidence: "x", gates: ["check"] }],
                    },
                    { verification: { active: true, gates: { check: { state, exitCode, changedSince: [] } } } },
                ),
            pattern,
        );
    }
});

test("an undeclared gate cannot be cited", () => {
    assert.throws(
        () =>
            validateChallengeSubmission(
                {
                    ...baseSubmission,
                    requirements: [{ requirement: "Works", status: "unproven", evidence: "", gates: ["invented"] }],
                },
                { verification: provenGates },
            ),
        /not declared for this project/u,
    );
});

test("unproven and partial requirements may cite nothing", () => {
    const result = validateChallengeSubmission(
        {
            ...baseSubmission,
            requirements: [{ requirement: "Works", status: "unproven", evidence: "" }],
        },
        { verification: provenGates },
    );
    assert.equal(result.requirements[0].verified.state, "uncited");
});

test("a ready verdict requires every requirement to be backed by a current passing gate", () => {
    const ready = {
        ...baseSubmission,
        verdict: "ready-for-human-review",
        nextAction: "",
        requirements: [
            { requirement: "One", status: "proven", evidence: "check", gates: ["check"] },
            { requirement: "Two", status: "proven", evidence: "unit", gates: ["unit"] },
        ],
    };
    const verification = {
        active: true,
        gates: {
            check: { state: "proven", exitCode: 0, changedSince: [] },
            unit: { state: "proven", exitCode: 0, changedSince: [] },
        },
    };
    const accepted = validateChallengeSubmission(ready, { verification });
    assert.equal(accepted.verdict, "ready-for-human-review");
    assert.equal(accepted.verification.gates.unit.state, "proven");

    // A ready verdict needs every requirement proven, and a proven requirement needs a current passing gate, so an
    // unusable gate is refused by the per-requirement rule before the verdict itself is ever considered.
    assert.throws(
        () =>
            validateChallengeSubmission(ready, {
                verification: {
                    active: true,
                    gates: {
                        check: { state: "proven", exitCode: 0, changedSince: [] },
                        unit: { state: "indeterminate", exitCode: 0, changedSince: [] },
                    },
                },
            }),
        /Requirement Two claims proof the ledger does not support: indeterminate/u,
    );
});

test("the ready verdict keeps its own gate-backing invariant independent of the per-requirement rule", () => {
    // Exercised directly because the per-requirement rule normally refuses a false claim first. This guard is what
    // stops a future change there from quietly letting an unbacked requirement through to a ready verdict.
    assert.throws(
        () =>
            validateChallengeSubmission(
                {
                    ...baseSubmission,
                    verdict: "ready-for-human-review",
                    nextAction: "",
                    requirements: [{ requirement: "One", status: "proven", evidence: "check", gates: ["check"] }],
                },
                {
                    verification: {
                        active: true,
                        gates: { check: { state: "stale", exitCode: 0, changedSince: ["src/a.txt"] } },
                    },
                },
            ),
        /ledger does not support|not backed by a current passing gate/u,
    );
});

test("an end-to-end run records proof and loses it to a later edit", async () => {
    const root = createRepository();
    writeGateConfig(root, validConfig);
    const config = readGateConfig(root);
    const gate = findGate(config, "check");

    const result = await exec(gate.command, gate.args, { cwd: root });
    const snapshot = await captureVerificationSnapshot(root, exec);
    const record = createLedgerRecord({ gate, exitCode: result.code, snapshot, durationMs: 5 });
    const records = new Map([[gate.id, record]]);

    const proven = resolveLedger(config, records, await captureVerificationSnapshot(root, exec));
    assert.equal(proven.gates.check.state, "proven");
    const accepted = validateChallengeSubmission(
        {
            ...baseSubmission,
            verdict: "ready-for-human-review",
            nextAction: "",
            requirements: [{ requirement: "Node runs", status: "proven", evidence: "check exit 0", gates: ["check"] }],
        },
        { verification: proven },
    );
    assert.equal(accepted.verdict, "ready-for-human-review");

    fs.writeFileSync(path.join(root, "src", "a.txt"), "edited after the gate\n");
    const stale = resolveLedger(config, records, await captureVerificationSnapshot(root, exec));
    assert.equal(stale.gates.check.state, "stale");
    assert.deepEqual(stale.gates.check.changedSince, ["src/a.txt"]);
    assert.throws(
        () =>
            validateChallengeSubmission(
                {
                    ...baseSubmission,
                    verdict: "ready-for-human-review",
                    nextAction: "",
                    requirements: [
                        { requirement: "Node runs", status: "proven", evidence: "check exit 0", gates: ["check"] },
                    ],
                },
                { verification: stale },
            ),
        /claims proof the ledger does not support/u,
    );
});
