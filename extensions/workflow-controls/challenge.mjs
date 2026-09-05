const MAX_REQUIREMENTS = 16;
const MAX_LIST = 12;

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

export function validateChallengeSubmission(value, facts = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Completion challenge submission is malformed");
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

    const requirements = value.requirements.map((item) => {
        const requirement = compact(item?.requirement);
        const evidence = compact(item?.evidence, 600);
        if (!requirement || !["proven", "partial", "unproven"].includes(item?.status)) {
            throw new Error("Completion challenge requirement assessment is invalid");
        }

        if (item.status === "proven" && !evidence) {
            throw new Error("A proven requirement must cite concise evidence");
        }

        return { requirement, status: item.status, evidence };
    });
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
    const paths = (items) =>
        Array.isArray(items)
            ? items
                  .map((item) => compact(item, 240))
                  .filter(Boolean)
                  .slice(0, 40)
            : [];

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
        `Changed paths: ${bounded.changedPaths.join(", ") || "none observed"}`,
        `Declared scope: ${bounded.scopeEntries.join(", ") || "inactive"}`,
        `Pending scope drift: ${bounded.pendingScope.join(", ") || "none"}`,
        `Observed tool failures: ${bounded.observedToolFailures}`,
        `Snapshot indeterminate: ${bounded.snapshotIndeterminate ? "yes" : "no"}`,
    ];
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
        lines.push(`- **${item.status}** — ${item.requirement}${item.evidence ? ` — ${item.evidence}` : ""}`);
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
