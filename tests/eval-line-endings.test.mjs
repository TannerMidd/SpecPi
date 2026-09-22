import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    listTasks,
    prepareWorkspace,
    runChecker,
    runReferenceSolution,
    workspaceFingerprint,
} from "../scripts/eval-tasks.mjs";

// A harness on Windows that writes a file through shell redirection ends its lines CRLF; one
// that writes through a file tool ends them LF. That is a property of the route, not of the
// answer, and a checker comparing bytes fails the first harness for output the second passes.
//
// It cost real measurements before it was found: five of the six tier 1-2 failures in the
// published run were this, all on one harness, which put that harness bottom of the table on
// those tiers. The failure has two shapes and only one of them is visible in the report --
// `content !== expected` prints the CRLF it rejected, while `split("\n").includes(line)` just
// says the line is missing, because the line it found ends "\r".
//
// So this does not test the checkers by reading them. It runs each task's own reference
// solution, rewrites what the solution produced as CRLF, and asserts the verdict does not move.

const TIERS = [1, 2];

/** Every file the reference solution created or changed -- never one it left alone. */
function touchedFiles(before, after) {
    const changed = [];
    for (const [relative, digest] of after) {
        if (before.get(relative) !== digest) {
            changed.push(relative);
        }
    }

    return changed;
}

function isText(buffer) {
    return !buffer.includes(0);
}

test("tier 1 and 2 checkers grade content, not the line endings the harness wrote it with", async () => {
    const tasks = listTasks().filter((task) => TIERS.includes(task.tier));
    assert.ok(tasks.length > 0, "no tier 1-2 tasks found");
    let converted = 0;
    for (const task of tasks) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eol-"));
        try {
            prepareWorkspace(task, dir);
            const before = workspaceFingerprint(dir);
            await runReferenceSolution(task, dir);
            const lf = await runChecker(task, dir);
            assert.equal(
                lf.pass,
                true,
                `${task.id}: the reference solution does not pass its own checker: ${lf.notes}`,
            );

            // Only what the solution wrote is converted. A file it left alone is one the task
            // may have told it not to write, and rewriting that is a different thing entirely
            // -- covered by the next test.
            const touched = touchedFiles(before, workspaceFingerprint(dir));
            let rewrote = false;
            for (const relative of touched) {
                const file = path.join(dir, relative);
                if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
                    continue;
                }

                const raw = fs.readFileSync(file);
                if (!isText(raw)) {
                    continue;
                }

                const text = raw.toString("utf8");
                if (!text.includes("\n")) {
                    continue;
                }

                fs.writeFileSync(file, text.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n"));
                rewrote = true;
            }

            if (!rewrote) {
                continue;
            }

            converted += 1;
            const crlf = await runChecker(task, dir);
            assert.equal(
                crlf.pass,
                true,
                `${task.id}: the same answer fails when its lines end CRLF instead of LF: ${crlf.notes}`,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    assert.ok(converted >= 5, `expected several tasks to write multi-line files, converted ${converted}`);
});

// The other half of the fix. Normalising must not reach the files a task says not to touch:
// rewriting one with different line endings is still rewriting it, and a checker that shrugs
// at that has stopped measuring restraint.
test("a protected file rewritten with other line endings is still a failure", async () => {
    const cases = [
        { id: "t1-no-touch", protectedFile: "dont-touch.txt" },
        { id: "t2-scoped-docs", protectedFile: "NOTES.md" },
    ];
    for (const { id, protectedFile } of cases) {
        const task = listTasks().find((entry) => entry.id === id);
        assert.ok(task, `${id} is missing`);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eol-"));
        try {
            prepareWorkspace(task, dir);
            await runReferenceSolution(task, dir);
            const file = path.join(dir, protectedFile);
            const text = fs.readFileSync(file, "utf8");
            fs.writeFileSync(file, text.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n"));
            const result = await runChecker(task, dir);
            assert.equal(result.pass, false, `${id}: rewriting ${protectedFile} was accepted`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});
