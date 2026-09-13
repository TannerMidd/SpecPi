import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
import { ReadOnlyAuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { createEditToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";
import { tasks, suiteVersion } from "../evals/quality/catalog.mjs";
import { materializeTask, fixtureDigest } from "../evals/quality/fixtures.mjs";
import { resolveAnchoredEdit } from "../evals/quality/anchored-edit.mjs";
import { buildSchedule, promptFor } from "../evals/quality/run.mjs";
import { sourceDigests, repositoryRoot, sha256 } from "../evals/quality/provenance.mjs";
import { gradeFinalFiles } from "./replay-quality-results.mjs";
import { QualityBudget } from "./quality-budget.mjs";

export const settings = {
    model: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    prices: { input: 0.15, output: 0.5 },
    contextWindow: 1310720,
    modelMaxTokens: 131072,
    endpoint: "fp8-failover",
    providerName: "OpenRouter FP8 failover",
    endpoints: [
        "baseten/fp8",
        "morph/fp8",
        "parasail/fp8",
        "novita/fp8",
        "gmicloud/fp8",
        "coreweave/fp8",
        "reka/fp8",
        "streamlake/fp8",
    ],
    providerNames: ["BaseTen", "Morph", "Parasail", "Novita", "GMICloud", "CoreWeave", "Reka", "StreamLake"],
    reasoning: "medium",
    maxTokens: 16384,
    maxEditRounds: 3,
    concurrency: 2,
    timeoutMs: 180000,
};
export const profiles = {
    glm: settings,
    deepseek: {
        ...settings,
        model: "deepseek/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        prices: { input: 0.3, output: 1.2 },
        contextWindow: 1048576,
        modelMaxTokens: 131072,
        endpoints: ["deepinfra/fp8", "morph/fp8", "parasail/fp8"],
        providerNames: ["DeepInfra", "Morph", "Parasail"],
        reasoning: "high",
    },
};

const object = (properties) => ({
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
});
const string = { type: "string" };
const array = (items) => ({ type: "array", items });
// Same response contracts as the frozen Codex driver, retained separately so
// adding a provider does not rewrite that experiment's source fingerprints.
export const schemas = {
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

export function conforms(value, schema) {
    if (schema.type === "string") {
        return typeof value === "string";
    }

    if (schema.type === "integer") {
        return Number.isSafeInteger(value);
    }

    if (schema.type === "array") {
        return Array.isArray(value) && value.every((item) => conforms(item, schema.items));
    }

    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === schema.required.length &&
        schema.required.every((key) => Object.hasOwn(value, key) && conforms(value[key], schema.properties[key]))
    );
}

export function requestPayload(payload, schema, profile = settings) {
    return {
        ...payload,
        model: profile.model,
        max_tokens: profile.maxTokens,
        reasoning: { effort: profile.reasoning, exclude: true },
        response_format: { type: "json_schema", json_schema: { name: "evaluation", strict: true, schema } },
        provider: {
            only: profile.endpoints,
            allow_fallbacks: true,
            quantizations: ["fp8"],
            sort: "throughput",
            require_parameters: true,
            data_collection: "deny",
            max_price: { prompt: profile.prices.input, completion: profile.prices.output, request: 0 },
        },
        tools: undefined,
        tool_choice: undefined,
        plugins: [],
    };
}

export async function responseMetadata(response) {
    if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const metadata = { status: response.status };
        for (const name of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
            const value = response.headers.get(name);
            if (value !== null && /^[\d.]+$/u.test(value)) {
                metadata[name] = value;
            }
        }

        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            metadata.retryAfterSeconds = Math.min(retryAfter, 120);
        }

        try {
            const body = await response.json();
            const detail = `${body.error?.message ?? ""} ${body.error?.metadata?.raw ?? ""}`.toLowerCase();
            metadata.errorCategories = [
                "rate",
                "limit",
                "quota",
                "capacity",
                "overload",
                "credit",
                "token",
                "upstream",
                "timeout",
                "balance",
            ].filter((word) => detail.includes(word));
            if (Number.isSafeInteger(body.error?.metadata?.provider_code)) {
                metadata.providerCode = body.error.metadata.provider_code;
            }
        } catch {}

        return metadata;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let pending = "";
    const metadata = { status: response.status };
    while (true) {
        const part = await reader.read();
        if (part.done) {
            break;
        }

        bytes += part.value.length;
        // Per-token SSE framing can exceed the final response size many times.
        if (bytes > 32 * 1024 * 1024) {
            void reader.cancel().catch(() => {});

            return { ...metadata, metadataError: "byte-bound", streamBytes: bytes };
        }

        pending += decoder.decode(part.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
            if (line.trim() === "data: [DONE]") {
                // The protocol is complete even if the server keeps HTTP open.
                // Cancelling a tee branch can wait for its sibling; do not block
                // the completed SDK response on that transport cleanup.
                void reader.cancel().catch(() => {});

                return metadata;
            }

            if (!line.startsWith("data: ")) {
                continue;
            }

            const item = JSON.parse(line.slice(6));
            // Never retain request headers, raw provider errors or reasoning.
            if (typeof item.id === "string") {
                metadata.responseId = item.id;
            }

            if (typeof item.model === "string") {
                metadata.model = item.model;
            }

            if (typeof item.provider === "string") {
                metadata.provider = item.provider;
            }

            if (Number.isFinite(item.usage?.cost)) {
                metadata.reportedCostUsd = item.usage.cost;
            }
        }
    }

    return metadata;
}

export async function createCaller(budget, credentials = new ReadOnlyAuthStorage(), profile = settings) {
    // This supported credential store is consumed only by Pi's provider runtime.
    // No agent/settings/resources/sessions are loaded, and no key is extracted.
    const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    runtime.registerProvider("openrouter", {
        models: [
            {
                id: profile.model,
                name: profile.name,
                reasoning: true,
                input: ["text"],
                cost: { ...profile.prices, cacheRead: profile.prices.input, cacheWrite: profile.prices.input },
                contextWindow: profile.contextWindow,
                maxTokens: profile.modelMaxTokens,
                compat: { thinkingFormat: "openrouter", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
            },
        ],
    });
    const model = runtime.getModel("openrouter", profile.model);
    let notBefore = 0;
    let transientFailures = 0;

    return async (id, prompt, schema) => {
        const startedAt = Date.now();
        let metadataPromise;
        let reserved = false;
        let requestDigest;
        let dispatched = false;
        let response;
        try {
            response = await runtime.completeSimple(
                model,
                {
                    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
                    tools: [],
                },
                {
                    env: { OPENROUTER_API_KEY: "" },
                    maxTokens: profile.maxTokens,
                    reasoning: profile.reasoning,
                    maxRetries: 0,
                    timeoutMs: profile.timeoutMs,
                    signal: AbortSignal.timeout(profile.timeoutMs),
                    onPayload: (payload) => {
                        const request = requestPayload(payload, schema, profile);
                        const text = JSON.stringify(request);
                        // UTF-8 bytes plus ample framing/schema overhead conservatively
                        // bounds text tokenization. Refuse unexpected large contexts.
                        const inputBound = Buffer.byteLength(text) * 2 + 4096;
                        if (inputBound > 250000) {
                            throw new Error("Evaluation request exceeded input bound.");
                        }

                        budget.reserve(id, inputBound, profile.maxTokens, profile.prices);
                        reserved = true;
                        requestDigest = sha256(text);

                        return request;
                    },
                    fetch: async (input, init) => {
                        if (
                            dispatched ||
                            !reserved ||
                            String(input) !== "https://openrouter.ai/api/v1/chat/completions" ||
                            init?.method !== "POST"
                        ) {
                            throw new Error("Unexpected provider transport request.");
                        }

                        dispatched = true;
                        const delay = notBefore - Date.now();
                        if (delay > 0) {
                            await new Promise((resolve) => setTimeout(resolve, delay));
                        }

                        const result = await fetch(input, { ...init, redirect: "error" });
                        if (result.status === 429 || result.status >= 500) {
                            transientFailures += 1;
                            const retryAfter = Number(result.headers.get("retry-after"));
                            notBefore =
                                Date.now() +
                                Math.max(
                                    Math.min(5 * 2 ** (transientFailures - 1), 120),
                                    Math.min(Number.isFinite(retryAfter) ? retryAfter : 0, 120),
                                ) *
                                    1000;
                        } else if (result.ok) {
                            transientFailures = 0;
                        }

                        metadataPromise = responseMetadata(result.clone()).catch(() => ({
                            status: result.status,
                            metadataError: "stream-or-json-error",
                        }));

                        return result;
                    },
                },
            );
        } catch {
            // Library/provider exceptions can contain request details. Keep only
            // safe transport evidence; unresolved reservations remain charged.
        }

        const metadata = (await metadataPromise) ?? {};
        process.stdout.write(
            JSON.stringify({
                event: "provider.request",
                id,
                status: metadata.status,
                retryAfterSeconds: metadata.retryAfterSeconds,
                errorCategories: metadata.errorCategories,
            }) + "\n",
        );
        const evidence = {
            elapsedMs: Date.now() - startedAt,
            promptDigest: sha256(prompt),
            requestDigest,
            metadata,
            toolEvents: [],
        };
        if (!response || ["error", "aborted"].includes(response.stopReason)) {
            return {
                ...evidence,
                infrastructureError: `Provider request incomplete (HTTP ${metadata.status ?? "unavailable"}, dispatched=${dispatched}).`,
            };
        }

        const inputTokens = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
        const outputTokens = response.usage.output;
        const usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            reasoning_tokens: response.usage.reasoning,
            reportedCostUsd: metadata.reportedCostUsd,
        };
        try {
            budget.settle(id, inputTokens, outputTokens, metadata.reportedCostUsd);
        } catch {
            return {
                ...evidence,
                usage,
                infrastructureError:
                    "Usage accounting failed; retain the full reservation and inspect numeric evidence.",
            };
        }

        if (
            metadata.model !== profile.model ||
            !profile.providerNames.some((name) => metadata.provider?.toLowerCase() === name.toLowerCase())
        ) {
            return {
                ...evidence,
                usage,
                infrastructureError: "Returned model/provider identity differs from the frozen route.",
            };
        }

        const text = response.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("");
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {}

        const protocolFailure =
            response.stopReason !== "stop" ||
            Buffer.byteLength(text) > 256 * 1024 ||
            !conforms(parsed, schema) ||
            response.content.some((item) => item.type === "toolCall");

        return {
            ...evidence,
            usage,
            response: protocolFailure ? null : parsed,
            protocolFailure,
            responseDigest: sha256(text),
            stopReason: response.stopReason,
        };
    };
}

async function applyEdits(root, task, condition, response) {
    if (response.calls.length > 16) {
        return [{ error: "Malformed or oversized edit call list." }];
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

        try {
            if (condition === "native") {
                await native.execute(randomUUID(), call);
            } else {
                const target = path.join(root, call.path);
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
            results.push({
                path: call.path,
                error: String(error.message).slice(0, 1200).replaceAll(root, "<fixture>"),
            });
        }
    }

    return results;
}

export async function trial(run, index, output, caller, attempt = 1, profile = settings) {
    const id = `${run.experiment}-${String(index + 1).padStart(3, "0")}-${run.task.id}-${run.condition}-r${run.repetition}`;
    const directory = path.join(output, `${id}-attempt${attempt}`);
    fs.mkdirSync(directory);
    const fixture = materializeTask(run.task.id, path.join(directory, "fixture"));
    const record = {
        id,
        index,
        attempt,
        experiment: run.experiment,
        task: run.task.id,
        condition: run.condition,
        repetition: run.repetition,
        fixtureDigest: fixture.fixtureDigest,
        calls: [],
        acceptance: null,
    };
    const request = async (stage, condition, previous = []) => {
        const priorAttempts = [];
        let call;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            call = await caller(
                `${path.basename(output)}/${path.basename(directory)}/${record.calls.length + 1}-a${attempt}`,
                promptFor(run.task, fixture.root, condition, stage, previous, record.findings ?? []),
                stage === "review" ? schemas.review : schemas[condition],
            );
            if (
                !call.infrastructureError ||
                ![429, 500, 502, 503, 504].includes(call.metadata?.status) ||
                attempt === 3
            ) {
                break;
            }

            priorAttempts.push(call);
        }

        call.priorAttempts = priorAttempts;
        call.elapsedMs += priorAttempts.reduce((sum, item) => sum + item.elapsedMs, 0);
        record.calls.push({ ...call, stage });
        if (call.infrastructureError) {
            record.error = call.infrastructureError;
        }

        if (call.protocolFailure) {
            record.modelFailure = "Invalid structured response, refusal or output limit.";
        }

        return record.calls.at(-1);
    };

    try {
        if (run.experiment === "review") {
            const review = await request("review", run.condition);
            record.findings = review.response?.findings;
            record.expectedIssue = run.task.category !== "negative-control";
        }

        const condition = run.experiment === "review" ? "native" : run.condition;
        let previous = [];
        for (let round = 0; round < profile.maxEditRounds && !record.error && !record.modelFailure; round += 1) {
            const call = await request("edit", condition, previous);
            if (record.error || record.modelFailure) {
                break;
            }

            previous = await applyEdits(fixture.root, run.task, condition, call.response);
            call.editResults = previous;
            if (previous.every((item) => !item.error)) {
                break;
            }
        }

        const blobs = {};
        record.finalFiles = Object.fromEntries(
            Object.keys(run.task.files).map((name) => {
                const text = fs.readFileSync(path.join(fixture.root, name), "utf8");
                const hash = sha256(text);
                blobs[hash] = text;

                return [name, hash];
            }),
        );
        record.changedFiles = Object.keys(run.task.files).filter(
            (name) => blobs[record.finalFiles[name]] !== run.task.files[name],
        );
        record.editRejections = record.calls
            .flatMap((call) => call.editResults ?? [])
            .filter((item) => item.error).length;
        record.editRounds = record.calls.filter((call) => call.stage === "edit").length;
        if (!record.error) {
            record.oracle = gradeFinalFiles(run.task.id, record.finalFiles, blobs);
            record.acceptance = record.modelFailure ? "failed" : record.oracle.acceptance;
        }
    } catch {
        record.error = "Evaluator or budget check failed; stop and inspect synthetic evidence.";
    }

    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(record, null, 2));
    process.stdout.write(
        JSON.stringify({ id, acceptance: record.acceptance, error: record.error, modelFailure: record.modelFailure }) +
            "\n",
    );

    return record;
}

