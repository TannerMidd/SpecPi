// Local triage for shell and file calls, before anything is sent anywhere.
//
// This is the first half of the native command guard. It answers, from the call alone and with no
// network, which of three things a tool call is:
//
//   safe      -- a read-only command with no way to chain into something else. Passes untouched,
//                costing nothing. Most calls in a session land here, which is what keeps the guard
//                from spending a budget on `ls`.
//   dangerous -- catastrophic and unambiguous. Blocked here, so the one case where a network round
//                trip is least affordable is the one case that does not need one.
//   unknown   -- everything else, which is where Jev is asked.
//
// Two principles, both learned the hard way from the package this replaces.
//
// The dangerous list is deliberately tiny. A regex that blocks real work is worse than no regex,
// because the person then turns the whole guard off and keeps none of it. Anything that needs
// judgement is `unknown` and goes to a model that can weigh intent, rather than to a pattern that
// cannot. If you are tempted to add a rule here, ask whether you would stake "this is never
// legitimate" on it; if not, it belongs in the question set instead.
//
// And nothing here throws. A classifier that can fail is a classifier that can take a session down,
// so an unparseable command reads as `unknown` -- ask about it -- rather than as an error.

import path from "node:path";

/** The tool calls this guard looks at. Everything else passes without inspection. */
export const GATED_TOOLS = Object.freeze(["bash", "powershell", "write", "edit"]);

/**
 * Read-only binaries that cannot modify state on their own. The bar is "running this with any
 * arguments still changes nothing", which is why `git` is absent (it has `push`, `reset`, `clean`)
 * and `git status` is not special-cased -- a subcommand allowlist is a second policy to maintain.
 */
const READ_ONLY = new Set([
    "ls",
    "dir",
    "pwd",
    "cd",
    "cat",
    "head",
    "tail",
    "wc",
    "file",
    "stat",
    "du",
    "df",
    "date",
    "whoami",
    "hostname",
    "uname",
    "echo",
    "printf",
    "which",
    "type",
    "env",
    "printenv",
    "grep",
    "rg",
    "find",
    "fd",
    "diff",
    "sort",
    "uniq",
    "cut",
    "tr",
    "basename",
    "dirname",
    "realpath",
    "true",
    "false",
]);

/**
 * Shell syntax that can turn a safe-looking command into any other command: chaining, substitution,
 * redirection, background execution. Their presence disqualifies the fast path entirely rather than
 * being parsed, because parsing a shell correctly is not something a guard should be attempting.
 */
