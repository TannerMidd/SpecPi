/** Only code-owned diagnostics may cross the delegation UI/model boundary. */
export class DelegationError extends Error {}

export function publicErrorMessage(error) {
    return error instanceof DelegationError
        ? error.message
        : "Delegation operation failed. Retry after checking Pi configuration.";
}