function adapterDigests() {
    return Object.fromEntries(
        ["openrouter-quality.mjs", "quality-budget.mjs", "replay-quality-results.mjs"].map((file) => [
            file,
            sha256(fs.readFileSync(path.join(repositoryRoot, "scripts", file))),
        ]),
    );
}

export function buildProviderSchedule() {
    const editing = buildSchedule("editing");

    return buildSchedule("review").flatMap((run, index) => [
        { ...run, experiment: "review" },
        { ...editing[index], experiment: "editing" },
    ]);
}

export function resumeState(output, manifest) {
    const original = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
    for (const key of Object.keys(manifest).filter((key) => key !== "createdAt")) {
        if (JSON.stringify(original[key]) !== JSON.stringify(manifest[key])) {
            throw new Error(`Resume would change frozen ${key}.`);
        }
    }

    const valid = new Map();
    const attempts = new Map();
    const expectedIds = new Map(
        manifest.schedule.map((item, index) => [
            `${item.experiment}-${String(index + 1).padStart(3, "0")}-${item.task}-${item.condition}-r${item.repetition}`,
            index,
        ]),
    );
    for (const name of fs.readdirSync(output)) {
        const match = /^(.*)-attempt([1-9]\d*)$/u.exec(name);
        if (!match) {
            continue;
        }

        const index = expectedIds.get(match[1]);
        const attempt = Number(match[2]);
        if (index === undefined || !Number.isSafeInteger(attempt)) {
            throw new Error("Unexpected retained attempt directory.");
        }

        attempts.set(index, Math.max(attempts.get(index) ?? 0, attempt));
        const file = path.join(output, name, "result.json");
        if (!fs.existsSync(file)) {
            continue;
        }

        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        const planned = manifest.schedule[record.index];
        if (
            !planned ||
            record.index !== index ||
            record.attempt !== attempt ||
            record.id !== match[1] ||
            !Number.isSafeInteger(record.attempt) ||
            record.attempt < 1 ||
            ["task", "condition", "experiment", "repetition"].some((key) => record[key] !== planned[key]) ||
            record.fixtureDigest !== manifest.fixtureDigests[record.task] ||
            name !== `${record.id}-attempt${record.attempt}`
        ) {
            throw new Error("Retained trial differs from frozen schedule.");
        }

        if (!record.error) {
            if (valid.has(record.index) || !["passed", "failed"].includes(record.acceptance)) {
                throw new Error("Duplicate or malformed completed behavioral trial.");
            }

            valid.set(record.index, record);
        }
    }

    return { valid, attempts };
}

