/** Only code-owned diagnostics may cross the delegation UI/model boundary. */
export class DelegationError extends Error {}

const workerStages = new Map(
    Object.entries({
        setup: "Worker session setup failed; check Pi provider configuration.",
        provider: "Worker provider request failed; raw provider details were withheld.",
        stream: "Worker response stream failed validation or exceeded its retained-response allowance.",
        context: "Worker request exceeded its context allowance or could not be serialized.",
        response: "Worker provider response exceeded its retained-response allowance or was invalid.",
        tool: "Worker source-tool request failed; check the selected source IDs and tool argument limits.",
        policy: "Worker requested an unavailable tool or changed its inference policy.",
        lease: "Worker lease was cancelled or expired; check the original deadline and current model/Guard state.",
        incomplete: "Worker provider returned no complete assistant response.",
        output: "Worker hit the provider output-token limit before completing its report; narrow the review or reduce thinking effort.",
        empty: "Worker returned no report text.",
        json: "Worker report was not valid JSON; the follow-up must request only the required JSON object without Markdown fences.",
        result: "Worker report failed schema or evidence validation.",
        size: "Worker report exceeded the final-result byte allowance; request a shorter report.",
    }),
);
const workerDetails = new Set([
    "Invalid closed delegation object",
    "Invalid delegation text",
    "Invalid delegation identifier",
    "Invalid delegation list",
    "Invalid delegation integer",
    "Invalid worker result size or status",
    "Worker referenced an unknown source",
    "Worker requirement coverage is invalid",
    "Worker must cover each requirement exactly once",
    "Invalid finding confidence",
    "Observed findings require a source reference",
    "Worker finding identifiers must be unique",
    "Source is not selected for this job",
    "Snapshot read request rejected.",
    "Snapshot search request rejected.",
    "Snapshot search scope rejected.",
    "Snapshot line exceeds response quota.",
    "Snapshot source changed.",
    "Snapshot source unavailable or changed.",
    "Snapshot path binding changed.",
    "Snapshot closed.",
]);
const workerMessages = new WeakMap();

// Retain only fixed diagnostics, never an SDK cause, stack, response, or arbitrary message.
export function workerFailure(stage, error) {
    if (workerMessages.has(error)) {
        return error;
    }

    const detail =
        error instanceof DelegationError && workerDetails.has(error.message)
            ? ` ${error.message.replace(/\.$/u, "")}.`
            : "";
    const message = (workerStages.get(stage) ?? "Worker failed; no safe diagnostic was available.") + detail;
    const failure = new DelegationError(message);
    workerMessages.set(failure, message);

    return failure;
}

export function workerFailureMessage(error) {
    return workerMessages.get(error) ?? "Worker failed; no safe diagnostic was available.";
}

export function publicErrorMessage(error) {
    return error instanceof DelegationError
        ? error.message
        : "Delegation operation failed. Retry after checking Pi configuration.";
}
