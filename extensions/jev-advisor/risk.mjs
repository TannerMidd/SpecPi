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

/**
 * Shell tools, under every name a harness gives them.
 *
 * `scripts/eval-proxy.mjs` already folds `pwsh`, `shell`, `exec`, `exec_command` and `write_stdin`
 * into `bash`, which means those names reach real sessions. A guard that only knew `bash` would be
 * bypassed by spelling, so the alias list lives here rather than being rediscovered later.
 */
export const SHELL_TOOLS = Object.freeze([
    "bash",
    "powershell",
    "pwsh",
    "shell",
    "exec",
    "exec_command",
    "write_stdin",
]);

/**
 * Tools that write a file. The same list `questions/progress.mjs` uses for "the worktree changed",
 * deliberately, because a write the guard cannot see is a write the credential question is never
 * asked about -- and `multi_edit` reaching `~/.ssh/authorized_keys` is exactly that.
 */
export const WRITE_TOOLS = Object.freeze(["write", "edit", "multi_edit", "apply_patch", "create_file", "str_replace"]);

/** The tool calls this guard looks at. Everything else passes without inspection. */
export const GATED_TOOLS = Object.freeze([...SHELL_TOOLS, ...WRITE_TOOLS]);

/**
 * Read-only binaries that cannot modify state on their own. The bar is "running this with any
 * arguments still changes nothing", which is why `git` is absent (it has `push`, `reset`, `clean`)
 * and `git status` is not special-cased -- a subcommand allowlist is a second policy to maintain.
 *
 * The bar is strict enough to exclude several binaries that read as read-only. `env` and `fd` launch
 * other programs (`env rm -rf build`, `fd -x rm`); `find` has `-delete` and `-exec`; `sort -o` and
 * `uniq in out` name an output file. None of them changes state when used the way its name suggests,
 * which is precisely what would have made each one a reliable bypass.
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
    "printenv",
    "grep",
    "rg",
    "diff",
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

/**
 * Paths whose contents are credentials, keys or version-control internals.
 *
 * Every pattern is tested against a path already resolved against the working directory and written
 * with forward slashes, so a segment is bounded by `/` or by the end of the string. Matching a
 * directory matters as much as matching a file: `secrets/api.txt` is a secret, and the first version
 * of this list -- which required the secret's name to be the last segment -- called it an ordinary
 * project file.
 */
const PROTECTED = Object.freeze([
    /(^|\/)\.env(\.|\/|$)/u,
    /\.env$/u,
    /(^|\/)\.git(\/|$)/u,
    /(^|\/)\.ssh(\/|$)/u,
    /(^|\/)\.aws(\/|$)/u,
    /(^|\/)\.gnupg(\/|$)/u,
    /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/u,
    /\.(pem|key|pfx|p12|keystore|jks)$/iu,
    /(^|\/)(credentials?|secrets?)(\.|\/|$)/iu,
    /(^|\/)auth\.json$/u,
    /(^|\/)\.npmrc$/u,
    /(^|\/)\.netrc$/u,
    /(^|\/)\.pi(\/|$)/u,
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

/** Keys a harness uses for "the file this call writes", across the tools in `WRITE_TOOLS`. */
const TARGET_KEYS = Object.freeze(["path", "file_path", "filePath", "file", "target", "notebook_path"]);

/** Nested arrays of edits, each element carrying a target of its own. */
const TARGET_LISTS = Object.freeze(["edits", "files", "changes", "operations"]);

/** Header forms that name a file inside a patch body. */
const PATCH_TARGET = /^(?:\*\*\* (?:Add|Update|Delete) File: |--- (?:a\/)?|\+\+\+ (?:b\/)?)(.+)$/gmu;

function pushTarget(into, value) {
    if (typeof value === "string" && value.trim().length > 0 && into.length < 64) {
        into.push(value.trim());
    }
}

/**
 * Every file a tool call names, from a tool input whose shape this module does not control.
 *
 * `write` and `edit` carry one `path`; `multi_edit` carries a list; `apply_patch` carries the paths
 * inside a patch body and nowhere else. Reading only the first of those is how a write to a
 * credential file reaches disk without the guard ever seeing a target -- so this reads all three,
 * and returning nothing is itself a meaningful answer to `classifyCall`.
 */
export function callTargets(input) {
    const found = [];
    if (input === null || typeof input !== "object") {
        return found;
    }

    for (const key of TARGET_KEYS) {
        pushTarget(found, input[key]);
    }

    for (const key of TARGET_LISTS) {
        const list = input[key];
        if (!Array.isArray(list)) {
            continue;
        }

        for (const item of list) {
            if (typeof item === "string") {
                pushTarget(found, item);
                continue;
            }

            if (item !== null && typeof item === "object") {
                for (const key2 of TARGET_KEYS) {
                    pushTarget(found, item[key2]);
                }
            }
        }
    }

    const patch = typeof input.patch === "string" ? input.patch : typeof input.diff === "string" ? input.diff : "";
    if (patch.length > 0) {
        // Bounded: a patch is arbitrary size and this runs on every call.
        for (const match of patch.slice(0, 20_000).matchAll(PATCH_TARGET)) {
            pushTarget(found, match[1].replace(/\t.*$/u, ""));
        }
    }

    return found;
}

/**
 * What a gated tool call is, before Jev is involved.
 *
 * `write` and its siblings are only interesting when they target something protected: an ordinary
 * source file being edited is the entire point of the agent, and asking about each one would spend a
 * session's budget on the first directory it refactored.
 *
 * A write whose target could not be read is `unknown` rather than `safe`. That costs a question on a
 * tool shape this module does not recognise, which is the right way round: the alternative is a
 * silent hole that appears the moment a harness renames a field.
 */
export function classifyCall({ tool, command, target, targets, cwd }) {
    if (!GATED_TOOLS.includes(tool)) {
        return { decision: "safe", reason: "tool is not gated" };
    }

    if (SHELL_TOOLS.includes(tool)) {
        return classifyCommand(command);
    }

    const all = [...(Array.isArray(targets) ? targets : []), ...(typeof target === "string" ? [target] : [])].filter(
        (item) => typeof item === "string" && item.trim().length > 0,
    );
    if (all.length === 0) {
        return { decision: "unknown", reason: "write target could not be read" };
    }

    return all.some((item) => protectedPath(item, cwd))
        ? { decision: "unknown", reason: "writes to a protected path" }
        : { decision: "safe", reason: "ordinary project file" };
}
