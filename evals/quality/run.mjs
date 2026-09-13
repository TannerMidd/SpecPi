import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tasks, baselineCommit, suiteVersion } from "./catalog.mjs";
import { fixtureDigest, materializeTask } from "./fixtures.mjs";
import { anchoredSnapshot, resolveAnchoredEdit } from "./anchored-edit.mjs";
import { codexEventReader } from "./events.mjs";
import { sourceDigests, repositoryRoot as repository, sha256 as digest } from "./provenance.mjs";
import { createEditToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";

const object = (properties) => ({
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
});
const string = { type: "string" };
const array = (items) => ({ type: "array", items });
const schemas = {
    review: object({
        findings: array(object({ path: string, issue: string, trigger: string, remedy: string })),
        limitations: array(string),
    }),
    native: object({
        calls: array(object({ path: string, edits: array(object({ oldText: string, newText: string })) })),
        explanation: string,
    }),
    anchored: object({
        calls: array(
            object({
                path: string,
                sha256: string,
                edits: array(object({ startLine: { type: "integer" }, endLine: { type: "integer" }, newText: string })),
            }),
        ),
        explanation: string,
    }),
};

export function buildSchedule(experiment, selectedTasks = tasks, repetitions = 3) {
    const schedule = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const [index, task] of selectedTasks.entries()) {
            const conditions = experiment === "review" ? ["baseline", "skill"] : ["native", "anchored"];
            if ((index + repetition) % 2 === 0) {
                conditions.reverse();
            }

            for (const condition of conditions) {
                schedule.push({ task, repetition, condition });
            }
        }
    }

    return schedule;
}

export function promptFor(task, root, condition, stage, previous = [], findings = []) {
    const files = Object.keys(task.files).map((name) => {
        const bytes = fs.readFileSync(path.join(root, name));
        const snapshot = anchoredSnapshot(bytes);

        return {
            path: name,
            sha256: snapshot.sha256,
            content: bytes.toString("utf8"),
            ...(condition === "anchored"
                ? { numberedLines: snapshot.lines.map((text, index) => `${index + 1}: ${text.replace(/\r?\n$/u, "")}`) }
                : {}),
        };
    });
    const instructions =
        stage === "review"
            ? `Review the supplied implementation against its complete request. Report concrete correctness or simplicity findings; do not edit. ${condition === "skill" ? fs.readFileSync(path.join(repository, "skills/specpi-review/SKILL.md"), "utf8") : "For every finding give the file, issue, trigger and smallest remedy. A coherent intentional public interface may need no changes."}`
            : condition === "native"
              ? "Implement the request through Pi 0.84.4's edit interface: return calls with path and edits[{oldText,newText}]. Every oldText must uniquely match the current original file. Multiple non-overlapping edits in one file are supported. Match exactly and merge overlapping changes."
              : "Implement the request through a snapshot-anchored edit interface: return calls with path, the exact supplied sha256, and edits[{startLine,endLine,newText}]. Inclusive ranges replace entire original lines. Include trailing newlines where needed. Multiple non-overlapping ranges are supported; stale snapshots reject.";

    return `${instructions}\nThis is a bounded evaluation. All permitted context is below. Do not use native shell, web, filesystem, agents or connectors. Return only the requested JSON. Do not inspect authentication, settings, sessions or history.\nDo not add files or edit known-baseline.test.mjs. Return at most 16 file calls. An empty calls/findings array is appropriate when no change/finding is justified. Preserve the complete supported interface, not just examples.\nRequest: ${task.request}\nFiles:\n${JSON.stringify(files)}\nReview notes for the repair phase (advisory, may be wrong):\n${JSON.stringify(findings)}\nPrevious edit results (if any; no hidden acceptance results are supplied):\n${JSON.stringify(previous)}\n`;
}

