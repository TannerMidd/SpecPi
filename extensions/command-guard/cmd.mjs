import { redactCommand } from "./redact.mjs";
import { analyzeHostArguments, HOST_NAMES as POWERSHELL_HOSTS } from "./powershell.mjs";

export const CMD_LIMITS = Object.freeze({ maxInput: 128 * 1024, maxTokens: 4096, maxLeaves: 128, maxDepth: 8 });
function lex(input, limits) {
    const tokens = [],
        errors = [],
        dynamicConstructs = [],
        redirects = [];
    let word = "",
        rawWord = "",
        quote = false,
        caret = false;
    const flush = () => {
        if (word || rawWord) {
            tokens.push({ text: word, raw: rawWord || word });
            word = "";
            rawWord = "";
        }
    };

    for (let i = 0; i < input.length; i += 1) {
        const c = input[i],
            n = input[i + 1];
        if (caret) {
            word += c;
            rawWord += c;
            caret = false;
            continue;
        }

        if (c === "^" && !quote) {
            rawWord += c;
            caret = true;
            continue;
        }

        if (c === '"') {
            rawWord += c;
            quote = !quote;
            continue;
        }

        if (!quote && (c === "&" || c === "|" || c === ">" || c === "<" || c === "(" || c === ")")) {
            flush();
            let op = c;
            if ((c === "&" || c === "|") && n === c) {
                op += n;
                i += 1;
            }

            if (c === ">" && n === ">") {
                op += n;
                i += 1;
            }

            tokens.push({ text: op, raw: op });
            if (c === ">" || c === "<") {
                redirects.push(op);
            }

            continue;
        }

        if (!quote && /\s/.test(c)) {
            flush();
            continue;
        }

        word += c;
        rawWord += c;
    }

    flush();
    if (quote || caret) {
        errors.push("unterminated quote or caret");
    }

    if (tokens.length > limits.maxTokens) {
        errors.push("token limit exceeded");
    }

    for (const value of tokens) {
        if (/%[^%\s]+%|![^!\s]+!/.test(value.text)) {
            dynamicConstructs.push({ kind: "environment-expansion" });
        }
    }

    return { tokens, errors, dynamicConstructs, redirects };
}

function unwrap(tokens) {
    const leaves = [],
        redirects = [];
    let current = [],
        pendingSeparator,
        pendingRedirect;
    const flush = () => {
        if (current.length) {
            const executable = current[0].text.replace(/^@+/, ""),
                args = current.slice(1).map((value) => value.text),
                rawArgs = current.slice(1).map((value) => value.raw);
            leaves.push({
                shell: "cmd",
                executable,
                operation: args.join(" "),
                args,
                rawArgs,
                redactedTarget: redactCommand(args.join(" ")),
                dynamic: /[%!]/.test(executable),
                separatorBefore: pendingSeparator,
            });
            pendingSeparator = undefined;
            current = [];
        }
    };

    for (const value of tokens) {
        if (["&", "&&", "||", "|", "(", ")"].includes(value.text)) {
            flush();
            pendingSeparator = value.text;
        } else if (value.text === ">" || value.text === ">>" || value.text === "<") {
            pendingRedirect = value.text;
        } else if (pendingRedirect) {
            redirects.push({ operator: pendingRedirect, target: value.text });
            leaves.push({
                shell: "cmd",
                executable: "<redirect>",
                operation: `${pendingRedirect} ${value.text}`,
                args: [value.text],
                rawArgs: [value.raw],
                redactedTarget: redactCommand(value.text),
                redirect: pendingRedirect,
                separatorBefore: pendingSeparator,
            });
            pendingRedirect = undefined;
        } else {
            current.push(value);
        }
    }

    flush();

    return { leaves, redirects, missingRedirect: Boolean(pendingRedirect) };
}

export function literalCmdPayload(args, rawArgs = args) {
    for (let index = 0; index < args.length; index += 1) {
        const cooked = String(args[index]),
            raw = String(rawArgs[index] ?? cooked);
        let payload;
        if (/^\/(?:c|k)$/i.test(cooked)) {
            payload = rawArgs.slice(index + 1).join(" ");
        } else {
            const attached = /^\/(?:c|k)(.+)$/i.exec(raw);
            if (attached) {
                payload = [attached[1], ...rawArgs.slice(index + 1)].join(" ");
            }
        }

        if (payload !== undefined) {
            payload = payload.trim();
            if (payload.length >= 2 && payload.startsWith('"') && payload.endsWith('"')) {
                payload = payload.slice(1, -1);
            }

            return payload;
        }
    }

    return undefined;
}

