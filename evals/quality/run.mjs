import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tasks, baselineCommit } from "./tasks.mjs";
import { fixtureDigest, materializeTask } from "./fixtures.mjs";
import { anchoredSnapshot, resolveAnchoredEdit } from "./anchored-edit.mjs";
import { createEditToolDefinition } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
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
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
    }, 180000);
    let code;
    try {
        code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
    } finally {
        clearTimeout(timer);
    }

    const events = stdout.split(/\r?\n/u).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
    const usage = events.findLast((event) => event.type === "turn.completed")?.usage ?? null;
    const tools = events
        .filter((event) => event.type === "item.completed" && event.item?.type !== "agent_message")
        .map((event) => event.item.type);
    if (timedOut || code !== 0 || !fs.existsSync(responseFile)) {
        const error = new Error(
            `Codex evaluation failed (${timedOut ? "deadline" : code}): ${stderr.slice(-1500) || JSON.stringify(events.filter((event) => /error|failed/u.test(event.type)).slice(-2))}`,
        );
        error.usage = usage;
        throw error;
    }

    const bytes = fs.readFileSync(responseFile);
    if (bytes.length > 256 * 1024) {
        throw new Error("Model response exceeded the evaluation bound.");
    }

    return {
        response: JSON.parse(bytes),
        usage,
        toolEvents: tools,
        elapsedMs: Date.now() - startedAt,
        promptDigest: digest(prompt),
    };
}

