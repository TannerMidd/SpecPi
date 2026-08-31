import { redactCommand } from "./redact.mjs";
import { analyze as analyzeCmd, literalCmdPayload } from "./cmd.mjs";
import { analyzeHostArguments, HOST_NAMES as POWERSHELL_HOSTS } from "./powershell.mjs";

export const BASH_LIMITS = Object.freeze({ maxInput: 128 * 1024, maxTokens: 4096, maxLeaves: 128, maxDepth: 8 });
const separators = new Set([";", "&&", "||", "|", "&", "(", ")"]);
const shells = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const safeSubstitutionConsumers = new Set([
    "echo",
    "printf",
    "pwd",
    "date",
    "cat",
    "head",
    "tail",
    "grep",
    "rg",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "basename",
    "dirname",
]);
const safeExpansionConsumers = new Set([
    "echo",
    "printf",
    "pwd",
    "date",
    "cat",
    "head",
    "tail",
    "grep",
    "rg",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "basename",
    "dirname",
]);
// Runners whose -c argument is a shell command string rather than an argv vector.
const commandStringRunners = new Set([...shells, "su", "runuser", "script"]);
// Runners that prefix an argv vector. Every entry must also be resolvable by wrapperCommandIndex.
const wrappers = new Set([
    "sudo",
    "doas",
    "env",
    "command",
    "exec",
    "nohup",
    "nice",
    "time",
    "timeout",
    "chroot",
    "busybox",
    "toybox",
    "setsid",
    "setarch",
    "stdbuf",
    "ionice",
    "taskset",
    "flock",
    "systemd-run",
    "unbuffer",
    "runuser",
    "xvfb-run",
    "proxychains",
    "proxychains4",
]);

function heredocOpeners(line) {
    const found = [];
    let quote = "",
        escaped = false,
        comment = false;
    for (let index = 0; index < line.length - 1; index += 1) {
        const character = line[index];
        if (comment) {
            break;
        }

        if (escaped) {
            escaped = false;
            continue;
        }

        if (character === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }

        if (quote) {
            if (character === quote) {
                quote = "";
            }

            continue;
        }

        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }

        if (character === "#" && (index === 0 || /[\s;|&()]/.test(line[index - 1]))) {
            comment = true;
            continue;
        }

        if (character !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") {
            continue;
        }

        index += 2;
        let stripTabs = false;
        if (line[index] === "-") {
            stripTabs = true;
            index += 1;
        }

        while (line[index] === " " || line[index] === "\t") {
            index += 1;
        }

        let delimiter = "",
            wordQuote = "",
            wordEscaped = false,
            ansiSingle = false,
            unsupported = false;
        for (; index < line.length; index += 1) {
            const value = line[index];
            if (wordEscaped) {
                delimiter += value;
                wordEscaped = false;
                continue;
            }

            if (value === "$" && !wordQuote && (line[index + 1] === "'" || line[index + 1] === '"')) {
                wordQuote = line[index + 1];
                ansiSingle = wordQuote === "'";
                unsupported ||= wordQuote === '"';
                index += 1;
                continue;
            }

            if ((value === "$" || value === "`") && !wordQuote) {
                unsupported = true;
            }

            if (value === "\\" && ansiSingle) {
                unsupported = true;
                delimiter += value;
                continue;
            }

            if (value === "\\" && wordQuote !== "'") {
                wordEscaped = true;
                continue;
            }

            if (wordQuote) {
                if (value === wordQuote) {
                    wordQuote = "";
                    ansiSingle = false;
                } else {
                    delimiter += value;
                }

                continue;
            }

            if (value === "'" || value === '"') {
                wordQuote = value;
                continue;
            }

            if (/[\s;|&()<>]/.test(value)) {
                break;
            }

            delimiter += value;
        }

        if (delimiter) {
            found.push({ delimiter, stripTabs, unsupported });
        }
    }

    return found;
}

function literalHeredocBodies(input) {
    const lines = String(input).split(/(?<=\n)/),
        pending = [],
        bodies = [];
    for (const line of lines) {
        if (pending.length) {
            let candidate = line.replace(/[\r\n]+$/, "");
            if (pending[0].stripTabs) {
                candidate = candidate.replace(/^\t+/, "");
            }

            if (candidate === pending[0].delimiter) {
                bodies.push({ body: pending[0].body, unsupported: pending[0].unsupported });
                pending.shift();
            } else {
                pending[0].body += line;
            }

            continue;
        }

        pending.push(...heredocOpeners(line).map((entry) => ({ ...entry, body: "" })));
    }

    return { bodies, complete: pending.length === 0 };
}