function attachPowerShellPayload(leaf, args, options, limits, dynamicConstructs) {
    const host = analyzeHostArguments(args, { ...options, depth: options.depth || 0, shell: leaf.executable });
    if (host?.nested) {
        leaf.nested = host.nested;
        dynamicConstructs.push({ kind: "nested-powershell" }, ...host.nested.dynamicConstructs);

        return;
    }

    if (host?.unresolved) {
        dynamicConstructs.push({ kind: "dynamic-nested-powershell" });

        return;
    }

    const file = args.findIndex((arg) => /^-(?:f|fi|fil|file)$/i.test(String(arg)));
    const supportedFile = file >= 0 && /\.(?:ps1|psm1|psd1)$/i.test(String(args[file + 1] || ""));
    const informational = args.some((arg) => /^-(?:version|help|\?)$/i.test(String(arg)));
    const hostOnly =
        informational &&
        args.every((arg) => /^-(?:nologo|noprofile|noninteractive|version|help|\?)$/i.test(String(arg)));
    if ((!supportedFile && !hostOnly) || (options.depth || 0) >= limits.maxDepth) {
        dynamicConstructs.push({ kind: "dynamic-nested-powershell" });
    }
}

export function analyze(input, options = {}) {
    const limits = { ...CMD_LIMITS, ...options };
    if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > limits.maxInput) {
        return {
            shell: "cmd",
            leaves: [],
            redirects: [],
            dynamicConstructs: [{ kind: "input-limit" }],
            parseErrors: [],
            indeterminate: true,
        };
    }

    const result = lex(input, limits),
        unwrapped = unwrap(result.tokens),
        leaves = unwrapped.leaves;
    const dynamicConstructs = [...result.dynamicConstructs];
    if (unwrapped.missingRedirect) {
        dynamicConstructs.push({ kind: "missing-redirect-target" });
    }

    for (const leaf of leaves) {
        const n = leaf.executable.toLowerCase().split(/[\\/]/).pop();
        if (n === "cmd" || n === "cmd.exe") {
            const payload = literalCmdPayload(leaf.args, leaf.rawArgs);
            if (!payload || /[%!]/.test(payload) || (options.depth || 0) >= limits.maxDepth) {
                dynamicConstructs.push({ kind: "dynamic-nested-cmd" });
            } else {
                leaf.nested = analyze(payload, { ...options, depth: (options.depth || 0) + 1 });
                dynamicConstructs.push({ kind: "nested-cmd" }, ...leaf.nested.dynamicConstructs);
            }
        } else if (n === "start") {
            const rawArgs = leaf.rawArgs || leaf.args;
            let index = 0;
            const skipSwitches = () => {
                while (index < leaf.args.length && /^\//.test(String(leaf.args[index]))) {
                    const option = String(leaf.args[index]);
                    index += 1;
                    if (/^\/(?:d|node|affinity|machine)$/i.test(option) && index < leaf.args.length) {
                        index += 1;
                    }
                }
            };

            skipSwitches();
            if (/^".*"$/s.test(String(rawArgs[index] || ""))) {
                index += 1;
                skipSwitches();
            }

            const candidate = String(leaf.args[index] || ""),
                candidateName = candidate
                    .toLowerCase()
                    .replace(/\.exe$/, "")
                    .split(/[\\/]/)
                    .pop();
            if (!candidate && leaf.args.some((arg) => /^\/(?:\?|help)$/i.test(String(arg)))) {
                /* informational START help */
            } else if (!candidate || (options.depth || 0) >= limits.maxDepth) {
                dynamicConstructs.push({ kind: "dynamic-start" });
            } else if (candidateName === "cmd") {
                const nestedInput = [rawArgs[index] || candidate, ...rawArgs.slice(index + 1)].join(" ");
                if (literalCmdPayload(leaf.args.slice(index + 1), rawArgs.slice(index + 1)) === undefined) {
                    dynamicConstructs.push({ kind: "dynamic-start-cmd" });
                } else {
                    leaf.nested = analyze(nestedInput, { ...options, depth: (options.depth || 0) + 1 });
                    dynamicConstructs.push({ kind: "nested-start-cmd" }, ...leaf.nested.dynamicConstructs);
                }
            } else if (POWERSHELL_HOSTS.includes(candidateName)) {
                const started = {
                    ...leaf,
                    executable: candidate,
                    args: leaf.args.slice(index + 1),
                    rawArgs: rawArgs.slice(index + 1),
                    operation: leaf.args.slice(index + 1).join(" "),
                };
                attachPowerShellPayload(
                    started,
                    started.args,
                    { ...options, depth: (options.depth || 0) + 1 },
                    limits,
                    dynamicConstructs,
                );
                if (started.nested) {
                    leaf.nested = started.nested;
                }
            }
        } else if (n === "call") {
            const payload = (leaf.rawArgs || leaf.args).join(" ");
            if (!payload || /[%!]/.test(payload) || (options.depth || 0) >= limits.maxDepth) {
                dynamicConstructs.push({ kind: "dynamic-call" });
            } else {
                leaf.nested = analyze(payload, { ...options, depth: (options.depth || 0) + 1 });
                dynamicConstructs.push({ kind: "nested-call" }, ...leaf.nested.dynamicConstructs);
            }
        } else if (POWERSHELL_HOSTS.includes(n.replace(/\.exe$/, ""))) {
            attachPowerShellPayload(leaf, leaf.args, options, limits, dynamicConstructs);
        } else if (n === "for") {
            dynamicConstructs.push({ kind: "dynamic-for" });
        } else if (n === "if" || n === "else") {
            // `if 1==1 rd /s /q C:\Windows` runs the delete. Only `for` was flagged, so the guarded command
            // behind an `if` was parsed as argument text of a program named "if" and never classified.
            const tail = conditionalTail(n, leaf.rawArgs || leaf.args || []);
            if (tail === undefined || (options.depth || 0) >= limits.maxDepth) {
                dynamicConstructs.push({ kind: `dynamic-${n}` });
            } else {
                leaf.nested = analyze(tail, { ...options, depth: (options.depth || 0) + 1 });
                dynamicConstructs.push({ kind: `nested-${n}` }, ...leaf.nested.dynamicConstructs);
            }
        } else if (["wmic", "mshta", "rundll32", "regsvr32"].includes(n)) {
            dynamicConstructs.push({ kind: `dynamic-${n}` });
        }

        if (n.endsWith(".bat") || n.endsWith(".cmd")) {
            dynamicConstructs.push({ kind: "batch-file" });
        }
    }

    if (leaves.length > limits.maxLeaves) {
        dynamicConstructs.push({ kind: "leaf-limit" });
    }

    return {
        shell: "cmd",
        leaves: leaves.slice(0, limits.maxLeaves),
        redirects: unwrapped.redirects,
        dynamicConstructs,
        parseErrors: result.errors,
        indeterminate:
            result.errors.length > 0 ||
            dynamicConstructs.some((item) => /dynamic|batch|limit|missing|expansion/.test(item.kind)) ||
            leaves.some((leaf) => leaf.dynamic || leaf.nested?.indeterminate),
    };
}

// Strips a cmd conditional header and returns the command it guards, or undefined when the shape is not one of
// the documented forms. Block bodies `( … )` and delayed expansion stay unresolved so the caller asks.
function conditionalTail(name, args) {
    const list = args.map((arg) => String(arg));
    let index = 0;
    if (name === "if") {
        while (index < list.length && /^(?:\/i|not)$/i.test(list[index])) {
            index += 1;
        }

        const head = list[index];
        if (head === undefined) {
            return undefined;
        }

        if (/^(?:errorlevel|exist|defined)$/i.test(head)) {
            index += 2;
        } else if (/==/.test(head)) {
            index += 1;
        } else if (/^(?:equ|neq|lss|leq|gtr|geq)$/i.test(list[index + 1] || "")) {
            index += 3;
        } else {
            return undefined;
        }
    }

    const tail = list.slice(index);
    if (!tail.length || tail[0].startsWith("(") || tail.some((arg) => /[%!]/.test(arg))) {
        return undefined;
    }

    return tail.join(" ");
}

export const analyzeCmd = analyze;