async function modelCall(prompt, schema, directory, config) {
    const responseFile = path.join(directory, "response.json");
    const schemaFile = path.join(directory, "schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--model",
        config.model,
        "-c",
        `model_reasoning_effort="${config.thinking}"`,
        "--color",
        "never",
        "--json",
        "--output-schema",
        schemaFile,
        "--output-last-message",
        responseFile,
        "--cd",
        config.scratch,
        "-",
    ];
    const env = { ...process.env };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"]) {
        delete env[key];
    }

    const startedAt = Date.now();
    const child = spawn(config.codex, args, {
        cwd: config.scratch,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stream = codexEventReader();
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => stream.write(chunk));
    child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => {
        timedOut = true;
        // Only this still-owned child/process group is targeted. A deadline is
        // infrastructure evidence, never a passing model result.
        if (process.platform === "win32") {
            execFile(
                path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
                ["/pid", String(child.pid), "/T", "/F"],
                { windowsHide: true, timeout: 10000 },
                () => {},
            );
        } else {
            try {
                process.kill(-child.pid, "SIGKILL");
            } catch {
                child.kill("SIGKILL");
            }
        }
    }, config.timeoutSeconds * 1000);
    let code;
    try {
        code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
    } finally {
        clearTimeout(timer);
    }

    const events = stream.end();
    const evidence = {
        usage: events.usage,
        toolEvents: events.toolEvents,
        elapsedMs: Date.now() - startedAt,
        promptDigest: digest(prompt),
    };
    if (timedOut || code !== 0 || events.error || !events.completed || !fs.existsSync(responseFile)) {
        const error = new Error(
            `Codex evaluation failed (${timedOut ? "deadline" : code}): ${events.error || stderr.slice(-1500) || "Missing completed response"}`,
        );
        error.evidence = evidence;
        throw error;
    }

    const bytes = fs.readFileSync(responseFile);
    if (bytes.length > 256 * 1024) {
        throw new Error("Model response exceeded the evaluation bound.");
    }

    return { ...evidence, response: JSON.parse(bytes) };
}

async function editRound(root, task, condition, response) {
    if (!Array.isArray(response.calls) || response.calls.length > 16) {
        throw new Error("Malformed or oversized edit call list.");
    }

    const results = [];
    const native = createEditToolDefinition(root);
    for (const call of response.calls) {
        if (!Object.hasOwn(task.files, call.path) || call.path === "known-baseline.test.mjs") {
            results.push({
                path: call.path,
                error: "Target is outside the selected fixture scope or is explicitly unchanged.",
            });
            continue;
        }

        const target = path.join(root, call.path);
        try {
            if (condition === "native") {
                await native.execute(randomUUID(), call);
            } else {
                const bytes = fs.readFileSync(target);
                const result = resolveAnchoredEdit(bytes, call);
                if (!fs.readFileSync(target).equals(bytes)) {
                    throw new Error("File changed before applying the anchored edit.");
                }

                const temporary = `${target}.${randomUUID()}.tmp`;
                fs.writeFileSync(temporary, result.bytes, { flag: "wx" });
                fs.renameSync(temporary, target);
            }

            results.push({ path: call.path, applied: true });
        } catch (error) {
            results.push({ path: call.path, error: String(error.message).slice(0, 1200) });
        }
    }

    return results;
}