const SHELL_CONTROL = /[;&|><`$(){}\n\r]|\|\||&&/u;

/**
 * Catastrophic and unambiguous. Every entry here is something that destroys data or hands the
 * machine to someone else, with no legitimate reading in an agent session.
 *
 * Kept short on purpose. These fire without a model and without a human, so a false positive here
 * is a blocked session with no recourse but switching the guard off -- and a guard people switch
 * off protects nobody. Everything requiring judgement is `unknown`.
 */
const CATASTROPHIC = Object.freeze([
    {
        // `rm -rf /`, `rm -rf /*`, and the same against a bare home. Not `rm -rf ./build`.
        pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(\/|\/\*|~|\$HOME)\s*$/u,
        reason: "recursive delete of the filesystem root or home directory",
    },
    {
        // Writing a raw block device: mkfs, or dd with a device destination.
        pattern: /\b(mkfs(\.\w+)?|fdisk|diskpart)\b|\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk)/u,
        reason: "writing directly to a disk device",
    },
    {
        // Piping a downloaded script straight into a shell.
        pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|fi|da)?sh\b/u,
        reason: "executing a downloaded script without inspecting it",
    },
    {
        // Recursive world-writable or ownership changes over a filesystem root.
        pattern:
            /\bchmod\s+(-[a-zA-Z]*\s+)*(-R|--recursive)\s+777\s+\/\s*$|\bchown\s+(-R|--recursive)\s+[^\s]+\s+\/\s*$/u,
        reason: "recursive permission or ownership change over the filesystem root",
    },
    {
        pattern: /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/u,
        reason: "fork bomb",
    },
    {
        // Overwriting the shell history or a credential store with nothing is how a session hides
        // what it did; blocking it is cheap and it is never a legitimate agent action.
        pattern: /\b(history\s+-c|Clear-History)\b|>\s*~?\/?\.bash_history\b/u,
        reason: "clearing shell history",
    },
]);

/** Paths whose contents are credentials, keys or version-control internals. */
const PROTECTED = Object.freeze([
    /(^|[/\\])\.env(\.|$)/u,
    /(^|[/\\])\.git([/\\]|$)/u,
    /(^|[/\\])\.ssh([/\\]|$)/u,
    /(^|[/\\])\.aws([/\\]|$)/u,
    /(^|[/\\])(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/u,
    /\.(pem|key|pfx|p12|keystore|jks)$/iu,
    /(^|[/\\])(credentials?|secrets?)(\.|$)/iu,
    /(^|[/\\])auth\.json$/u,
    /(^|[/\\])\.npmrc$/u,
    /(^|[/\\])\.netrc$/u,
]);

function text(value) {
    return typeof value === "string" ? value : "";
}

/** The binary a command starts with, lowercased and stripped of any path. */
export function leadingBinary(command) {
    const trimmed = text(command).trim();
    if (trimmed.length === 0) {
        return "";
    }

    const first = trimmed.split(/\s+/u)[0];

    return path.basename(first.replace(/\\/gu, "/")).toLowerCase();
}

/**
 * Classify a shell command without asking anyone.
 *
 * Returns `{ decision, reason }` where decision is "safe", "dangerous" or "unknown". The order
 * matters: dangerous is checked before safe, so a catastrophic command hidden behind a read-only
 * binary cannot pass on the fast path.
 */
export function classifyCommand(command) {
    const value = text(command).trim();
    if (value.length === 0) {
        return { decision: "unknown", reason: "empty command" };
    }

    for (const rule of CATASTROPHIC) {
        if (rule.pattern.test(value)) {
            return { decision: "dangerous", reason: rule.reason };
        }
    }

    // A command with shell control characters is never taken on the fast path, however harmless its
    // first word looks: `ls; rm -rf ~` begins with `ls`.
    if (SHELL_CONTROL.test(value)) {
        return { decision: "unknown", reason: "shell control characters" };
    }

    if (READ_ONLY.has(leadingBinary(value))) {
        return { decision: "safe", reason: "read-only command" };
    }

    return { decision: "unknown", reason: "not a known read-only command" };
}

/**
 * Whether a write or edit target holds credentials or version-control internals.
 *
 * Relative targets are resolved against the working directory first, so `../../.ssh/config` is seen
 * for what it is rather than for what it is spelled as.
 */
export function protectedPath(target, cwd = process.cwd()) {
    const value = text(target).trim();
    if (value.length === 0) {
        return false;
    }

    let resolved;
    try {
        resolved = path.resolve(cwd, value);
    } catch {
        resolved = value;
    }

    const normalized = resolved.replaceAll("\\", "/");

    return PROTECTED.some((pattern) => pattern.test(normalized));
}

/**
 * What a gated tool call is, before Jev is involved.
 *
 * `write` and `edit` are only interesting when they target something protected: an ordinary source
 * file being edited is the entire point of the agent, and asking about each one would spend a
 * session's budget on the first directory it refactored.
 */
export function classifyCall({ tool, command, target, cwd }) {
    if (!GATED_TOOLS.includes(tool)) {
        return { decision: "safe", reason: "tool is not gated" };
    }

    if (tool === "bash" || tool === "powershell") {
        return classifyCommand(command);
    }

    return protectedPath(target, cwd)
        ? { decision: "unknown", reason: "writes to a protected path" }
        : { decision: "safe", reason: "ordinary project file" };
}
