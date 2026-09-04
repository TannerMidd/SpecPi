import { markdownPathLabel } from "./task-contract.mjs";

const MAX_REQUIREMENTS = 16;
const MAX_LIST = 12;
const MAX_REQUIREMENT_ID = 120;

function compact(value, maximum = 360) {
    return String(value ?? "")
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maximum);
}

function textList(value, name) {
    if (!Array.isArray(value) || value.length > MAX_LIST) {
        throw new Error(`${name} must contain at most ${MAX_LIST} items`);
    }

    return value.map((item) => compact(item)).filter(Boolean);
}

function boundedRequirementId(value) {
    return compact(value, MAX_REQUIREMENT_ID);
}

function boundedPath(value) {
    return typeof value === "string" ? value.slice(0, 240) : "";
}

function boundedTaskContract(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const requirements = Array.isArray(value.requirements)
        ? value.requirements
              .map((item) => ({
                  id: boundedRequirementId(item?.id),
                  description: compact(item?.description, 360),
                  acceptance: compact(item?.acceptance, 600),
              }))
              .filter((item) => item.id && item.description && item.acceptance)
              .slice(0, MAX_REQUIREMENTS)
        : [];
    if (requirements.length === 0) {
        return undefined;
    }

    return {
        id: compact(value.id, 120),
        digest: compact(value.digest, 64),
        origin: compact(value.origin, 24),
        objective: compact(value.objective, 600),
        hypothesis: compact(value.hypothesis, 600),
        requirements,
        paths: Array.isArray(value.paths)
            ? value.paths
                  .map((item) => compact(item, 240))
                  .filter(Boolean)
                  .slice(0, 40)
            : [],
        rollback: compact(value.rollback, 600),
        nonGoals: Array.isArray(value.nonGoals)
            ? value.nonGoals
                  .map((item) => compact(item, 360))
                  .filter(Boolean)
                  .slice(0, 16)
            : [],
    };
}

function contractRequirements(facts) {
    const contract = boundedTaskContract(facts?.taskContract);
    if (!contract) {
        return undefined;
    }

    return contract.requirements;
}

