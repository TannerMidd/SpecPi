// The experiment card is plain text a human edits in Pi's editor, so parsing it is pure
// string work with no Git or filesystem access. It lives apart from the command wiring so
// it can be tested directly.

/**
 * Read `Name:`, `Hypothesis:` and `Acceptance:` fields plus a trailing `Non-goals:` list
 * out of an edited card. Missing fields are empty strings, not errors: the card is a
 * prompt, and the person may leave parts of it blank.
 */
export function parseExperimentCard(source, fallbackName) {
    // Horizontal whitespace only. `\s` also matches the line break, which let an empty
    // field run past its own line and capture the next label — a blank card recorded
    // hypothesis "Acceptance:" and acceptance "Non-goals:".
    const field = (name) =>
        String(source)
            .match(new RegExp(`^${name}:[^\\S\\r\\n]*(.+)$`, "imu"))?.[1]
            ?.trim() ?? "";
    const nonGoalsBlock = String(source).match(/^Non-goals:\s*\n([\s\S]*)$/imu)?.[1] ?? "";

    return {
        name: field("Name") || fallbackName,
        hypothesis: field("Hypothesis"),
        acceptance: field("Acceptance"),
        nonGoals: nonGoalsBlock
            .split("\n")
            .map((line) => line.replace(/^\s*-\s*/u, "").trim())
            .filter(Boolean),
    };
}

/** Prefill the editor from a task contract when one is present, or start blank. */
export function experimentCardEditorText(contract, fallbackName) {
    if (!contract) {
        return `Name: ${fallbackName}\nHypothesis: \nAcceptance: \nNon-goals:\n- `;
    }

    const acceptance = contract.requirements.map((item) => `${item.id}: ${item.acceptance}`).join("; ");
    const nonGoals = contract.nonGoals.length > 0 ? contract.nonGoals.map((item) => `- ${item}`).join("\n") : "- ";

    return [
        `Name: ${contract.objective}`,
        `Hypothesis: ${contract.hypothesis}`,
        `Acceptance: ${acceptance}`,
        "Non-goals:",
        nonGoals,
    ].join("\n");
}