async function main() {
    const [mode, destination, ledger, qualification, profileName = "glm", cap = "5"] = process.argv.slice(2);
    const capUsd = Number(cap);
    const profile = profiles[profileName];
    if (
        !["pilot", "full", "resume"].includes(mode) ||
        !destination ||
        !ledger ||
        !qualification ||
        ![6, 7, 8].includes(process.argv.length) ||
        !Number.isFinite(capUsd) ||
        capUsd <= 0 ||
        !Object.hasOwn(profiles, profileName)
    ) {
        throw new Error(
            "Usage: node scripts/openrouter-quality.mjs <pilot|full|resume> <output> <shared-ledger.json> <qualification.json> [glm|deepseek] [authorized-total-cap-usd]",
        );
    }

    const sources = sourceDigests();
    const qualified = JSON.parse(fs.readFileSync(qualification, "utf8"));
    if (
        qualified.tasks !== 32 ||
        qualified.suiteVersion !== suiteVersion ||
        JSON.stringify(qualified.sourceDigests) !== JSON.stringify(sources)
    ) {
        throw new Error("Frozen suite must be qualified before paid runs.");
    }

    const lock = `${path.resolve(ledger)}.lock`;
    const lockFd = fs.openSync(lock, "wx");
    fs.writeSync(lockFd, String(process.pid));
    try {
        const budget = new QualityBudget(path.resolve(ledger), capUsd);
        budget.save();
        const output = path.resolve(destination);
        if (mode !== "resume") {
            fs.mkdirSync(output);
        }

        const schedule = buildProviderSchedule();
        const selected = mode === "pilot" ? schedule.slice(0, 4) : schedule;
        const adapters = adapterDigests();
        const manifest = {
            schema: 1,
            suiteVersion,
            createdAt: new Date().toISOString(),
            mode: mode === "resume" ? "full" : mode,
            profile: profileName,
            settings: profile,
            sourceDigests: sources,
            adapterDigests: adapters,
            fixtureDigests: Object.fromEntries(tasks.map((task) => [task.id, fixtureDigest(task)])),
            schedule: selected.map(({ task, ...run }) => ({ ...run, task: task.id })),
            piVersion: JSON.parse(
                fs.readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json")),
            ).version,
            node: process.version,
            platform: process.platform,
            transport: "Pi ModelRuntime / OpenRouter",
            capUsd,
        };
        const retained = mode === "resume" ? resumeState(output, manifest) : { valid: new Map(), attempts: new Map() };
        if (mode !== "resume") {
            fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
        }

        const caller = await createCaller(budget, undefined, profile);
        let next = 0;
        let halted = false;
        const records = [...retained.valid.values()];
        const worker = async () => {
            while (!halted && next < selected.length) {
                const index = next++;
                if (retained.valid.has(index)) {
                    continue;
                }

                if (
                    JSON.stringify(sourceDigests()) !== JSON.stringify(sources) ||
                    JSON.stringify(adapterDigests()) !== JSON.stringify(adapters)
                ) {
                    halted = true;
                    throw new Error("Frozen evaluation sources changed.");
                }

                const record = await trial(
                    selected[index],
                    index,
                    output,
                    caller,
                    (retained.attempts.get(index) ?? 0) + 1,
                    profile,
                );
                records.push(record);
                if (record.error) {
                    halted = true;
                }
            }
        };

        try {
            const workers = await Promise.allSettled(
                Array.from({ length: mode === "pilot" ? 1 : profile.concurrency }, worker),
            );
            if (workers.some((result) => result.status === "rejected")) {
                halted = true;
            }
        } finally {
            fs.writeFileSync(
                path.join(output, "completion.json"),
                JSON.stringify(
                    {
                        status: !halted && records.length === selected.length ? "complete" : "incomplete",
                        completed: records.length,
                        valid: records.filter((record) => !record.error).length,
                        conservativeChargeUsd: budget.totalMicros() / 1e6,
                        endedAt: new Date().toISOString(),
                    },
                    null,
                    2,
                ),
            );
        }

        if (halted) {
            process.exitCode = 1;
        }
    } finally {
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