export function validateChallengeSubmission(value, facts = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Completion challenge submission is malformed");
    }

    if (facts.challengeGeneration && value.generation !== facts.challengeGeneration) {
        throw new Error("Completion challenge generation is stale");
    }

    if (facts.taskContractDigest && value.taskContractDigest && value.taskContractDigest !== facts.taskContractDigest) {
        throw new Error("Task contract digest is stale");
    }

    const verdicts = new Set(["ready-for-human-review", "incomplete", "blocked"]);
    if (!verdicts.has(value.verdict)) {
        throw new Error("Completion challenge verdict is invalid");
    }

    if (
        !Array.isArray(value.requirements) ||
        value.requirements.length === 0 ||
        value.requirements.length > MAX_REQUIREMENTS
    ) {
        throw new Error(`Completion challenge requires 1-${MAX_REQUIREMENTS} requirement assessments`);
    }

    const expectedRequirements = contractRequirements(facts);
    const requirements = value.requirements.map((item) => {
        const id = boundedRequirementId(item?.id);
        const expected = expectedRequirements?.find((candidate) => candidate.id === id);
        if (expectedRequirements) {
            if (!id) {
                throw new Error("Task contract requirement assessment must include its original ID");
            }

            if (!expected) {
                throw new Error(`Unknown task contract requirement ID: ${id}`);
            }
        }

        const requirement = compact(item?.requirement) || expected?.description || "";
        const evidence = compact(item?.evidence, 600);
        if (!requirement || !["proven", "partial", "unproven"].includes(item?.status)) {
            throw new Error("Completion challenge requirement assessment is invalid");
        }

        if (expected && requirement !== expected.description) {
            throw new Error(`Task contract requirement ${id} text was altered`);
        }

        if (item.status === "proven" && !evidence) {
            throw new Error("A proven requirement must cite concise evidence");
        }

        return {
            ...(expectedRequirements ? { id, acceptance: expected.acceptance } : {}),
            requirement,
            status: item.status,
            evidence,
        };
    });
    if (expectedRequirements) {
        const submittedIds = requirements.map((item) => item.id);
        if (new Set(submittedIds).size !== submittedIds.length) {
            throw new Error("Task contract requirement IDs must be unique");
        }

        const expectedIds = expectedRequirements.map((item) => item.id);
        if (submittedIds.length !== expectedIds.length || expectedIds.some((id) => !submittedIds.includes(id))) {
            throw new Error("Task contract requirement assessments must cover the exact original IDs");
        }

        requirements.sort((left, right) => expectedIds.indexOf(left.id) - expectedIds.indexOf(right.id));
    }

    const contradictions = textList(value.contradictions, "contradictions");
    const falsePositiveChecks = textList(value.falsePositiveChecks, "falsePositiveChecks");
    const scopeFindings = textList(value.scopeFindings, "scopeFindings");
    const validationGaps = textList(value.validationGaps, "validationGaps");
    const residualRisks = textList(value.residualRisks, "residualRisks");
    const nextAction = compact(value.nextAction, 500);

    if (value.verdict !== "ready-for-human-review" && !nextAction) {
        throw new Error("Incomplete and blocked challenges require a concrete next action");
    }

    if (value.verdict === "ready-for-human-review") {
        const unresolved = requirements.some((item) => item.status !== "proven");
        if (unresolved) {
            throw new Error("Ready verdict rejected: one or more requirements remain unresolved");
        }

        if (contradictions.length > 0) {
            throw new Error("Ready verdict rejected: contradictory evidence remains");
        }

        if (validationGaps.length > 0) {
            throw new Error("Ready verdict rejected: validation gaps remain");
        }

        if (Array.isArray(facts.pendingScope) && facts.pendingScope.length > 0) {
            throw new Error("Ready verdict rejected: scope drift remains pending");
        }

        if (facts.scopeTaskStale === true) {
            throw new Error("Ready verdict rejected: task-bound scope is stale");
        }

        // An indeterminate snapshot means the facts the review was handed may be incomplete. It is a permanent
        // condition outside a Git worktree, so rejecting outright would make a ready verdict unreachable there;
        // instead the limitation must be disclosed rather than silently dropped.
        if (facts.snapshotIndeterminate === true && residualRisks.length === 0) {
            throw new Error(
                "Ready verdict rejected: the change snapshot was indeterminate, so the residual risk of unobserved changes must be disclosed",
            );
        }
    }

    return {
        verdict: value.verdict,
        requirements,
        contradictions,
        falsePositiveChecks,
        scopeFindings,
        validationGaps,
        residualRisks,
        nextAction,
    };
}

export function boundedChallengeFacts(value = {}) {
    const paths = (items) => (Array.isArray(items) ? items.map(boundedPath).filter(Boolean).slice(0, 40) : []);

    const taskContract = boundedTaskContract(value.taskContract);
    const taskContractDigest = value.taskContractDigest ?? taskContract?.digest;
    const challengeGeneration = value.challengeGeneration;

    return {
        changedPaths: paths(value.changedPaths),
        scopeEntries: paths(value.scopeEntries),
        pendingScope: paths(value.pendingScope),
        experiment: value.experiment
            ? {
                  id: compact(value.experiment.id, 36),
                  name: compact(value.experiment.name, 48),
                  acceptance: compact(value.experiment.acceptance, 600),
                  baseCommit: compact(value.experiment.baseCommit, 64),
              }
            : undefined,
        observedToolFailures: Math.max(0, Math.min(99, Number(value.observedToolFailures) || 0)),
        snapshotIndeterminate: Boolean(value.snapshotIndeterminate),
        taskContract,
        taskContractDigest: taskContractDigest ? compact(taskContractDigest, 64) : undefined,
        challengeGeneration: challengeGeneration ? compact(challengeGeneration, 64) : undefined,
        scopeTaskStale: Boolean(value.scopeTaskStale),
    };
}

