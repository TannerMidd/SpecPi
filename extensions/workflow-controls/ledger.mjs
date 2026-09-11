import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalRoot, createWorktreeSnapshot, resolveScopedPath, sanitizePathLabel } from "./scope.mjs";
import { markdownPathLabel } from "./task-contract.mjs";

export const VERIFICATION_LEDGER_ENTRY = "specpi-verification-ledger";
export const VERIFICATION_LEDGER_SCHEMA = 1;
export const GATE_CONFIG_SCHEMA = 1;
export const GATE_CONFIG_RELATIVE = path.join(".specpi", "checks.json");
export const MAX_GATE_CONFIG_BYTES = 16 * 1024;
export const MAX_GATES = 16;
export const MAX_GATE_ARGS = 24;
export const MAX_GATE_ARG_LENGTH = 240;
export const MAX_GATE_COMMAND_LENGTH = 240;
export const MAX_GATE_LABEL_LENGTH = 120;
export const MAX_CITED_GATES = 8;
export const MIN_GATE_TIMEOUT_MS = 1000;
export const MAX_GATE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_CHANGED_SINCE = 20;

const GATE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
// A gate runs through pi.exec with an explicit argument array, so no shell parses these strings. Control characters
// are still rejected because the command and arguments are echoed into approval prompts, tool results, and Markdown.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// A resolution is only ever as good as its worst cited gate. Severity decides which state a requirement reports when
// it cites several gates at once.
const RESOLUTION_SEVERITY = Object.freeze({
    failed: 5,
    unavailable: 4,
    stale: 3,
    indeterminate: 2,
    proven: 1,
});

export class LedgerError extends Error {
    constructor(message, { corrupt = false } = {}) {
        super(message);
        this.corruptGateConfig = corrupt;
    }
}

export function gateConfigFile(root) {
    return path.join(root, GATE_CONFIG_RELATIVE);
}

export function gateConfigLabel() {
    return GATE_CONFIG_RELATIVE.split(path.sep).join("/");
}

function boundedText(value, label, maximum) {
    if (typeof value !== "string") {
        throw new LedgerError(`${label} must be text`, { corrupt: true });
    }

    const trimmed = value.trim();
    if (!trimmed || Buffer.byteLength(trimmed) > maximum || CONTROL_CHARACTERS.test(trimmed)) {
        throw new LedgerError(`${label} must be non-empty text up to ${maximum} bytes without controls`, {
            corrupt: true,
        });
    }

    return trimmed;
}

function normalizeGateCwd(root, value) {
    if (value === undefined || value === null || value === "") {
        return ".";
    }

    const requested = boundedText(value, "Gate cwd", MAX_GATE_ARG_LENGTH);
    if (path.isAbsolute(requested) || /^[A-Za-z]:[\\/]/u.test(requested)) {
        throw new LedgerError("Gate cwd must be project-relative", { corrupt: true });
    }

    // Deliberately the same resolver the scope monitor uses, so a lexically inside path that reaches outside the
    // root through a link is rejected here too rather than only where scope already checks for it.
    try {
        return resolveScopedPath(root, requested).path;
    } catch (error) {
        throw new LedgerError(`Gate cwd is not inside the project root: ${error?.message ?? "unresolved"}`, {
            corrupt: true,
        });
    }
}

