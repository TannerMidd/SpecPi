const COMMAND_GUARD_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const COMMAND_GUARD_MANAGED_FILES = Object.freeze([
    "index.ts",
    "core.mjs",
    "rules.mjs",
    "bash.mjs",
    "powershell.mjs",
    "powershell-parser.ps1",
    "cmd.mjs",
    "paths.mjs",
    "redact.mjs",
    "smoke.mjs",
    "managed-files.mjs",
]);

if (
    new Set(COMMAND_GUARD_MANAGED_FILES).size !== COMMAND_GUARD_MANAGED_FILES.length ||
    COMMAND_GUARD_MANAGED_FILES.some((name) => !COMMAND_GUARD_FILE_PATTERN.test(name))
) {
    throw new Error("The command-guard managed-file inventory is malformed.");
}
