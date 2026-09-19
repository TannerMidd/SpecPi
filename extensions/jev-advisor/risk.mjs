// Local triage for shell and file calls, before anything is sent anywhere.
//
// This is the first half of the native command guard. Jev is the second half and the one that does
// the analysis; everything here exists to decide what Jev is asked about. Three answers:
//
//   safe      -- settled locally. Jev is never asked, and nothing else will look at this call.
//   dangerous -- blocked locally, with no call and no human.
//   unknown   -- Jev is asked.
//
// THE THREE ARE NOT SYMMETRIC, and that asymmetry is the whole design:
//
//   a wrong `safe`      is a silent, permanent hole -- the one verdict with no second reader
//   a wrong `unknown`   costs one call out of a per-session budget of 208, and Jev decides
//   a wrong `dangerous` blocks real work with no recourse but switching the guard off
//
// So the two lists below are maintained under opposite pressures, and the mistake worth naming is
// treating them as one thing called "the guard" and hardening both the same way.
//
// READ_ONLY is a BUDGET mechanism, not a safety one. The guard has 208 calls and each is a few
// hundred milliseconds awaited on the tool path, so a session that greps and cats a few hundred
// times would spend the lot and then defer everything for the rest of its life -- a guard that runs
// out is weaker than one with a fast path. The admission test is therefore NOT "is this harmless".
// It is: is this binary simple whatever flags it is given, and common enough to be worth it? A
// binary that can launch a program, write a file or change machine state under any flag is not
// simple, however harmless its name reads, and Jev parses it. `env` and `fd` launch things,
// `find` has -delete, `rg` has --pre, `date -s` sets the clock, `hostname` sets the hostname,
// `file -C` writes a compiled magic file. Every one of those was on this list, and every one was a
// general bypass that cost almost no budget to keep.
//
// CATASTROPHIC is deliberately tiny, and its only real job is the case where Jev is NOT THERE: no
// key, budget spent, a timeout. Jev catches everything this list would, and weighs intent besides,
// which a pattern cannot. So resist adding to it. A rule here fires with no model and no human, and
// a false positive is a blocked session whose only remedy is switching the whole guard off -- and a
// guard people switch off protects nobody. Ask whether you would stake "this is never legitimate"
// on it; if not, it belongs in the question set, where being wrong costs one call.
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
 * Simple binaries: ones that change nothing whatever flags they are given.
 *
 * "Whatever flags" is the whole test, and it is stricter than it sounds. `git` fails it obviously
 * (`push`, `reset`, `clean`), and special-casing `git status` would only add a subcommand allowlist
 * to maintain beside this one. These fail it less obviously, which is what made each of them a
 * bypass worth having:
 *
 *   env, fd        launch another program outright -- `env rm -rf build`, `fd -x rm`
 *   find           has -delete and -exec
 *   rg             has --pre, which runs an arbitrary preprocessor per file
 *   sort, uniq     name an output file (`sort -o`, `uniq in out`)
 *   date           -s sets the system clock
 *   hostname       with an argument, sets the hostname
 *   file           -C compiles and writes a magic file
 *   printenv       changes nothing and hands over a secret, which the risk question also asks about
 *
 * None of them reads as dangerous, and none of them was common enough for the fast path to be
 * buying much. That is the trade: a rare binary on this list saves almost no budget and costs a
 * silent hole, so when in doubt it comes off and Jev parses it.
 *
 * Being here is not a claim that a call is harmless. It is a claim that asking about it would spend
 * the budget without learning anything -- which is why the arguments are still checked below, and
 * `cat ~/.ssh/id_rsa` leaves the fast path even though `cat` never belongs anywhere else.
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
    "stat",
    "du",
    "df",
    "whoami",
    "uname",
    "echo",
    "printf",
    "which",
    "type",
    "grep",
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

/** Targets that mean "everything": the filesystem root, or a bare home directory. */
const ROOT_TARGETS = new Set(["/", "/*", "~", "~/*", "$HOME", "$HOME/*", "%USERPROFILE%", "%USERPROFILE%\\*"]);