export function stripHeredocBodies(input) {
    const lines = String(input).split(/(?<=\n)/),
        pending = [],
        output = [];
    for (const line of lines) {
        if (pending.length) {
            let candidate = line.replace(/[\r\n]+$/, "");
            if (pending[0].stripTabs) {
                candidate = candidate.replace(/^\t+/, "");
            }

            if (candidate === pending[0].delimiter) {
                pending.shift();
            }

            output.push(line.replace(/[^\r\n]/g, " "));
            continue;
        }

        output.push(line);
        pending.push(...heredocOpeners(line));
    }

    return output.join("");
}

export function containsUnquotedForkBomb(input) {
    const command = stripHeredocBodies(input);
    let visible = "",
        quote = "",
        escaped = false,
        comment = false;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (comment) {
            if (character === "\n" || character === "\r") {
                comment = false;
                visible += character;
            } else {
                visible += " ";
            }

            continue;
        }

        if (escaped) {
            visible += " ";
            escaped = false;
            continue;
        }

        if (character === "\\" && quote !== "'") {
            escaped = true;
            visible += " ";
            continue;
        }

        if (quote) {
            if (character === quote) {
                quote = "";
            }

            visible += " ";
            continue;
        }

        if (character === "'" || character === '"') {
            quote = character;
            visible += " ";
            continue;
        }

        if (character === "#" && (index === 0 || /[\s;|&()]/.test(command[index - 1]))) {
            comment = true;
            visible += " ";
            continue;
        }

        visible += character;
    }

    const definitions = /(?:^|[\s;])(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*|:)\s*(?:\(\s*\))?\s*\{([^}]*)\}/g;
    let definition;
    while ((definition = definitions.exec(visible))) {
        const escaped = definition[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const selfBackground = new RegExp(
            `(?:^|[\\s;|&()])${escaped}(?:\\s*\\|\\s*${escaped})?\\s*&(?:[\\s;|&()]|$)`,
        ).test(definition[2]);
        const invoked = new RegExp(`(?:^|[\\s;|&()])${escaped}(?:[\\s;|&()]|$)`).test(
            visible.slice(definitions.lastIndex),
        );
        if (selfBackground && invoked) {
            return true;
        }
    }

    return false;
}

function token(text, kind = "word", raw = text) {
    return { text, kind, raw };
}

