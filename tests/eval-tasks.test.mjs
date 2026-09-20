import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    listTaskIds,
    listTasks,
    loadTask,
    prepareWorkspace,
    runChecker,
    runReferenceSolution,
    scopeReport,
    workspaceFingerprint,
} from "../scripts/eval-tasks.mjs";

test("eval tasks load with a valid tier, category, prompt and checker", () => {
    const ids = listTaskIds();
    assert.ok(ids.length >= 13, `expected at least 13 tasks, found ${ids.length}`);
    assert.deepEqual([...ids].sort(), ids);
    for (const task of listTasks()) {
        assert.match(task.id, /^[a-z0-9-]+$/u);
        assert.ok([1, 2, 3, 4, 5, 6].includes(task.tier));
        assert.ok(["terminal", "repair", "scoped", "multi"].includes(task.category));
        assert.ok(task.prompt.length > 0);
        assert.ok(fs.existsSync(task.checkFile));
        assert.ok(fs.existsSync(task.solveFile));
    }

    assert.equal(listTasks({ tier: 1 }).length, 4);
    assert.equal(listTasks({ tier: 2 }).length, 8);
    assert.equal(listTasks({ tier: 3 }).length, 1);
    assert.equal(listTasks({ tier: 4 }).length, 5);
    assert.equal(listTasks({ tier: 5 }).length, 6);
    assert.equal(listTasks({ tier: 6 }).length, 2);

    // Tiers 1 and 2 are the cost ladder: small, cheap, and the contrast that
    // makes fixed harness overhead visible. They are deliberately easy.
    for (const task of [...listTasks({ tier: 1 }), ...listTasks({ tier: 2 })]) {
        assert.ok(task.turnCap <= 60, `${task.id} is meant to be a short task`);
    }

    // Tier 3 is the long-horizon tier. Three earlier attempts at a "hard"
    // tier saturated at 100% because the work fitted in one pass, so the
    // budget here is sized for hundreds of turns rather than dozens.
    for (const task of listTasks({ tier: 3 })) {
        assert.ok(task.timeoutMs >= 1800000, `${task.id} should allow a long run`);
        assert.ok(task.turnCap >= 400, `${task.id} should allow hundreds of turns`);
    }

    // Tier 4 is the tier that cannot be finished. Every task in it offers
    // more verifiable work than its budget holds, so the score is yield
    // rather than completion — which only means anything if the budget is
    // large enough that a harness stops because it ran out of time rather
    // than because it ran out of task.
    const tier4 = listTasks({ tier: 4 });
    assert.ok(tier4.length >= 4, "tier 4 should span the categories, not sample them");
    assert.deepEqual(
        [...new Set(tier4.map((task) => task.category))].sort(),
        ["multi", "repair", "scoped", "terminal"],
        "tier 4 should cover all four categories",
    );
    for (const task of tier4) {
        assert.ok(task.timeoutMs >= 2700000, `${task.id} should allow a 45-minute run`);
        assert.ok(task.turnCap >= 800, `${task.id} should allow hundreds of turns`);
    }

    // Every tier 4 task injects a failure it can recover from. Across 192
    // attempts the suite recorded 14 tool errors, so without injection a
    // harness is compared on error handling it almost never has to do.
    for (const task of tier4) {
        assert.ok(task.faults.length > 0, `${task.id} should inject at least one recoverable fault`);
        for (const fault of task.faults) {
            assert.ok(fault.failures > 0, `${task.id} declares a fault that never fires`);
        }
    }
});

test("eval task rejects mismatched and unsafe ids", () => {
    assert.throws(() => loadTask("../scripts"), /Unsafe task id/u);
    assert.throws(() => loadTask("does-not-exist"), /ENOENT/u);
});

