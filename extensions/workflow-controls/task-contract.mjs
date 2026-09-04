import { createHash, randomUUID } from "node:crypto";
import { canonicalRoot, normalizeScopeEntries, sanitizePathLabel, scopeMatches } from "./scope.mjs";

export const TASK_CONTRACT_ENTRY = "specpi-task-contract";
export const TASK_CONTRACT_SCHEMA = 1;
export const MAX_TASK_REQUIREMENTS = 16;
export const MAX_TASK_PATHS = 40;
export const MAX_TASK_NON_GOALS = 16;

const MAX_PATH_LENGTH = 240;
const MAX_OBJECTIVE_LENGTH = 600;
const MAX_HYPOTHESIS_LENGTH = 600;
const MAX_REQUIREMENT_DESCRIPTION_LENGTH = 360;
const MAX_REQUIREMENT_ACCEPTANCE_LENGTH = 600;
const MAX_ROLLBACK_LENGTH = 600;
const MAX_NON_GOAL_LENGTH = 360;

function assertRecord(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}

function plainText(value, label, maximum, { required = true } = {}) {
    if (typeof value !== "string") {
        if (!required && (value === undefined || value === null)) {
            return "";
        }

        throw new Error(`${label} must be text`);
    }

    const normalized = value
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum);
    if (required && !normalized) {
        throw new Error(`${label} must not be empty`);
    }

    return normalized;
}

function stableId(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value)) {
        throw new Error(`${label} must be a bounded identifier`);
    }

    return value;
}

function requirementId(value) {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(value)) {
        throw new Error("Requirement ID must be a bounded identifier");
    }

    return value;
}

function optionalStableId(value, label) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    return stableId(value, label);
}

function normalizeTaskPaths(root, values, { required, improvement }) {
    if (!Array.isArray(values)) {
        throw new Error("Task contract paths must be an array");
    }

    if (values.length > MAX_TASK_PATHS) {
        throw new Error(`Task contract supports at most ${MAX_TASK_PATHS} paths`);
    }

    if (values.length === 0) {
        if (required) {
            throw new Error("Improvement task contracts require at least one path");
        }

        return [];
    }

    const inputs = values.map((value, index) => {
        if (
            typeof value !== "string" ||
            !value.trim() ||
            value.trim().length > MAX_PATH_LENGTH ||
            /[\u0000-\u001f\u007f]/u.test(value)
        ) {
            throw new Error(`Task contract path ${index + 1} must be non-empty text without controls`);
        }

        return value.trim();
    });
    const entries = normalizeScopeEntries(root, inputs);
    if (!improvement) {
        return entries.map((entry) => `${entry.path}${entry.directory ? "/" : ""}`);
    }

    for (const entry of entries) {
        if (entry.path === ".") {
            throw new Error("Improvement task contracts cannot declare the project root");
        }

        if (entry.directory && entry.path.split("/").length === 1) {
            throw new Error("Improvement task contracts require specific files or subsystem directories");
        }
    }

    return entries.map((entry) => `${entry.path}${entry.directory ? "/" : ""}`);
}

function normalizeRequirements(values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_TASK_REQUIREMENTS) {
        throw new Error(`Task contract requires 1-${MAX_TASK_REQUIREMENTS} requirements`);
    }

    const seen = new Set();

    return values.map((value, index) => {
        assertRecord(value, `Task contract requirement ${index + 1}`);
        const id =
            value.id === undefined || value.id === null || value.id === "" ? `R${index + 1}` : requirementId(value.id);
        if (seen.has(id)) {
            throw new Error(`Task contract requirement ID is duplicated: ${id}`);
        }

        seen.add(id);

        return {
            id,
            description: plainText(
                value.description,
                `Task contract requirement ${id} description`,
                MAX_REQUIREMENT_DESCRIPTION_LENGTH,
            ),
            acceptance: plainText(
                value.acceptance,
                `Task contract requirement ${id} acceptance`,
                MAX_REQUIREMENT_ACCEPTANCE_LENGTH,
            ),
        };
    });
}