export function challengePrompt(generation, facts) {
    const bounded = boundedChallengeFacts(facts);
    const lines = [
        `[SPECPI COMPLETION CHALLENGE ${generation}]`,
        "The user explicitly requested an adversarial completion review. Do not continue implementation in this turn.",
        "Use only evidence already available in context and the bounded facts below. Identify uncertainty rather than inventing proof.",
        "Answer all six questions through submit_completion_challenge as the final tool call:",
        "1. Which requirement remains unproven?",
        "2. What evidence contradicts the proposed result?",
        "3. Could any check have passed for the wrong reason?",
        "4. Did scope expand or remain pending?",
        "5. Was runtime, visual, or platform validation required but omitted?",
        "6. What residual risk must be disclosed?",
        "",
        `Changed paths: ${bounded.changedPaths.map(markdownPathLabel).join(", ") || "none observed"}`,
        `Declared scope: ${bounded.scopeEntries.map(markdownPathLabel).join(", ") || "inactive"}`,
        `Pending scope drift: ${bounded.pendingScope.map(markdownPathLabel).join(", ") || "none"}`,
        `Observed tool failures: ${bounded.observedToolFailures}`,
        `Snapshot indeterminate: ${bounded.snapshotIndeterminate ? "yes" : "no"}`,
        `Task-bound scope: ${bounded.scopeTaskStale ? "stale" : "not stale or not bound"}`,
    ];
    if (bounded.taskContract) {
        lines.push(
            `Task contract: ${bounded.taskContract.id} (digest ${bounded.taskContract.digest})`,
            "The task contract requirements are fixed. Use every original requirement ID exactly once and do not rewrite requirement text.",
            "Fixed requirements:",
            ...bounded.taskContract.requirements.map(
                (item) => `- ${item.id}: ${item.description} (acceptance: ${item.acceptance})`,
            ),
        );
    }

    if (bounded.experiment) {
        lines.push(
            `Experiment: ${bounded.experiment.name} (${bounded.experiment.id.slice(0, 8)})`,
            `Experiment acceptance check: ${bounded.experiment.acceptance}`,
            `Experiment base: ${bounded.experiment.baseCommit}`,
        );
    }

    lines.push(
        "A ready-for-human-review verdict is allowed only when every listed requirement is proven, no contradiction or validation gap remains, and no scope drift is pending. When the snapshot above is indeterminate, a ready verdict must also disclose the residual risk that some changes went unobserved. This verdict is a structured model review, not independent verification or completion authority.",
    );

    return lines.join("\n");
}

export function renderChallengeMarkdown(result, metadata = {}) {
    const heading =
        result.verdict === "ready-for-human-review"
            ? "Ready for human review"
            : result.verdict === "blocked"
              ? "Blocked"
              : "Incomplete";
    const lines = [`## Completion Challenge — ${heading}`, "", `Generation: \`${metadata.generation ?? "unknown"}\``];
    lines.push("", "### Requirements");
    for (const item of result.requirements) {
        const id = item.id ? ` ${item.id}` : "";
        lines.push(`- **${item.status}**${id} — ${item.requirement}${item.evidence ? ` — ${item.evidence}` : ""}`);
    }

    const sections = [
        ["Contradictions", result.contradictions],
        ["Possible false-positive checks", result.falsePositiveChecks],
        ["Scope findings", result.scopeFindings],
        ["Validation gaps", result.validationGaps],
        ["Residual risks", result.residualRisks],
    ];
    for (const [title, items] of sections) {
        lines.push("", `### ${title}`);
        lines.push(...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- None recorded."]));
    }

    if (result.nextAction) {
        lines.push("", "### Next action", "", result.nextAction);
    }

    lines.push("", "> This is a model-authored challenge result, not independent verification.");

    return lines.join("\n");
}