function scan(input, limits) {
    const tokens = [],
        redirects = [],
        dynamicConstructs = [],
        errors = [];
    let word = "",
        rawWord = "",
        quote = "",
        escaped = false,
        comment = false,
        heredoc = false;
    const flush = () => {
        if (word) {
            tokens.push(token(word, "word", rawWord || word));
            word = "";
            rawWord = "";
        }
    };

    const push = (text, kind) => {
        flush();
        tokens.push(token(text, kind));
    };

    for (let i = 0; i < input.length; i += 1) {
        const c = input[i],
            n = input[i + 1];
        if (comment) {
            if (c === "\n" || c === "\r") {
                comment = false;
            } else {
                continue;
            }
        }

        if (escaped) {
            word += c;
            rawWord += c;
            escaped = false;
            continue;
        }

        if (c === "\\" && quote !== "'") {
            if (n === "\n") {
                i += 1;
            } else if (n === "\r" && input[i + 2] === "\n") {
                i += 2;
            } else {
                rawWord += c;
                if (quote === '"' && !/[\\$`"]/.test(n || "")) {
                    word += "\\";
                } else {
                    escaped = true;
                }
            }

            continue;
        }

        if (quote) {
            rawWord += c;
            if (c === quote) {
                quote = "";
            } else {
                if (quote === '"' && (c === "`" || (c === "$" && n === "("))) {
                    dynamicConstructs.push({ kind: "quoted-substitution", start: i, end: i + 1 });
                } else if (quote === '"' && c === "$" && (n === "{" || /[A-Za-z_0-9@*#?$!-]/.test(n || ""))) {
                    dynamicConstructs.push({ kind: "quoted-expansion", start: i, end: i + 1 });
                }

                word += c;
            }

            continue;
        }

        if (c === "'" || c === '"') {
            quote = c;
            rawWord += c;
            continue;
        }

        if (c === "#" && !word && (i === 0 || /[\s;|&()]/.test(input[i - 1]))) {
            comment = true;
            continue;
        }

        if (c === "\r" || c === "\n") {
            if (c === "\r" && n === "\n") {
                i += 1;
            }

            push(";", "separator");
            continue;
        }

        if (/\s/.test(c)) {
            flush();
            continue;
        }

        if ((c === "<" || c === ">") && n === "(") {
            dynamicConstructs.push({ kind: "process-substitution", start: i, end: i + 1 });
            word += `${c}(`;
            rawWord += `${c}(`;
            i += 1;
            continue;
        }

        if (c === "<" || c === ">") {
            flush();
            let op = c;
            if (n === c || n === "&" || n === "|") {
                op += n;
                i += 1;
            }

            if (/^[0-9]$/.test(input[i - 1] || "") && !word) {
                op = `${input[i - 1]}${op}`;
            }

            tokens.push(token(op, "redirect"));
            redirects.push(op);
            if (op.includes("<<")) {
                dynamicConstructs.push({ kind: "heredoc" });
            }

            continue;
        }

        if (c === ";" || c === "(" || c === ")" || c === "&" || c === "|") {
            flush();
            let op = c;
            if ((c === "&" || c === "|") && n === c) {
                op += n;
                i += 1;
            }

            push(op, "separator");
            continue;
        }

        if (c === "`" || (c === "$" && n === "(")) {
            dynamicConstructs.push({ kind: "command-substitution", start: i, end: i + 1 });
            word += c;
            rawWord += c;
            continue;
        }

        if (c === "$" && n === "{") {
            dynamicConstructs.push({ kind: "environment-expansion", start: i, end: i + 1 });
            word += c;
            rawWord += c;
            continue;
        }

        if (c === "$" && /[A-Za-z_0-9@*#?$!-]/.test(n || "")) {
            dynamicConstructs.push({ kind: "environment-expansion", start: i, end: i + 1 });
            word += c;
            rawWord += c;
            continue;
        }

        word += c;
        rawWord += c;
    }

    flush();
    if (quote || escaped) {
        errors.push("unterminated quote or escape");
    }

    if (tokens.length > limits.maxTokens) {
        errors.push("token limit exceeded");
    }

    return { tokens, redirects, dynamicConstructs, parseErrors: errors };
}

// Shell reserved words are STRUCTURE, not programs. They were being taken as the leaf executable, so in
// `if true; then rm -rf /; fi` the real command survived only as an argument list hanging off a leaf named
// `then` — and every rule keys on the executable, so the delete was never classified at all.
// Stripping them in command position puts the actual program back in command position.
const structuralKeywords = new Set([
    "!",
    "then",
    "else",
    "elif",
    "do",
    "time",
    "{",
    "}",
    "(",
    ")",
    "coproc",
    "builtin",
    "command",
    "nocorrect",
    "if",
    "while",
    "until",
]);
// Words that only ever close a block, and loop/case headers whose remainder is a word list rather than a command.
const terminatorKeywords = new Set(["fi", "done", "esac", "in", "]]", "[["]);
const headerKeywords = new Set(["for", "select", "case", "function"]);
function leafFrom(words) {
    if (!words.length) {
        return undefined;
    }

    let start = 0;
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text)) {
        start += 1;
    }

    // A quoted word is a literal filename, never a reserved word, so `raw` must still match the bare text.
    const bare = (word) => word && (word.raw ?? word.text) === word.text;
    // `if`/`while`/`until` are stripped too: what follows them is the condition, which is itself a real command.
    while (start < words.length && bare(words[start]) && structuralKeywords.has(words[start].text)) {
        start += 1;
        while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text)) {
            start += 1;
        }
    }

    const head = words[start];
    if (head && bare(head) && (terminatorKeywords.has(head.text) || headerKeywords.has(head.text))) {
        return undefined;
    }

    const commandWords = words.slice(start);
    const first = commandWords[0];
    if (!first) {
        return undefined;
    }

    const executable = first.text;
    // Whitespace in command position means the token was never resolved to one program: `wrapper 'rm -rf /etc'`
    // is either a filename containing spaces or a command string the runner hands to a shell. Stay indeterminate
    // instead of letting normalized() reduce it to a harmless-looking trailing segment.
    const dynamic = /[$`*?{}]|\s/.test(executable) || executable.startsWith("-");

    return {
        shell: "bash",
        executable,
        operation: commandWords
            .slice(1)
            .map((x) => x.text)
            .join(" "),
        args: commandWords.slice(1).map((x) => x.text),
        rawArgs: commandWords.slice(1).map((x) => x.raw ?? x.text),
        redactedTarget: redactCommand(
            commandWords
                .slice(1)
                .map((x) => x.text)
                .join(" "),
        ),
        dynamic,
    };
}

function makeLeaves(tokens, limits) {
    const leaves = [],
        redirects = [],
        dynamicConstructs = [];
    let current = [],
        pendingRedirect,
        pendingSeparator,
        commandId = 0;
    const flush = () => {
        const leaf = leafFrom(current);
        if (leaf) {
            leaf.separatorBefore = pendingSeparator;
            leaf.commandId = commandId;
            leaves.push(leaf);
            pendingSeparator = undefined;
            commandId += 1;
        }

        current = [];
    };

    for (const item of tokens) {
        if (item.kind === "separator") {
            flush();
            pendingSeparator = item.text;
            continue;
        }

        if (item.kind === "redirect") {
            pendingRedirect = item.text;
            continue;
        }

        if (pendingRedirect) {
            const detail = {
                operator: pendingRedirect,
                target: item.text,
                separatorBefore: pendingSeparator,
                commandId,
            };
            redirects.push(detail);
            leaves.push({
                shell: "bash",
                executable: "<redirect>",
                operation: `${pendingRedirect} ${item.text}`,
                args: [item.text],
                redactedTarget: redactCommand(item.text),
                redirect: pendingRedirect,
                separatorBefore: pendingSeparator,
                commandId,
            });
            pendingRedirect = undefined;
            continue;
        }

        current.push(item);
    }

    flush();
    if (pendingRedirect) {
        dynamicConstructs.push({ kind: "missing-redirect-target" });
    }

    if (leaves.length > limits.maxLeaves) {
        dynamicConstructs.push({ kind: "leaf-limit" });
    }

    return { leaves: leaves.slice(0, limits.maxLeaves), redirects, dynamicConstructs };
}

const wrapperValueOptions = new Map([
    ["exec", ["-a"]],
    [
        "sudo",
        [
            "-u",
            "--user",
            "-g",
            "--group",
            "-h",
            "--host",
            "-p",
            "--prompt",
            "-c",
            "--close-from",
            "-t",
            "--command-timeout",
            "-d",
            "--chdir",
            "-r",
            "--chroot",
            "--role",
            "--type",
        ],
    ],
    ["doas", ["-u", "-c"]],
    ["env", ["-u", "--unset", "-c", "--chdir", "--argv0", "-s", "--split-string"]],
    ["nice", ["-n", "--adjustment"]],
    ["time", ["-f", "--format", "-o", "--output"]],
    ["timeout", ["-s", "--signal", "-k", "--kill-after"]],
    ["chroot", ["--userspec", "--groups"]],
    [
        "xargs",
        [
            "-E",
            "-I",
            "-L",
            "-n",
            "-P",
            "-s",
            "--eof",
            "--replace",
            "--max-lines",
            "--max-args",
            "--max-procs",
            "--max-chars",
            "--arg-file",
        ],
    ],
    ["stdbuf", ["-i", "-o", "-e", "--input", "--output", "--error"]],
    ["ionice", ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]],
    ["watch", ["-n", "--interval", "--chgexit"]],
    ["flock", ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]],
    [
        "runuser",
        ["-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell", "-w", "--whitelist-environment"],
    ],
    [
        "xvfb-run",
        [
            "-n",
            "--server-num",
            "-s",
            "--server-args",
            "-e",
            "--error-file",
            "-f",
            "--auth-file",
            "-p",
            "--xauth-protocol",
        ],
    ],
    ["proxychains", ["-f"]],
    ["proxychains4", ["-f"]],
    [
        "systemd-run",
        [
            "-p",
            "--property",
            "-u",
            "--unit",
            "--description",
            "--slice",
            "--uid",
            "--gid",
            "--nice",
            "--setenv",
            "-E",
            "-M",
            "--machine",
            "-H",
            "--host",
            "--working-directory",
            "--service-type",
            "--timer-property",
            "--on-active",
            "--on-boot",
            "--on-startup",
            "--on-unit-active",
            "--on-unit-inactive",
            "--on-calendar",
        ],
    ],
]);
// Runners whose first positional argument is a parameter — duration, new root, CPU mask, lock file, architecture — not the command.
const wrapperPositionalParameter = new Set(["timeout", "chroot", "taskset", "flock", "setarch"]);
function wrapperCommandIndex(name, args) {
    // taskset keeps -c out of the value list so its CPU list is consumed as the positional parameter instead.
    const takesValue = new Set((wrapperValueOptions.get(name) || []).map((option) => option.toLowerCase()));
    let skipPositional = wrapperPositionalParameter.has(name);
    for (let index = 0; index < args.length; index += 1) {
        const arg = String(args[index]);
        if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
            continue;
        }

        if (arg === "--") {
            return index + 1 < args.length ? index + 1 : -1;
        }

        const option = arg.toLowerCase();
        if (takesValue.has(option)) {
            index += 1;
            continue;
        }

        if (
            [...takesValue].some((entry) =>
                entry.startsWith("--")
                    ? option.startsWith(`${entry}=`)
                    : option.startsWith(entry) && option.length > entry.length,
            )
        ) {
            continue;
        }

        if (arg.startsWith("-") && arg !== "-") {
            continue;
        }

        if (skipPositional) {
            skipPositional = false;
            continue;
        }

        return index;
    }

    return -1;
}

const stdinCodeInterpreters = new Set([
    "powershell",
    "pwsh",
    "python",
    "python3",
    "py",
    "node",
    "deno",
    "bun",
    "ruby",
    "perl",
    "php",
    "lua",
    "rscript",
    "xargs",
    "source",
    ".",
]);
function heredocConsumerKind(leaf) {
    let current = leaf;
    for (let depth = 0; current && depth < 8; depth += 1) {
        const name = current.executable
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        // `su`/`runuser` with no -c start a shell that reads stdin as commands, exactly like a bare `sh`.
        if (shells.has(name) || name === "su" || name === "runuser") {
            const flag = (current.args || []).findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(String(arg)));
            if (flag >= 0) {
                // `bash -c 'sh'` runs `sh`, and THAT process still inherits the heredoc on stdin. Treating the
                // body as inert data on the mere presence of -c let `bash -c 'sh' <<EOF … EOF` execute it
                // completely unanalyzed. Resolve what -c actually launches and ask again.
                const payload = current.args[flag + 1];
                if (typeof payload !== "string" || !payload || /[$`]/.test(payload)) {
                    return "unknown";
                }

                const inner = leafFrom(
                    payload
                        .trim()
                        .split(/\s+/)
                        .map((text) => token(text)),
                );
                if (!inner) {
                    return "unknown";
                }

                current = inner;
                continue;
            }

            // For su/runuser the positional argument is the target USER, not a script, so stdin is still the
            // command source: `su root <<EOF … EOF` runs the body as root.
            if (name === "su" || name === "runuser") {
                return "bash";
            }

            const script = (current.args || []).find((arg) => !String(arg).startsWith("-"));

            return script ? "data" : "bash";
        }

        if (name === "cmd") {
            return "cmd";
        }

        if (stdinCodeInterpreters.has(name)) {
            return "unknown";
        }

        if (!wrappers.has(name)) {
            return "data";
        }

        if (name === "env") {
            const splitIndex = (current.args || []).findIndex((arg) =>
                /^(?:-[sS]|--split-string)(?:=|$)/.test(String(arg)),
            );
            if (splitIndex >= 0) {
                const option = String(current.args[splitIndex]);
                const payload = option.includes("=")
                    ? option.slice(option.indexOf("=") + 1)
                    : current.args[splitIndex + 1];
                if (typeof payload !== "string" || !payload || /[$`]/.test(payload)) {
                    return "unknown";
                }

                current = leafFrom(
                    payload
                        .trim()
                        .split(/\s+/)
                        .map((text) => token(text)),
                );
                continue;
            }
        }

        const commandIndex = wrapperCommandIndex(name, current.args || []);
        if (commandIndex < 0) {
            return "data";
        }

        current = leafFrom(current.args.slice(commandIndex).map((text) => token(text)));
    }

    return "unknown";
}

function sedSubstitutionExecutes(script) {
    const match = /^\s*s([^A-Za-z0-9\\\s])/.exec(script);
    if (!match) {
        return false;
    }

    const delimiter = match[1];
    let escaped = false,
        separators = 0;
    for (let index = match[0].length; index < script.length; index += 1) {
        const value = script[index];
        if (escaped) {
            escaped = false;
            continue;
        }

        if (value === "\\") {
            escaped = true;
            continue;
        }

        if (value !== delimiter) {
            continue;
        }

        separators += 1;
        if (separators === 2) {
            return /e/i.test(script.slice(index + 1).trim());
        }
    }

    return false;
}

function sedExecution(args) {
    const payloads = [];
    let dynamic = false;
    for (const raw of args) {
        const script = String(raw);
        if (sedSubstitutionExecutes(script)) {
            dynamic = true;
        }

        const expression = /(?:^|[;\n])\s*(?:(?:\d+|\$|\/[^/\n]*\/)\s*)?e(?:[ \t]+([^\n]*)|(?=\s*(?:[;\n]|$)))/g;
        let match;
        while ((match = expression.exec(script))) {
            if (match[1]?.trim()) {
                payloads.push(match[1].trim());
            } else {
                dynamic = true;
            }
        }
    }

    return { payloads, dynamic };
}

function addDecodedPipelines(leaves, options, dynamicConstructs, depth) {
    if (depth >= options.maxDepth) {
        return;
    }

    for (let index = 0; index + 2 < leaves.length; index += 1) {
        const source = leaves[index],
            decoder = leaves[index + 1],
            interpreter = leaves[index + 2];
        if (decoder.separatorBefore !== "|" || interpreter.separatorBefore !== "|") {
            continue;
        }

        const sourceName = source.executable
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        const decoderName = decoder.executable
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        const interpreterName = interpreter.executable
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        if (
            sourceName !== "printf" ||
            decoderName !== "base64" ||
            !decoder.args.some((arg) => /^(?:-d|--decode)$/i.test(arg)) ||
            !shells.has(interpreterName) ||
            interpreter.args.length
        ) {
            continue;
        }

        if (source.args.length !== 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.args[0])) {
            continue;
        }

        let decoded;
        try {
            const buffer = Buffer.from(source.args[0], "base64");
            if (
                buffer.toString("base64").replace(/=+$/, "") !== source.args[0].replace(/=+$/, "") ||
                buffer.includes(0)
            ) {
                continue;
            }

            decoded = buffer.toString("utf8");
            if (decoded.includes("\uFFFD") || Buffer.byteLength(decoded, "utf8") > options.maxInput) {
                continue;
            }
        } catch {
            continue;
        }

        interpreter.nested = analyze(decoded, { ...options, depth: depth + 1 });
        interpreter.decodedInput = true;
        dynamicConstructs.push({ kind: "decoded-pipeline" }, ...interpreter.nested.dynamicConstructs);
        if (interpreter.nested.indeterminate) {
            dynamicConstructs.push({ kind: "dynamic-decoded-pipeline" });
        }
    }
}

function cmdEquivalentArgs(leaf) {
    return (leaf.rawArgs || leaf.args).map((rawValue, index) => {
        const cooked = String(leaf.args[index] ?? ""),
            raw = String(rawValue);
        if (cooked.includes('"')) {
            return "[dynamic]";
        }

        if (/^(["']).*\1$/s.test(raw)) {
            return `"${cooked}"`;
        }

        const attached = /^\/(c|k)(["'])(.*)\2$/is.exec(raw);
        if (attached && /^\/(?:c|k)/i.test(cooked)) {
            return `${cooked.slice(0, 2)}"${cooked.slice(2)}"`;
        }

        return raw;
    });
}

function addNested(leaves, options, dynamicConstructs, depth) {
    if (depth >= options.maxDepth) {
        dynamicConstructs.push({ kind: "depth-limit" });

        return;
    }

    // A nested analysis that could not be fully resolved must not be reported as a clean parse upstream.
    const adopt = (leaf, nested, kind) => {
        leaf.nested = nested;
        dynamicConstructs.push(...nested.dynamicConstructs);
        if (nested.indeterminate) {
            dynamicConstructs.push({ kind: `dynamic-${kind}` });
        }
    };

    for (const leaf of [...leaves]) {
        const name = leaf.executable
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        const cmdPayload = name === "cmd" ? literalCmdPayload(leaf.args, cmdEquivalentArgs(leaf)) : undefined;
        if (
            (commandStringRunners.has(name) && leaf.args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))) ||
            (name === "cmd" && cmdPayload !== undefined)
        ) {
            const flag = leaf.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
            const nested = name === "cmd" ? cmdPayload : leaf.args[flag + 1];
            if (!nested || /[$`]/.test(nested)) {
                dynamicConstructs.push({ kind: "dynamic-nested-shell" });
                continue;
            }

            adopt(
                leaf,
                name === "cmd"
                    ? analyzeCmd(nested, { ...options, depth: depth + 1 })
                    : analyze(nested, { ...options, depth: depth + 1 }),
                "nested-shell",
            );
            // A command string is fully described by its nested analysis; never let a later branch replace it.
            continue;
        }

        // A PowerShell host invoked from Bash carries its payload in -Command or -EncodedCommand. Classify it
        // here; otherwise an encoded payload reaches the policy as one opaque base64 argument.
        if (POWERSHELL_HOSTS.includes(name)) {
            const host = analyzeHostArguments(leaf.args, { ...options, depth, shell: name });
            if (host) {
                if (host.unresolved) {
                    dynamicConstructs.push({ kind: "dynamic-nested-powershell" });
                } else {
                    adopt(leaf, host.nested, "nested-powershell");
                }

                continue;
            }

            const file = leaf.args.findIndex((arg) => /^-(?:f|fi|fil|file)$/i.test(String(arg)));
            const supportedFile = file >= 0 && /\.(?:ps1|psm1|psd1)$/i.test(String(leaf.args[file + 1] || ""));
            const informational = leaf.args.some((arg) => /^-(?:version|help|\?)$/i.test(String(arg)));
            const hostOnly =
                informational &&
                leaf.args.every((arg) => /^-(?:nologo|noprofile|noninteractive|version|help|\?)$/i.test(String(arg)));
            if (!supportedFile && !hostOnly) {
                dynamicConstructs.push({ kind: "dynamic-nested-powershell" });
            }

            continue;
        }

        // watch joins its remaining arguments and hands them to a shell, so its tail is a command string in both
        // `watch rm -rf /etc` and `watch 'rm -rf /etc'` form.
        // `trap 'rm -rf /' EXIT` registers a command string that the shell runs later. It reached the analyzer as
        // an ordinary quoted argument to a command named `trap`, so the payload was never classified.
        if (name === "trap") {
            dynamicConstructs.push({ kind: "trap-wrapper" });
            const handler = (leaf.args || []).find((arg) => !String(arg).startsWith("-"));
            if (typeof handler !== "string" || !handler || /[$`]/.test(handler) || handler === "-") {
                if (handler !== "-" && handler !== "") {
                    dynamicConstructs.push({ kind: "dynamic-trap" });
                }
            } else {
                adopt(leaf, analyze(handler, { ...options, depth: depth + 1 }), "trap");
            }

            continue;
        }

        if (name === "eval" || name === "xargs" || name === "watch") {
            dynamicConstructs.push({ kind: `${name}-wrapper` });
            if (name === "xargs") {
                dynamicConstructs.push({ kind: "dynamic-xargs-input" });
            }

            const start = name === "eval" ? 0 : wrapperCommandIndex(name, leaf.args || []);
            const payload = start >= 0 ? leaf.args.slice(start).join(" ") : "";
            if (!payload || /[$`]/.test(payload)) {
                dynamicConstructs.push({ kind: `dynamic-${name}` });
            } else {
                adopt(leaf, analyze(payload, { ...options, depth: depth + 1 }), name);
            }

            continue;
        }

        if (wrappers.has(name)) {
            dynamicConstructs.push({ kind: `${name}-wrapper` });
            if (name === "env") {
                const splitIndex = (leaf.args || []).findIndex((arg) =>
                    /^(?:-[sS]|--split-string)(?:=|$)/.test(String(arg)),
                );
                if (splitIndex >= 0) {
                    const option = String(leaf.args[splitIndex]);
                    const payload = option.includes("=")
                        ? option.slice(option.indexOf("=") + 1)
                        : leaf.args[splitIndex + 1];
                    if (!payload || /[$`]/.test(payload)) {
                        dynamicConstructs.push({ kind: "dynamic-env-split-string" });
                    } else {
                        adopt(leaf, analyze(payload, { ...options, depth: depth + 1 }), "env-split-string");
                    }

                    continue;
                }
            }

            const commandIndex = wrapperCommandIndex(name, leaf.args || []);
            if (commandIndex < 0) {
                if (name !== "env") {
                    dynamicConstructs.push({ kind: `dynamic-${name}` });
                }

                continue;
            }

            const childArgs = leaf.args.slice(commandIndex);
            const child = leafFrom(childArgs.map((text) => token(text)));
            if (!child) {
                dynamicConstructs.push({ kind: `dynamic-${name}` });
                continue;
            }

            leaf.nested = {
                shell: "bash",
                leaves: [child],
                redirects: [],
                dynamicConstructs: [],
                parseErrors: [],
                indeterminate: child.dynamic,
            };
            addNested(leaf.nested.leaves, options, leaf.nested.dynamicConstructs, depth + 1);
            leaf.nested.indeterminate ||=
                leaf.nested.leaves.some((entry) => entry.dynamic) ||
                leaf.nested.dynamicConstructs.some((item) => /limit|dynamic/.test(item.kind));
            dynamicConstructs.push(...leaf.nested.dynamicConstructs);
            if (leaf.nested.indeterminate) {
                dynamicConstructs.push({ kind: `dynamic-${name}` });
            }
        }

        if (name === "sed") {
            const execution = sedExecution(leaf.args || []);
            if (execution.dynamic) {
                dynamicConstructs.push({ kind: "dynamic-sed-exec" });
            }

            if (execution.payloads.length) {
                const payload = execution.payloads.join("; ");
                if (/[$`]/.test(payload)) {
                    dynamicConstructs.push({ kind: "dynamic-sed-exec" });
                } else {
                    adopt(leaf, analyze(payload, { ...options, depth: depth + 1 }), "sed-exec");
                }
            }
        }

        const findExec = (arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir";
        if (name === "find" && leaf.args.some((arg) => findExec(arg) || arg === "-delete")) {
            dynamicConstructs.push({ kind: "find-exec" });
            const execIndex = leaf.args.findIndex(findExec);
            if (execIndex >= 0) {
                const payload = leaf.args
                    .slice(execIndex + 1)
                    .filter((arg) => arg !== ";" && arg !== "+")
                    .join(" ");
                if (!payload || /[$`{}]/.test(payload)) {
                    dynamicConstructs.push({ kind: "dynamic-find-exec" });
                } else {
                    adopt(leaf, analyze(payload, { ...options, depth: depth + 1 }), "find-exec");
                }
            }
        }
    }
}

export function analyze(input, options = {}) {
    const limits = { ...BASH_LIMITS, ...options };
    if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > limits.maxInput) {
        return {
            shell: "bash",
            leaves: [],
            redirects: [],
            dynamicConstructs: [{ kind: "input-limit" }],
            parseErrors: [],
            indeterminate: true,
        };
    }

    if (containsUnquotedForkBomb(input)) {
        return {
            shell: "bash",
            leaves: [
                { shell: "bash", executable: "fork-bomb", operation: "", args: [], redactedTarget: "", dynamic: false },
            ],
            redirects: [],
            dynamicConstructs: [],
            parseErrors: [],
            indeterminate: false,
        };
    }

    const parsedInput = stripHeredocBodies(input);
    const scanned = scan(parsedInput, limits);
    const made = makeLeaves(scanned.tokens, limits);
    const outerLeaves = made.leaves.filter((leaf) => leaf.separatorBefore !== "(");
    let dynamicConstructs = [...scanned.dynamicConstructs, ...made.dynamicConstructs];
    const substitutionPattern = /(?:\$\(|<\(|`)\s*([^`()]*?)(?:\)|`)/g;
    const resolvedSubstitutions = new Set();
    let substitution;
    while ((substitution = substitutionPattern.exec(parsedInput))) {
        if ((options.depth || 0) >= limits.maxDepth) {
            dynamicConstructs.push({ kind: "depth-limit" });
            break;
        }

        const nested = analyze(substitution[1], { ...options, depth: (options.depth || 0) + 1 });
        made.leaves.push(...nested.leaves);
        dynamicConstructs.push(...nested.dynamicConstructs);
        if (nested.indeterminate) {
            dynamicConstructs.push({ kind: "dynamic-substitution" });
        } else {
            resolvedSubstitutions.add(substitution.index);
        }
    }

    const substitutionsCannotChangeDangerousArguments = outerLeaves.every((leaf) =>
        safeSubstitutionConsumers.has(
            leaf.executable
                .toLowerCase()
                .replace(/\.exe$/, "")
                .split(/[\\/]/)
                .pop(),
        ),
    );
    const expansionsCannotChangeDangerousArguments =
        outerLeaves.every((leaf) =>
            safeExpansionConsumers.has(
                leaf.executable
                    .toLowerCase()
                    .replace(/\.exe$/, "")
                    .split(/[\\/]/)
                    .pop(),
            ),
        ) && !made.redirects.some((redirect) => /[$`]/.test(String(redirect.target || "")));
    const heredocRedirects = made.redirects.filter((redirect) => String(redirect.operator).includes("<<"));
    const resolvedHeredocs = [];
    let resolvedHeredocExecution = false;
    if (heredocRedirects.length) {
        const lastInputRedirect = new Map();
        for (const redirect of made.redirects) {
            if (String(redirect.operator).includes("<")) {
                lastInputRedirect.set(redirect.commandId, redirect);
            }
        }

        const commandById = new Map(
            outerLeaves.filter((leaf) => leaf.executable !== "<redirect>").map((leaf) => [leaf.commandId, leaf]),
        );
        const details = literalHeredocBodies(input);
        if (details.complete && details.bodies.length === heredocRedirects.length) {
            for (let index = 0; index < heredocRedirects.length; index += 1) {
                const redirect = heredocRedirects[index];
                const body = details.bodies[index];
                if (body.unsupported) {
                    resolvedHeredocs.push(false);
                    continue;
                }

                if (lastInputRedirect.get(redirect.commandId) !== redirect) {
                    resolvedHeredocs.push(true);
                    continue;
                }

                const kind = heredocConsumerKind(commandById.get(redirect.commandId));
                if (kind === "data") {
                    resolvedHeredocs.push(true);
                    continue;
                }

                if (kind === "unknown") {
                    resolvedHeredocs.push(false);
                    continue;
                }

                const nested =
                    kind === "cmd"
                        ? analyzeCmd(body.body, { ...options, depth: (options.depth || 0) + 1 })
                        : analyze(body.body, { ...options, depth: (options.depth || 0) + 1 });
                made.leaves.push(...nested.leaves);
                dynamicConstructs.push(...nested.dynamicConstructs);
                if (nested.indeterminate) {
                    dynamicConstructs.push({ kind: "dynamic-heredoc" });
                    resolvedHeredocs.push(false);
                } else {
                    resolvedHeredocs.push(true);
                    resolvedHeredocExecution = true;
                }
            }
        }
    }

    let heredocIndex = 0;
    dynamicConstructs = dynamicConstructs.filter((entry) => {
        if (["command-substitution", "quoted-substitution", "process-substitution"].includes(entry.kind)) {
            return !substitutionsCannotChangeDangerousArguments || !resolvedSubstitutions.has(entry.start);
        }

        if (["environment-expansion", "quoted-expansion"].includes(entry.kind)) {
            return !expansionsCannotChangeDangerousArguments;
        }

        if (entry.kind === "heredoc") {
            return !resolvedHeredocs[heredocIndex++];
        }

        return true;
    });
    if ((resolvedSubstitutions.size && substitutionsCannotChangeDangerousArguments) || resolvedHeredocExecution) {
        dynamicConstructs.push({ kind: "resolved-command-execution" });
    }

    addNested(made.leaves, limits, dynamicConstructs, options.depth || 0);
    addDecodedPipelines(made.leaves, limits, dynamicConstructs, options.depth || 0);

    return {
        shell: "bash",
        leaves: made.leaves,
        redirects: made.redirects,
        dynamicConstructs,
        parseErrors: scanned.parseErrors,
        indeterminate:
            scanned.parseErrors.length > 0 ||
            made.leaves.some((leaf) => leaf.dynamic || leaf.nested?.indeterminate) ||
            dynamicConstructs.some((item) =>
                /(?:input|token|leaf|depth)-limit|dynamic-|heredoc|substitution|expansion|missing-redirect/.test(
                    item.kind,
                ),
            ),
    };
}

export const analyzeBash = analyze;