export async function executeTrial(run, index, output, config) {
    const id = `${String(index + 1).padStart(3, "0")}-${run.task.id}-${run.condition}-r${run.repetition}`;
    const directory = path.join(output, id);
    fs.mkdirSync(directory);
    const scratch = path.join(config.scratchRoot, id);
    fs.mkdirSync(scratch);
    const fixture = materializeTask(run.task.id, path.join(directory, "fixture"));
    const record = {
        id,
        suiteVersion,
        experiment: config.experiment,
        task: run.task.id,
        condition: run.condition,
        repetition: run.repetition,
        fixtureDigest: fixture.fixtureDigest,
        calls: [],
        acceptance: null,
        maintainability: "requires-human-review",
    };
    const request = async (stage, condition, previous = []) => {
        const roundDir = path.join(directory, `${stage}-${record.calls.length + 1}`);
        fs.mkdirSync(roundDir);
        let value;
        try {
            value = await modelCall(
                promptFor(run.task, fixture.root, condition, stage, previous, record.findings ?? []),
                stage === "review" ? schemas.review : schemas[condition],
                roundDir,
                { ...config, scratch },
            );
        } catch (error) {
            if (error.evidence) {
                record.calls.push({ ...error.evidence, stage, incomplete: true });
            }

            throw error;
        }

        record.calls.push({ ...value, stage });
        if (value.toolEvents.length) {
            throw new Error("Protocol violation: native model tools used outside the supplied evaluation context.");
        }

        return record.calls.at(-1);
    };

    try {
        if (JSON.stringify(sourceDigests()) !== JSON.stringify(config.sourceDigests)) {
            throw new Error("Evaluator sources changed after the schedule was frozen.");
        }

        if (config.experiment === "review") {
            const reviewed = await request("review", run.condition);
            record.findings = reviewed.response.findings;
            record.expectedIssue = run.task.category !== "negative-control";
        }

        const editCondition = config.experiment === "review" ? "native" : run.condition;
        let previous = [];
        for (let round = 0; round < config.maxEditRounds; round += 1) {
            const value = await request("edit", editCondition, previous);
            previous = await editRound(fixture.root, run.task, editCondition, value.response);
            value.editResults = previous;
            if (previous.every((item) => !item.error)) {
                break;
            }
        }

        // Independent executable graders never feed their hidden assertions back
        // into the candidate loop. A hung candidate spends its grading budget.
        const checked = spawnSync(
            process.execPath,
            [path.join(repository, "evals/quality/check.mjs"), run.task.id, fixture.root],
            { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 65536 },
        );
        const lines = checked.stdout?.trim().split(/\r?\n/u) ?? [];
        let oracle;
        try {
            oracle = JSON.parse(lines.at(-1));
        } catch {}

        if (checked.error?.code === "ETIMEDOUT" && lines.some((line) => line.includes('"event":"oracle.started"'))) {
            record.acceptance = "failed";
            record.oracle = { acceptance: "failed", reason: "Candidate exceeded the 30-second grading budget." };
        } else if (
            ![0, 1].includes(checked.status) ||
            !oracle ||
            oracle.task !== run.task.id ||
            !["passed", "failed"].includes(oracle.acceptance)
        ) {
            throw new Error(
                `Oracle infrastructure failed: ${oracle?.reason ?? checked.error?.message ?? checked.stderr?.slice(-1000) ?? "missing structured result"}`,
            );
        } else {
            record.acceptance = oracle.acceptance;
            record.oracle = oracle;
        }

        record.changedFiles = Object.keys(run.task.files).filter(
            (file) => fs.readFileSync(path.join(fixture.root, file), "utf8") !== run.task.files[file],
        );
        record.finalFiles = Object.fromEntries(
            Object.keys(run.task.files).map((file) => [file, digest(fs.readFileSync(path.join(fixture.root, file)))]),
        );
        record.editRejections = record.calls
            .flatMap((call) => call.editResults ?? [])
            .filter((item) => item.error).length;
        record.editRounds = record.calls.filter((call) => call.stage === "edit").length;
    } catch (error) {
        record.error = String(error.message).slice(0, 2000);
    }

    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(record, null, 2));
    process.stdout.write(
        JSON.stringify({
            id,
            acceptance: record.acceptance,
            findings: record.findings?.length,
            error: record.error,
            elapsedMs: record.calls.reduce((total, call) => total + call.elapsedMs, 0),
        }) + "\n",
    );

    return record;
}