function promptFor(task, root, condition, experiment, previous = []) {
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
        experiment === "review"
            ? `Review this proposed small change against its request. The supplied files are the complete synthetic change and context. Report only concrete correctness or simplicity findings; do not edit. ${condition === "skill" ? fs.readFileSync(path.join(repository, "skills/specpi-review/SKILL.md"), "utf8") : "For every finding give the file, issue, trigger and smallest remedy. A coherent intentional public interface may need no changes."}`
            : condition === "native"
              ? "Implement the request through Pi 0.84.4's edit interface: return calls with path and edits[{oldText,newText}]. Every oldText must uniquely match the original file; multiple non-overlapping edits in one file are supported. Match exactly, keep unchanged context small, and merge overlapping changes. Do not add files. An empty calls array means no change is needed."
              : "Implement the request through a snapshot-anchored edit interface: return calls with path, the exact supplied sha256, and edits[{startLine,endLine,newText}]. Line ranges are inclusive and replace entire original lines. Include a trailing newline when replacing a line that must remain separate from its successor. Multiple non-overlapping ranges are supported; stale snapshots reject. Do not add files. An empty calls array means no change is needed.";

    return `${instructions}\nThis is a bounded synthetic evaluation. All permitted context is below. Do not use shell, web, external files, agents, or connectors. Return only the requested JSON. Do not inspect authentication, settings, sessions or history.\nRequest: ${task.request}\nFiles:\n${JSON.stringify(files)}\nPrevious edit results (if any):\n${JSON.stringify(previous)}\n`;
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

async function main() {
    const [experiment, destination, limitText] = process.argv.slice(2);
    if (!["review", "editing"].includes(experiment) || !destination || (limitText && !/^\d+$/u.test(limitText))) {
        throw new Error("Usage: node evals/quality/run.mjs <review|editing> <new-output-directory> [run-limit]");
    }

    const output = path.resolve(destination);
    fs.mkdirSync(output);
    const scratch = path.join(output, "model-workspace");
    fs.mkdirSync(scratch);
    const config = {
        experiment,
        baselineCommit,
        model: "gpt-6-astra",
        thinking: "medium",
        provider: "Codex CLI / ChatGPT subscription",
        codex: process.env.SPECPI_EVAL_CODEX || "codex",
        scratch,
        repetitions: 3,
        maxEditRounds: 3,
        timeoutSeconds: 180,
        monetaryCost: null,
        monetaryCostReason: "Subscription usage; no API price inferred.",
        humanInterventions: 0,
    };
    const sourceFiles = [
        "tasks.mjs",
        "fixtures.mjs",
        "oracle.mjs",
        "reference.mjs",
        "anchored-edit.mjs",
        "run.mjs",
        "check.mjs",
    ];
    const sourceDigests = Object.fromEntries(
        sourceFiles.map((file) => [file, digest(fs.readFileSync(new URL(file, import.meta.url)))]),
    );
    sourceDigests["specpi-review/SKILL.md"] = digest(
        fs.readFileSync(path.join(repository, "skills/specpi-review/SKILL.md")),
    );
    const cliVersion = spawnSync(config.codex, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
    }).stdout?.trim();
    fs.writeFileSync(
        path.join(output, "manifest.json"),
        JSON.stringify(
            {
                ...config,
                cliVersion,
                piVersion: "0.84.4",
                sourceDigests,
                fixtureDigests: Object.fromEntries(tasks.map((task) => [task.id, fixtureDigest(task)])),
                startedAt: new Date().toISOString(),
                limitations: [
                    "Synthetic task screen, not representative repository accuracy",
                    "Codex CLI response adapter, not a full Pi conversation",
                    "Native Codex tools are instructed off, not disabled; tool use is recorded as a protocol deviation",
                    "Human maintainability review is still required",
                    "No native mutation or Command Guard equivalence is claimed for the uninstalled anchored experiment",
                ],
            },
            null,
            2,
        ),
    );
    const schedule = [];
    for (let repetition = 1; repetition <= 3; repetition += 1) {
        for (const [index, task] of tasks.entries()) {
            const conditions = experiment === "review" ? ["baseline", "skill"] : ["native", "anchored"];
            if ((index + repetition) % 2 === 0) {
                conditions.reverse();
            }

            for (const condition of conditions) {
                schedule.push({ task, repetition, condition });
            }
        }
    }

    for (const [index, run] of schedule.slice(0, limitText ? Number(limitText) : 48).entries()) {
        const id = `${String(index + 1).padStart(2, "0")}-${run.task.id}-${run.condition}-r${run.repetition}`;
        const directory = path.join(output, id);
        fs.mkdirSync(directory);
        const fixture = materializeTask(run.task.id, path.join(directory, "fixture"));
        const record = {
            id,
            experiment,
            task: run.task.id,
            condition: run.condition,
            repetition: run.repetition,
            fixtureDigest: fixture.fixtureDigest,
            calls: [],
            acceptance: null,
            maintainability: "requires-human-review",
            unintendedChanges: null,
        };
        let previous = [];
        try {
            for (let round = 0; round < (experiment === "review" ? 1 : config.maxEditRounds); round += 1) {
                const roundDir = path.join(directory, `round-${round + 1}`);
                fs.mkdirSync(roundDir);
                const schema = experiment === "review" ? schemas.review : schemas[run.condition];
                const value = await modelCall(
                    promptFor(run.task, fixture.root, run.condition, experiment, previous),
                    schema,
                    roundDir,
                    config,
                );
                record.calls.push(value);
                if (experiment === "review") {
                    record.findings = value.response.findings;
                    record.expectedIssue = run.task.category !== "negative-control";
                    break;
                }

                previous = await editRound(fixture.root, run.task, run.condition, value.response);
                value.editResults = previous;
                if (previous.every((item) => !item.error)) {
                    break;
                }
            }

            if (experiment === "editing") {
                const checked = spawnSync(
                    process.execPath,
                    [path.join(repository, "evals", "quality", "check.mjs"), run.task.id, fixture.root],
                    { encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 65536 },
                );
                record.acceptance = checked.status === 0 ? "passed" : "failed";
                record.oracle = checked.stdout?.slice(-3000) || checked.error?.message || checked.stderr?.slice(-1000);
                record.changedFiles = Object.keys(run.task.files).filter(
                    (file) => fs.readFileSync(path.join(fixture.root, file), "utf8") !== run.task.files[file],
                );
            }
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
        if (record.error) {
            throw new Error(
                "Evaluation stopped on infrastructure failure. Completed evidence is retained; do not count the failed run as a model accuracy result.",
            );
        }
    }
}

await main();
