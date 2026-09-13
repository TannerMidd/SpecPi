import fs from "node:fs";
export const repositorySources = JSON.parse(
    fs.readFileSync(new URL("./repository-sources.json", import.meta.url), "utf8"),
);
const core = "extensions/background-tasks/core.mjs";
const verification = "extensions/background-tasks/verification.mjs";
const redact = "extensions/command-guard/redact.mjs";
const full = repositorySources.files;
const select = (...paths) => Object.fromEntries(paths.map((name) => [name, full[name]]));
export const repositoryMutations = {
    "repo-output-streams": {
        path: core,
        before: "this.decoders[stream].write(chunk)",
        after: 'chunk.toString("utf8")',
    },
    "repo-slot-admission": {
        path: core,
        before: '[...this.tasks.values()].filter((task) => task.cleanup !== "confirmed").length >= LIMITS.active',
        after: '[...this.tasks.values()].filter((task) => task.status === "running").length >= LIMITS.active',
    },
    "repo-receipt-freshness": {
        path: verification,
        before: "receipt.before?.digest === receipt.after?.digest && current.digest === receipt.after?.digest",
        after: "receipt.before?.digest === receipt.after?.digest",
    },
    "repo-command-redaction": {
        path: redact,
        before: '    text = text.replace(/([?&](?:token|secret|password|api[_-]?key|access_token)=)[^&\\s]*/gi, "$1[redacted]");\n',
        after: "",
    },
};
const definitions = [
    {
        id: "repo-output-streams",
        category: "text-editing",
        difficulty: "hard",
        files: select(core, redact),
        request:
            "Repair OutputRing in this public SpecPi module: interleaved stdout/stderr output gets corrupted when multibyte UTF-8 characters span chunks. Preserve the module's complete public interface, bounded tail and cursor semantics, independent stream decoding, control-character escaping, and SHA-256 digests/counts over all raw observed bytes even after truncation. Finalization must flush each stream's decoder. Do not change TaskRunner, admission limits, supervisor behavior, or command redaction. No supervisor execution is needed to reproduce this.",
        acceptance: [
            "Split Unicode on both streams",
            "Raw stream digests after truncation",
            "Cursor/escape compatibility",
        ],
    },
    {
        id: "repo-slot-admission",
        category: "concurrency",
        difficulty: "hard",
        files: select(core, redact),
        request:
            "TaskRunner in this public SpecPi module sometimes exceeds its four-slot limit during startup or cleanup uncertainty. Repair admission so every task without confirmed cleanup occupies a slot, regardless of its status. Confirmed tasks do not occupy slots. A closed runner rejects all starts. Rejection must happen before spawning or mutating the task map. Preserve summary, cancellation, cleanup and output APIs. Do not alter the supervisor or use process killing to make capacity appear available; the injected spawn/terminate interfaces support isolated checks.",
        acceptance: [
            "Starting/stopping/unconfirmed tasks reserve capacity",
            "Closed admission",
            "Confirmed completion releases capacity",
        ],
    },
    {
        id: "repo-receipt-freshness",
        category: "verification",
        difficulty: "hard",
        files: select(verification, core, redact),
        request:
            "Fix live verification receipts in this public SpecPi module: resolve currently reports a pass after a declared config/source file changes. Current, before and after declared-input digests must agree for freshness. Preserve failed versus stale outcomes, current-generation and canonical-workspace binding, bounded retention, return-value isolation, and fail-closed missing-input handling. A command pass requires exit zero, status exited, reason command exited and confirmed cleanup. Never treat stored or model-supplied summaries as fresh evidence. Keep all existing path and private-state restrictions. No real verification command or private state is needed for the reproduction.",
        acceptance: [
            "Mutation/addition/deletion invalidate",
            "Failure and generation boundaries",
            "Returned objects cannot forge authority",
        ],
    },
    {
        id: "repo-command-redaction",
        category: "security-boundary",
        difficulty: "hard",
        files: select(redact),
        request:
            "Fix redactCommand in this public SpecPi module: secrets in URL query parameters are visible in command previews. Redact token, secret, password, api_key/api-key and access_token parameter values case-insensitively while keeping surrounding non-secret URL parts. Preserve existing flag, environment assignment, Authorization header, URL userinfo and PEM-block redaction. Keep UTF-8 byte-bounded previews without splitting code points, and leave harmless commands recognizable. Supported preview limits in this task are integers at least 32. Do not broaden this into a claim of comprehensive secret detection.",
        acceptance: [
            "URL parameter redaction",
            "Existing redaction classes",
            "Byte bounds and harmless command preservation",
        ],
    },
];
export const repositoryTasks = definitions.map((task) => {
    const mutation = repositoryMutations[task.id];
    const source = task.files[mutation.path];
    if (source.split(mutation.before).length !== 2) {
        throw new Error(`Frozen repository mutation drifted: ${task.id}`);
    }

    return {
        ...task,
        provenance: {
            kind: "public-module-mutation",
            repository: repositorySources.repository,
            commit: repositorySources.commit,
        },
        files: { ...task.files, [mutation.path]: source.replace(mutation.before, mutation.after) },
    };
});