function normalizeGate(id, value, root) {
    if (!GATE_ID.test(id)) {
        throw new LedgerError(`Gate ID must match ${GATE_ID.source}: ${sanitizePathLabel(String(id).slice(0, 64))}`, {
            corrupt: true,
        });
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new LedgerError(`Gate ${id} must be an object`, { corrupt: true });
    }

    const allowed = new Set(["command", "windows", "args", "cwd", "timeoutMs", "label"]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new LedgerError(`Gate ${id} has an unsupported field: ${key.slice(0, 32)}`, { corrupt: true });
        }
    }

    const timeoutMs =
        value.timeoutMs === undefined || value.timeoutMs === null ? DEFAULT_GATE_TIMEOUT_MS : value.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_GATE_TIMEOUT_MS || timeoutMs > MAX_GATE_TIMEOUT_MS) {
        throw new LedgerError(
            `Gate ${id} timeoutMs must be an integer between ${MIN_GATE_TIMEOUT_MS} and ${MAX_GATE_TIMEOUT_MS}`,
            { corrupt: true },
        );
    }

    // A Windows override replaces the command and its arguments together. Swapping only the program name is not
    // enough: `npm` there is a batch script that a shell-free spawn cannot start at all, so the portable spelling
    // has to be an entirely different invocation such as `cmd.exe /c npm run check`.
    const platform = process.platform === "win32" && value.windows !== undefined ? value.windows : value;
    if (!platform || typeof platform !== "object" || Array.isArray(platform)) {
        throw new LedgerError(`Gate ${id} windows override must be an object`, { corrupt: true });
    }

    if (platform !== value) {
        for (const key of Object.keys(platform)) {
            if (!["command", "args"].includes(key)) {
                throw new LedgerError(`Gate ${id} windows override supports only command and args`, { corrupt: true });
            }
        }
    }

    const args = platform.args === undefined || platform.args === null ? [] : platform.args;
    if (!Array.isArray(args) || args.length > MAX_GATE_ARGS) {
        throw new LedgerError(`Gate ${id} supports at most ${MAX_GATE_ARGS} arguments`, { corrupt: true });
    }

    const command = boundedText(platform.command, `Gate ${id} command`, MAX_GATE_COMMAND_LENGTH);
    // Rejected at declaration rather than at run time: Node refuses to spawn a batch script without a shell, so such
    // a gate could never produce a result and would surface as an opaque EINVAL on the first call instead.
    if (/\.(?:cmd|bat)$/iu.test(command)) {
        throw new LedgerError(
            `Gate ${id} names a batch script, which cannot run without a shell. Invoke it explicitly, for example command "cmd.exe" with args ["/c", "npm", "run", "check"].`,
            { corrupt: true },
        );
    }

    return {
        id,
        command,
        args: args.map((item, index) => boundedText(item, `Gate ${id} argument ${index + 1}`, MAX_GATE_ARG_LENGTH)),
        cwd: normalizeGateCwd(root, value.cwd),
        timeoutMs,
        label:
            value.label === undefined || value.label === null
                ? ""
                : boundedText(value.label, `Gate ${id} label`, MAX_GATE_LABEL_LENGTH),
    };
}

export function normalizeGateConfig(value, root) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new LedgerError("Gate configuration must be an object", { corrupt: true });
    }

    if (value.schema !== GATE_CONFIG_SCHEMA) {
        throw new LedgerError("Unsupported gate configuration schema", { corrupt: true });
    }

    const gates = value.gates;
    if (!gates || typeof gates !== "object" || Array.isArray(gates)) {
        throw new LedgerError("Gate configuration requires a gates object", { corrupt: true });
    }

    const ids = Object.keys(gates);
    if (ids.length === 0 || ids.length > MAX_GATES) {
        throw new LedgerError(`Gate configuration requires 1-${MAX_GATES} gates`, { corrupt: true });
    }

    const resolvedRoot = canonicalRoot(root);

    return {
        active: true,
        root: resolvedRoot,
        gates: ids.sort().map((id) => normalizeGate(id, gates[id], resolvedRoot)),
    };
}