function normalizeNonGoals(values) {
    if (values === undefined || values === null) {
        return [];
    }

    if (!Array.isArray(values) || values.length > MAX_TASK_NON_GOALS) {
        throw new Error(`Task contract supports at most ${MAX_TASK_NON_GOALS} non-goals`);
    }

    return values
        .map((value, index) => plainText(value, `Task contract non-goal ${index + 1}`, MAX_NON_GOAL_LENGTH))
        .filter(Boolean);
}

function contractPayload(contract) {
    const payload = {
        schema: TASK_CONTRACT_SCHEMA,
        id: contract.id,
        root: contract.root,
        origin: contract.origin,
        objective: contract.objective,
        hypothesis: contract.hypothesis,
        requirements: contract.requirements.map((item) => ({
            id: item.id,
            description: item.description,
            acceptance: item.acceptance,
        })),
        paths: [...contract.paths],
        rollback: contract.rollback,
        nonGoals: [...contract.nonGoals],
    };
    if (contract.gapId !== undefined) {
        payload.gapId = contract.gapId;
    }

    if (contract.selectionId !== undefined) {
        payload.selectionId = contract.selectionId;
    }

    return payload;
}

function digestPayload(payload) {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function cloneContract(contract) {
    const clone = {
        ...contract,
        requirements: contract.requirements.map((item) => ({ ...item })),
        paths: [...contract.paths],
        nonGoals: [...contract.nonGoals],
    };
    if (contract.gapId === undefined) {
        delete clone.gapId;
    }

    if (contract.selectionId === undefined) {
        delete clone.selectionId;
    }

    return clone;
}

function normalizeContractInput(input, options = {}) {
    assertRecord(input, "Task contract");
    const origin = options.origin;
    if (origin !== "human" && origin !== "improvement") {
        throw new Error("Task contract origin must be human or improvement");
    }

    if (typeof options.root !== "string" || !options.root.trim()) {
        throw new Error("Task contract root is required");
    }

    const root = canonicalRoot(options.root);
    const id = stableId(options.id ?? input.id ?? randomUUID(), "Task contract ID");
    const gapId = optionalStableId(options.gapId ?? input.gapId, "Task contract gap ID");
    const selectionId = optionalStableId(options.selectionId ?? input.selectionId, "Task contract selection ID");
    if (origin === "improvement" && (!gapId || !selectionId)) {
        throw new Error("Improvement task contracts require gapId and selectionId");
    }

    if (origin === "human" && (gapId !== undefined || selectionId !== undefined)) {
        throw new Error("Human task contracts cannot carry improvement selection metadata");
    }

    const payload = {
        schema: TASK_CONTRACT_SCHEMA,
        id,
        root,
        origin,
        objective: plainText(input.objective, "Task contract objective", MAX_OBJECTIVE_LENGTH),
        hypothesis: plainText(input.hypothesis, "Task contract hypothesis", MAX_HYPOTHESIS_LENGTH, {
            required: origin === "improvement",
        }),
        requirements: normalizeRequirements(input.requirements),
        paths: normalizeTaskPaths(root, input.paths ?? [], {
            required: origin === "improvement",
            improvement: origin === "improvement",
        }),
        rollback: plainText(input.rollback, "Task contract rollback", MAX_ROLLBACK_LENGTH, {
            required: origin === "improvement",
        }),
        nonGoals: normalizeNonGoals(input.nonGoals),
    };
    if (gapId !== undefined) {
        payload.gapId = gapId;
    }

    if (selectionId !== undefined) {
        payload.selectionId = selectionId;
    }

    return payload;
}

export function createTaskContract(input, options = {}) {
    const payload = normalizeContractInput(input, options);

    return {
        ...payload,
        digest: digestPayload(contractPayload(payload)),
    };
}

export function validateTaskContract(contract) {
    assertRecord(contract, "Task contract");
    if (contract.schema !== TASK_CONTRACT_SCHEMA) {
        throw new Error("Unsupported task contract schema");
    }

    if (typeof contract.digest !== "string" || !/^[a-f0-9]{64}$/u.test(contract.digest)) {
        throw new Error("Task contract digest is malformed");
    }

    const payload = normalizeContractInput(contract, {
        root: contract.root,
        origin: contract.origin,
        gapId: contract.gapId,
        selectionId: contract.selectionId,
        id: contract.id,
    });
    const expectedDigest = digestPayload(contractPayload(payload));
    if (contract.digest !== expectedDigest) {
        throw new Error("Task contract digest mismatch");
    }

    return cloneContract({ ...payload, digest: expectedDigest });
}

export function readTaskContract(entries, root) {
    if (!Array.isArray(entries)) {
        throw new Error("Task contract branch must be an array");
    }

    let latest;
    let hasEntry = false;
    for (const entry of entries) {
        if (entry?.type !== "custom" || entry.customType !== TASK_CONTRACT_ENTRY) {
            continue;
        }

        latest = entry.data;
        hasEntry = true;
    }

    if (!hasEntry) {
        return undefined;
    }

    if (latest?.kind === "cleared") {
        return undefined;
    }

    if (latest?.kind !== "set") {
        throw new Error("Malformed task contract branch entry");
    }

    const contract = validateTaskContract(latest.contract);
    const requestedRoot = canonicalRoot(root);
    if (contract.root !== requestedRoot) {
        return undefined;
    }

    return contract;
}

export function taskContractScopeViolations(contract, relativePaths) {
    const validated = validateTaskContract(contract);
    if (!Array.isArray(relativePaths)) {
        throw new Error("Task contract changed paths must be an array");
    }

    const entries = validated.paths.length > 0 ? normalizeScopeEntries(validated.root, validated.paths) : [];
    const violations = new Set();
    for (const value of relativePaths) {
        if (typeof value !== "string") {
            throw new Error("Task contract changed paths must contain text");
        }

        const normalized = value.replaceAll("\\", "/");
        const outsideRoot =
            normalized === ".." ||
            normalized.startsWith("../") ||
            normalized.startsWith("/") ||
            /^[A-Za-z]:\//u.test(normalized);
        if (outsideRoot || !scopeMatches(entries, normalized)) {
            violations.add(normalized);
        }
    }

    return [...violations].sort();
}

function markdownText(value) {
    return String(value).replaceAll("`", "\\`");
}

// Canonical paths stay raw for matching and persistence. This helper is only for Markdown or editor display: the
// existing scope sanitizer percent-escapes controls, format characters, separators, and literal percent signs;
// Markdown backticks need the same treatment so a hostile path cannot open an inline code span.
export function markdownPathLabel(value) {
    return sanitizePathLabel(value).replaceAll("`", "%60");
}

export function renderTaskContract(contract) {
    const validated = validateTaskContract(contract);
    const lines = [
        "## Task Contract",
        "",
        `ID: \`${validated.id}\``,
        `Origin: \`${validated.origin}\``,
        `Root: \`${markdownPathLabel(validated.root)}\``,
        `Digest: \`${validated.digest}\``,
        "",
        "### Objective",
        "",
        markdownText(validated.objective),
    ];
    if (validated.hypothesis) {
        lines.push("", "### Hypothesis", "", markdownText(validated.hypothesis));
    }

    lines.push("", `### Requirements (${validated.requirements.length})`);
    for (const requirement of validated.requirements) {
        lines.push(
            `- **${markdownText(requirement.id)}** — ${markdownText(requirement.description)}`,
            `  - Acceptance: ${markdownText(requirement.acceptance)}`,
        );
    }

    lines.push("", "### Paths");
    lines.push(
        ...(validated.paths.length > 0
            ? validated.paths.map((value) => `- \`${markdownPathLabel(value)}\``)
            : ["- None declared."]),
    );
    lines.push("", "### Rollback", "", markdownText(validated.rollback || "No rollback recorded."));
    lines.push("", "### Non-goals");
    lines.push(
        ...(validated.nonGoals.length > 0
            ? validated.nonGoals.map((value) => `- ${markdownText(value)}`)
            : ["- None recorded."]),
    );
    if (validated.gapId !== undefined || validated.selectionId !== undefined) {
        lines.push(
            "",
            "### Improvement provenance",
            "",
            `- Gap: \`${markdownText(validated.gapId ?? "unknown")}\``,
            `- Selection: \`${markdownText(validated.selectionId ?? "unknown")}\``,
        );
    }

    return lines.join("\n");
}