/**
 * A recursive delete aimed at the root or a bare home.
 *
 * Written as a function rather than a regex because the regex it replaces anchored on the end of the
 * string, so it matched `rm -rf /` -- which GNU `rm` refuses on its own -- and missed
 * `rm -rf / --no-preserve-root`, which is the spelling that actually empties the disk. Flag order and
 * position are not something a pattern should be asked to track.
 */
function removesEverything(value) {
    const tokens = value.trim().split(/\s+/u);
    const start = tokens[0] === "sudo" || tokens[0] === "doas" ? 1 : 0;
    if (leadingBinary(tokens[start]) !== "rm") {
        return false;
    }

    const args = tokens.slice(start + 1);
    const recursive = args.some(
        (token) => token === "--recursive" || (/^-[a-zA-Z]+$/u.test(token) && /[rR]/u.test(token)),
    );

    return (
        recursive && args.some((token) => !token.startsWith("-") && ROOT_TARGETS.has(token.replace(/\/+$/u, "") || "/"))
    );
}

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
        // `rm -rf /`, `rm -rf / --no-preserve-root`, `rm -r -f ~`. Not `rm -rf ./build`.
        test: removesEverything,
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
export function classifyCommand(command, cwd = process.cwd()) {
    const value = text(command).trim();
    if (value.length === 0) {
        return { decision: "unknown", reason: "empty command" };
    }

    for (const rule of CATASTROPHIC) {
        if (rule.test ? rule.test(value) : rule.pattern.test(value)) {
            return { decision: "dangerous", reason: rule.reason };
        }
    }

    // A command with shell control characters is never taken on the fast path, however harmless its
    // first word looks: `ls; rm -rf ~` begins with `ls`.
    if (SHELL_CONTROL.test(value)) {
        return { decision: "unknown", reason: "shell control characters" };
    }

    if (READ_ONLY.has(leadingBinary(value))) {
        // Read-only is a statement about what the binary does, not about what it is pointed at, and
        // the question this guard asks names exfiltration beside destruction. `cat ~/.ssh/id_rsa`
        // changes nothing and hands over a private key, so the fast path has to look at the
        // arguments too or half of the question it asks is unreachable for the commands that answer
        // it. A protected argument costs one question; every other read stays free.
        return commandArguments(value).some((argument) => protectedPath(argument, cwd))
            ? { decision: "unknown", reason: "reads a protected path" }
            : { decision: "safe", reason: "read-only command" };
    }

    return { decision: "unknown", reason: "not a known read-only command" };
}

/**
 * The non-flag arguments of a command, unquoted.
 *
 * Deliberately crude: this decides whether to ask a question, never whether to block, so a token it
 * splits wrongly costs a question and nothing else.
 */
function commandArguments(value) {
    return value
        .split(/\s+/u)
        .slice(1)
        .filter((token) => !token.startsWith("-"))
        .map((token) => token.replace(/^["']|["']$/gu, ""))
        .filter((token) => token.length > 0);
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

/** Keys a harness uses for "the text this call runs", across the tools in `SHELL_TOOLS`. */
const COMMAND_KEYS = Object.freeze(["command", "cmd", "script", "input", "text", "data", "stdin", "line"]);

/**
 * The text a shell call will run, from a tool input whose shape this module does not control.
 *
 * `bash` carries `command`; `write_stdin` carries the text it types into a live shell under some
 * other name entirely. Reading `command` alone meant every `write_stdin` was classified as an empty
 * command -- spending a guard call on the empty string while the `rm -rf ~` being typed went
 * unexamined -- so the tool most worth reading was the one read as blank.
 */
export function commandText(input) {
    if (typeof input === "string") {
        return input;
    }

    if (input === null || typeof input !== "object") {
        return "";
    }

    for (const key of COMMAND_KEYS) {
        if (typeof input[key] === "string" && input[key].trim().length > 0) {
            return input[key];
        }
    }

    return "";
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
        return classifyCommand(command, cwd);
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