async function main() {
    const [experiment, destination, limitText] = process.argv.slice(2);
    if (
        !["review", "editing"].includes(experiment) ||
        !destination ||
        (limitText && (!/^[1-9]\d*$/u.test(limitText) || !Number.isSafeInteger(Number(limitText)))) ||
        process.argv.length > 5
    ) {
        throw new Error("Usage: node evals/quality/run.mjs <review|editing> <new-output-directory> [pilot-run-limit]");
    }

    const qualified = JSON.parse(
        fs.readFileSync(
            process.env.SPECPI_EVAL_QUALIFICATION ||
                path.join(repository, ".specpi-test/quality-v2-qualification.json"),
            "utf8",
        ),
    );
    const sources = sourceDigests();
    if (
        qualified.suiteVersion !== suiteVersion ||
        qualified.tasks !== tasks.length ||
        JSON.stringify(qualified.sourceDigests) !== JSON.stringify(sources)
    ) {
        throw new Error("Current evaluator sources must pass qualify.mjs before model runs.");
    }

    const output = path.resolve(destination);
    fs.mkdirSync(output);
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "specpi-eval-"));
    const config = {
        experiment,
        suiteVersion,
        baselineCommit,
        model: "gpt-6-astra",
        thinking: "medium",
        provider: "Codex CLI / ChatGPT subscription",
        codex: process.env.SPECPI_EVAL_CODEX || "codex",
        scratchRoot,
        repetitions: 3,
        concurrency: 2,
        maxEditRounds: 3,
        timeoutSeconds: 180,
        monetaryCost: null,
        monetaryCostReason: "Subscription usage; no API price inferred.",
        humanInterventions: 0,
        sourceDigests: sources,
    };
    const relativeScratch = path.relative(repository, scratchRoot);
    if (!relativeScratch.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeScratch)) {
        throw new Error(
            "Set the evaluation TEMP directory outside the repository so fresh model cwd does not inherit repository instructions.",
        );
    }

    const cliVersion = spawnSync(config.codex, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
    }).stdout?.trim();
    if (!cliVersion) {
        throw new Error("Codex CLI version is unavailable.");
    }

    const schedule = buildSchedule(experiment).slice(0, limitText ? Number(limitText) : undefined);
    const manifest = {
        ...config,
        cliVersion,
        piVersion: "0.84.4",
        node: process.version,
        platform: process.platform,
        pilot: Boolean(limitText),
        scheduled: schedule.length,
        fixtureDigests: Object.fromEntries(tasks.map((task) => [task.id, fixtureDigest(task)])),
        qualification: qualified,
        startedAt: new Date().toISOString(),
        limitations: [
            "Authored JavaScript fixtures and public-module mutations; not representative repository accuracy or a SWE-bench result",
            "Codex response adapter with supplied context; not a full Pi agent, repository exploration, or installed-feature benchmark",
            "Native Codex tools are instructed off, not disabled. Fresh cwd is not read isolation; detected external tool use invalidates the controlled trial",
            "Hidden behavioral grading does not establish maintainability or complete requirement coverage; human review remains necessary",
            "Anchored editing is an uninstalled experiment with no production mutation/Command Guard equivalence claim",
        ],
    };
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
        path.join(output, "schedule.json"),
        JSON.stringify(
            schedule.map(({ task, ...run }, index) => ({ index, task: task.id, ...run })),
            null,
            2,
        ),
    );
    let next = 0;
    let halted = false;
    const records = [];
    try {
        const worker = async () => {
            while (!halted && next < schedule.length) {
                const index = next++;
                const record = await executeTrial(schedule[index], index, output, config);
                records.push(record);
                if (record.error) {
                    halted = true;
                }
            }
        };

        await Promise.all(Array.from({ length: config.concurrency }, worker));
    } finally {
        fs.writeFileSync(
            path.join(output, "completion.json"),
            JSON.stringify(
                {
                    status: halted ? "invalid-run" : records.length === schedule.length ? "complete" : "incomplete",
                    scheduled: schedule.length,
                    completed: records.length,
                    valid: records.filter((record) => !record.error).length,
                    endedAt: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
        // This is the exact fresh directory allocated above, never a caller's path.
        if (
            path.dirname(scratchRoot) === path.resolve(os.tmpdir()) &&
            path.basename(scratchRoot).startsWith("specpi-eval-")
        ) {
            fs.rmSync(scratchRoot, { recursive: true, force: true });
        }
    }

    if (halted) {
        throw new Error(
            "Evaluation stopped on an invalid run. Retained infrastructure/protocol failures are not model accuracy results.",
        );
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