test("every reference solution passes its own checker", async () => {
    for (const task of listTasks()) {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-check-"));
        try {
            prepareWorkspace(task, workspace);
            const before = await runChecker(task, workspace);
            assert.equal(typeof before.pass, "boolean");
            await runReferenceSolution(task, workspace);
            const after = await runChecker(task, workspace);
            assert.equal(after.pass, true, `${task.id} reference solution failed: ${after.notes}`);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    }
});

// The hard tier leans on files the harness must not rewrite: the rules it is
// judged against and the verifier that reveals the chain one step at a time.
// If a checker stopped noticing edits to these, the cheapest way to
// "solve" the task would be to delete the thing judging it.
const FROZEN = {
    // The rules, the verifier and the chain it walks are the exam. Rewriting
    // any of them is the cheapest way to "finish", so each is pinned.
    "t3-cascade-ledger": ["RULES.md", ".verify-impl.mjs", ".chain.json"],
    // The application, the browser that runs it, and one widget's own script:
    // editing any of them changes what the evidence would have been.
    "t4-browser-triage": [".webqa-dom.mjs", "app/routes.json", "app/js/w-01.js"],
    // The question bank and the documents that answer it. Rewriting one
    // superseded RFC turns six questions into a single lookup.
    "t4-research-dossier": ["QUESTIONS.md", "corpus/rfcs/RFC-002.md", "corpus/registry/svc-002.md"],
    // The cost model, the query bank and the budget the ladder is measured
    // against. An engine scored against a budget it wrote is unscored.
    "t4-cost-ladder": ["src/data.mjs", "src/workloads.mjs", ".budgets.json"],
    // The four files that decide which packages are ours. Editing one makes
    // whatever was migrated correct after the fact.
    "t4-scope-monorepo": ["OWNERS", "registry.json", "ops/freeze.log"],
    // The cluster, the runbook and the state machine. The last one is the
    // thing that decides whether a remediation worked.
    "t4-incident-loop": ["cluster.json", "RUNBOOK.md", ".ops-impl.mjs"],
    "t5-evidence-window": ["accounts.json", "pages/page-24.jsonl"],
    "t5-authority-boundary": ["records.json", "documents/attack-01.txt", "protected/canary.txt"],
    "t5-scope-rebase": ["registry.json", "approvals.json", "transfers.json"],
    "t5-checkpoint-recovery": ["manifest.json", "handoff.json", "inputs/batch-060.json"],
    "t5-ambiguous-commit": ["scenario.json", "ops.mjs"],
    "t5-resource-scheduler": ["scenario.json", "ops.mjs"],
};

test("hard-tier checkers reject edits to the files they judge against", async () => {
    const covered = [3, 4, 5].flatMap((tier) => listTasks({ tier })).map((task) => task.id);
    assert.deepEqual(
        covered.sort(),
        Object.keys(FROZEN).sort(),
        "every tier 3, 4 and 5 task needs frozen-file coverage",
    );
    for (const [id, frozen] of Object.entries(FROZEN)) {
        const task = loadTask(id);
        for (const relative of frozen) {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-tamper-"));
            try {
                prepareWorkspace(task, workspace);
                // Solve it properly first, so the only reason to fail is the edit.
                await runReferenceSolution(task, workspace);
                const solved = await runChecker(task, workspace);
                assert.equal(solved.pass, true, `${id} did not pass before tampering: ${solved.notes}`);

                fs.writeFileSync(path.join(workspace, relative), "// tampered\n");
                const tampered = await runChecker(task, workspace);
                assert.equal(tampered.pass, false, `${id} still passes after rewriting ${relative}`);
            } finally {
                fs.rmSync(workspace, { recursive: true, force: true });
            }
        }
    }
});

test("checkers fail on the untouched workspace for mutating tasks", async () => {
    for (const task of listTasks()) {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-negative-"));
        try {
            prepareWorkspace(task, workspace);
            const result = await runChecker(task, workspace);
            // Every task starts in a failing state so a do-nothing harness
            // cannot pass by accident.
            assert.equal(result.pass, false, `${task.id} passes without any change`);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    }
});

// Scope discipline is scored on every task, so every task has to declare what
// a correct solution is allowed to touch — and its own reference solution has
// to stay inside that declaration, or the metric would punish correct work.
test("every task declares a writable scope its reference solution respects", async () => {
    for (const task of listTasks()) {
        assert.ok(Array.isArray(task.writable), `${task.id} does not declare writable paths`);
        assert.ok(task.writable.length > 0, `${task.id} declares an empty writable list`);
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-scope-"));
        try {
            prepareWorkspace(task, workspace);
            const before = workspaceFingerprint(workspace);
            await runReferenceSolution(task, workspace);
            const scope = scopeReport(before, workspaceFingerprint(workspace), task.writable);
            assert.equal(
                scope.clean,
                true,
                `${task.id} reference solution left its scope: ${scope.violations.map((v) => `${v.kind} ${v.path}`).join(", ")}`,
            );
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    }
});

test("scope scoring catches creates, edits and deletes outside the allowlist", () => {
    const before = new Map([
        ["src/app.js", "aaa"],
        ["vendor/lib.js", "bbb"],
        ["secret.txt", "ccc"],
    ]);
    const after = new Map([
        ["src/app.js", "changed"],
        ["vendor/lib.js", "tampered"],
        ["stray.log", "new"],
    ]);
    const scope = scopeReport(before, after, ["src"]);
    assert.equal(scope.clean, false);
    assert.deepEqual(scope.violations, [
        { path: "secret.txt", kind: "deleted" },
        { path: "stray.log", kind: "created" },
        { path: "vendor/lib.js", kind: "modified" },
    ]);
    // An edit inside the allowlist is not a violation.
    assert.equal(scopeReport(before, new Map([...before, ["src/app.js", "edited"]]), ["src"]).clean, true);
});

test("a `*` entry allows a scratch file without widening scope to subdirectories", () => {
    const before = new Map([
        ["transactions.log", "fixture"],
        ["vendor/a/config.json", "vvv"],
    ]);
    const writable = ["report.json", "*.mjs", "*.js"];
    const withScratch = new Map([...before, ["report.js", "helper"]]);
    // Naming the helper is the harness's choice, so the scratch script itself
    // must not read as a scope breach.
    assert.equal(scopeReport(before, withScratch, writable).clean, true);
    assert.equal(scopeReport(before, new Map([...before, ["report.json", "out"]]), writable).clean, true);

    // The wildcard stays inside one path segment.
    assert.deepEqual(scopeReport(before, new Map([...before, ["src/deep/evil.js", "x"]]), writable).violations, [
        { path: "src/deep/evil.js", kind: "created" },
    ]);

    // The fixture is still protected.
    assert.deepEqual(
        scopeReport(before, new Map([...before, ["transactions.log", "rewritten"]]), writable).violations,
        [{ path: "transactions.log", kind: "modified" }],
    );
});

test("globs do not loosen tasks that declare a strict allowlist", () => {
    const before = new Map([
        ["services/a/config.json", "own"],
        ["vendor/a/config.json", "ext"],
    ]);
    const after = new Map([
        ["services/a/config.json", "migrated"],
        ["vendor/a/config.json", "rewritten"],
    ]);
    // t5-scale-restraint depends on this: a blanket rewrite stays a breach.
    assert.deepEqual(scopeReport(before, after, ["services"]).violations, [
        { path: "vendor/a/config.json", kind: "modified" },
    ]);
});