// A missing configuration file is the ordinary case: it leaves verification inactive and every existing workflow
// unchanged. Only a present-but-unusable file is an error, because silently ignoring one would present an
// unverified session as if no gates had ever been declared.
export function readGateConfig(root) {
    const resolvedRoot = canonicalRoot(root);
    const file = gateConfigFile(resolvedRoot);
    for (const target of [path.dirname(file), file]) {
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch (error) {
            if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
                return { active: false, root: resolvedRoot, gates: [] };
            }

            throw error;
        }

        if (stat.isSymbolicLink()) {
            throw new LedgerError(`Gate configuration must not be a link: ${gateConfigLabel()}`);
        }
    }

    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_GATE_CONFIG_BYTES) {
        throw new LedgerError(`Gate configuration is not a bounded regular file: ${gateConfigLabel()}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        throw new LedgerError(`Gate configuration could not be read as JSON: ${gateConfigLabel()}`, { corrupt: true });
    }

    return normalizeGateConfig(parsed, resolvedRoot);
}

export function findGate(config, id) {
    if (!config?.active || typeof id !== "string") {
        return undefined;
    }

    return config.gates.find((gate) => gate.id === id);
}

export function gateCommandLine(gate) {
    return [gate.command, ...gate.args].join(" ");
}

// The digest covers the changed-path set and every fingerprint in it. Two snapshots with the same digest describe the
// same observable worktree, which is what makes a later comparison a proof rather than a guess.
export function snapshotDigest(snapshot) {
    if (!snapshot || snapshot.indeterminate) {
        return undefined;
    }

    const payload = JSON.stringify({
        root: snapshot.root,
        paths: [...snapshot.paths].sort(),
        fingerprints: Object.fromEntries(
            Object.keys(snapshot.fingerprints)
                .sort()
                .map((key) => [key, snapshot.fingerprints[key]]),
        ),
    });

    return createHash("sha256").update(payload).digest("hex");
}

export async function captureVerificationSnapshot(root, exec) {
    const resolvedRoot = canonicalRoot(root);
    try {
        const status = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
            cwd: resolvedRoot,
            timeout: 30_000,
        });
        if (status.code !== 0) {
            return { root: resolvedRoot, paths: [], fingerprints: {}, indeterminate: true, reason: "Git unavailable" };
        }

        return createWorktreeSnapshot(resolvedRoot, status.stdout);
    } catch {
        return { root: resolvedRoot, paths: [], fingerprints: {}, indeterminate: true, reason: "Git unavailable" };
    }
}

export function createLedgerRecord({ gate, exitCode, snapshot, startedAt, durationMs, commandLine }) {
    if (!gate || !GATE_ID.test(gate.id)) {
        throw new LedgerError("Ledger records require a declared gate");
    }

    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new LedgerError("Ledger records require an observed exit code between 0 and 255");
    }

    const indeterminate = Boolean(snapshot?.indeterminate);

    return {
        schema: VERIFICATION_LEDGER_SCHEMA,
        gate: gate.id,
        command: typeof commandLine === "string" ? commandLine.slice(0, 600) : gateCommandLine(gate),
        cwd: gate.cwd,
        exitCode,
        root: snapshot?.root ?? "",
        digest: snapshotDigest(snapshot),
        paths: indeterminate ? [] : [...snapshot.paths],
        fingerprints: indeterminate ? {} : { ...snapshot.fingerprints },
        indeterminate,
        startedAt: typeof startedAt === "string" ? startedAt : new Date().toISOString(),
        durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0,
    };
}

export function validateLedgerRecord(value, root) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    if (value.schema !== VERIFICATION_LEDGER_SCHEMA || !GATE_ID.test(String(value.gate))) {
        return undefined;
    }

    if (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) {
        return undefined;
    }

    if (typeof value.root !== "string" || (root !== undefined && value.root !== root)) {
        return undefined;
    }

    const indeterminate = Boolean(value.indeterminate);
    if (!indeterminate && (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest))) {
        return undefined;
    }

    const paths = Array.isArray(value.paths) ? value.paths.filter((item) => typeof item === "string") : [];
    const fingerprints = {};
    if (value.fingerprints && typeof value.fingerprints === "object" && !Array.isArray(value.fingerprints)) {
        for (const key of paths) {
            if (typeof value.fingerprints[key] === "string") {
                fingerprints[key] = value.fingerprints[key];
            }
        }
    }

    return {
        schema: VERIFICATION_LEDGER_SCHEMA,
        gate: value.gate,
        command: typeof value.command === "string" ? value.command.slice(0, 600) : "",
        cwd: typeof value.cwd === "string" ? value.cwd.slice(0, MAX_GATE_ARG_LENGTH) : ".",
        exitCode: value.exitCode,
        root: value.root,
        digest: indeterminate ? undefined : value.digest,
        paths,
        fingerprints,
        indeterminate,
        startedAt: typeof value.startedAt === "string" ? value.startedAt.slice(0, 40) : "",
        durationMs: Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 ? value.durationMs : 0,
    };
}

// Records are latest-per-gate rather than an append-only log: a re-run supersedes its predecessor, and keeping one
// snapshot per declared gate is what bounds the branch entry.
export function restoreLedger(entries, root) {
    const records = new Map();
    if (!Array.isArray(entries)) {
        return records;
    }

    for (const entry of entries) {
        if (entry?.type !== "custom" || entry.customType !== VERIFICATION_LEDGER_ENTRY) {
            continue;
        }

        const data = entry.data;
        if (data?.kind === "cleared") {
            records.clear();
            continue;
        }

        if (data?.kind !== "recorded") {
            continue;
        }

        const record = validateLedgerRecord(data.record, root);
        if (record) {
            records.set(record.gate, record);
        }
    }

    return records;
}

export function changedSince(record, snapshot) {
    if (!record || record.indeterminate || !snapshot || snapshot.indeterminate) {
        return [];
    }

    const candidates = new Set([...record.paths, ...snapshot.paths]);

    return [...candidates]
        .filter((candidate) => record.fingerprints[candidate] !== snapshot.fingerprints[candidate])
        .sort()
        .slice(0, MAX_CHANGED_SINCE);
}

export function resolveGate(record, snapshot) {
    if (!record) {
        return { state: "unavailable", changedSince: [] };
    }

    const base = { exitCode: record.exitCode, startedAt: record.startedAt, command: record.command };
    if (record.exitCode !== 0) {
        return { ...base, state: "failed", changedSince: [] };
    }

    if (record.indeterminate || !snapshot || snapshot.indeterminate) {
        return { ...base, state: "indeterminate", changedSince: [] };
    }

    if (record.root !== snapshot.root) {
        return { ...base, state: "indeterminate", changedSince: [] };
    }

    if (record.digest !== snapshotDigest(snapshot)) {
        return { ...base, state: "stale", changedSince: changedSince(record, snapshot) };
    }

    return { ...base, state: "proven", changedSince: [] };
}

export function resolveLedger(config, records, snapshot) {
    if (!config?.active) {
        return { active: false, gates: {} };
    }

    const gates = {};
    for (const gate of config.gates) {
        gates[gate.id] = resolveGate(records?.get?.(gate.id), snapshot);
    }

    return { active: true, gates };
}

export function normalizeCitedGates(value) {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value) || value.length > MAX_CITED_GATES) {
        throw new Error(`A requirement may cite at most ${MAX_CITED_GATES} gates`);
    }

    const cited = [];
    for (const item of value) {
        if (typeof item !== "string" || !GATE_ID.test(item)) {
            throw new Error("Cited gate IDs must be declared gate identifiers");
        }

        if (!cited.includes(item)) {
            cited.push(item);
        }
    }

    return cited;
}

// The requirement inherits the worst state among the gates it cites. Citing nothing while verification is active is
// reported as `uncited` so a claim of proof can be separated from an absence of any claim at all.
export function resolveRequirement(cited, verification) {
    if (!verification?.active) {
        return undefined;
    }

    if (!Array.isArray(cited) || cited.length === 0) {
        return { state: "uncited", gates: [], changedSince: [] };
    }

    let worst;
    const details = [];
    for (const id of cited) {
        const resolution = verification.gates[id] ?? { state: "unavailable", changedSince: [] };
        details.push({ gate: id, state: resolution.state, exitCode: resolution.exitCode });
        if (!worst || RESOLUTION_SEVERITY[resolution.state] > RESOLUTION_SEVERITY[worst.state]) {
            worst = { state: resolution.state, gate: id, changedSince: resolution.changedSince ?? [] };
        }
    }

    return { state: worst.state, gate: worst.gate, gates: details, changedSince: worst.changedSince };
}

export function describeResolution(resolution) {
    if (!resolution) {
        return "";
    }

    const gate = resolution.gate ? ` (${resolution.gate})` : "";
    if (resolution.state === "proven") {
        return `verified${gate}`;
    }

    if (resolution.state === "stale") {
        // This string is rendered into the challenge Markdown, so a path needs the backtick-escaping label rather
        // than the plain control-character sanitizer: a backtick alone would open an inline code span around it.
        const paths = resolution.changedSince.map((item) => markdownPathLabel(item)).join(", ");

        return `stale${gate}${paths ? `; changed since: ${paths}` : ""}`;
    }

    if (resolution.state === "failed") {
        return `failed${gate}`;
    }

    if (resolution.state === "uncited") {
        return "no gate cited";
    }

    if (resolution.state === "unavailable") {
        return `never run${gate}`;
    }

    return `indeterminate${gate}`;
}
