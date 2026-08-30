import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { redactCommand } from "./redact.mjs";
import { analyze as analyzeCmd, literalCmdPayload } from "./cmd.mjs";

export const POWERSHELL_LIMITS = Object.freeze({
    maxInput: 128 * 1024,
    maxCommands: 128,
    timeoutMs: 3000,
    maxOutput: 256 * 1024,
    maxDepth: 8,
});
const aliasMap = new Map(
    Object.entries({
        ac: "add-content",
        cat: "get-content",
        clc: "clear-content",
        cli: "clear-item",
        clp: "clear-itemproperty",
        copy: "copy-item",
        cp: "copy-item",
        cpi: "copy-item",
        cpp: "copy-itemproperty",
        del: "remove-item",
        epal: "export-alias",
        epcsv: "export-csv",
        epsn: "export-pssession",
        erase: "remove-item",
        gc: "get-content",
        gci: "get-childitem",
        gi: "get-item",
        gps: "get-process",
        iex: "invoke-expression",
        irm: "invoke-restmethod",
        iwr: "invoke-webrequest",
        kill: "stop-process",
        mi: "move-item",
        move: "move-item",
        mp: "move-itemproperty",
        mv: "move-item",
        nal: "new-alias",
        ni: "new-item",
        np: "new-itemproperty",
        rd: "remove-item",
        ren: "rename-item",
        ri: "remove-item",
        rm: "remove-item",
        rmdir: "remove-item",
        rni: "rename-item",
        rnp: "rename-itemproperty",
        rp: "remove-itemproperty",
        sal: "set-alias",
        saps: "start-process",
        sc: "set-content",
        si: "set-item",
        sp: "set-itemproperty",
        spps: "stop-process",
        spsv: "stop-service",
        start: "start-process",
        tee: "tee-object",
        type: "get-content",
        wget: "invoke-webrequest",
        curl: "invoke-webrequest",
    }),
);
const canonicalName = (value) => {
    const raw = String(value || "");
    const lower = raw.toLowerCase();

    return lower.endsWith(".exe") ? raw : aliasMap.get(lower) || raw;
};

function unavailable(reason) {
    return {
        shell: "powershell",
        leaves: [],
        redirects: [],
        dynamicConstructs: [{ kind: reason }],
        parseErrors: [{ message: reason }],
        indeterminate: true,
    };
}

// PowerShell accepts any unambiguous prefix of a parameter name, so -enc runs the same code as
// -EncodedCommand. Every consumer must match the whole prefix range or a shorter spelling walks past it.
export const ENCODED_COMMAND_FLAG =
    /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/i;
export const COMMAND_FLAG = /^-(?:c|co|com|comm|comma|comman|command)$/i;
export const HOST_NAMES = Object.freeze(["powershell", "pwsh"]);
export function decodeEncodedCommand(value, maxInput = POWERSHELL_LIMITS.maxInput) {
    const encoded = typeof value === "string" ? value : "";
    if (!encoded || encoded.includes("[dynamic]") || encoded.length > 65536 || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
        return undefined;
    }

    try {
        const decoded = Buffer.from(encoded, "base64");
        if (!decoded.length || decoded.length > maxInput || decoded.length % 2 !== 0) {
            return undefined;
        }

        return decoded.toString("utf16le");
    } catch {
        return undefined;
    }
}

function validate(data, limits) {
    if (
        !data ||
        data.schema !== 1 ||
        typeof data.ok !== "boolean" ||
        !data.parser ||
        typeof data.parser.version !== "string" ||
        !Array.isArray(data.commands) ||
        !Array.isArray(data.errors)
    ) {
        return undefined;
    }

    if (
        !Array.isArray(data.dynamicConstructs) ||
        !Array.isArray(data.stopParsingTokens) ||
        data.commands.length > limits.maxCommands ||
        data.errors.length > 32 ||
        data.dynamicConstructs.length > 256 ||
        data.stopParsingTokens.length > 128
    ) {
        return undefined;
    }

    if (
        data.limitExceeded !== undefined &&
        !["tokens", "commands", "elements", "redirections"].includes(data.limitExceeded)
    ) {
        return undefined;
    }

    if (
        !data.commands.every(
            (command) =>
                command &&
                typeof command === "object" &&
                (typeof command.commandName === "string" || command.commandName === null) &&
                Array.isArray(command.elements) &&
                command.elements.length <= 256 &&
                command.elements.every(
                    (element) =>
                        element &&
                        (element.literal === null ||
                            element.literal === undefined ||
                            (typeof element.literal === "string" &&
                                Buffer.byteLength(element.literal, "utf8") <= 65536)) &&
                        (element.raw === undefined ||
                            (typeof element.raw === "string" && Buffer.byteLength(element.raw, "utf8") <= 65536)),
                ) &&
                Array.isArray(command.redirections) &&
                command.redirections.length <= 128,
        )
    ) {
        return undefined;
    }

    return data;
}

function parameterValue(args, name) {
    for (let index = 0; index < args.length; index += 1) {
        const value = String(args[index]),
            lower = value.toLowerCase(),
            wanted = `-${name}`;
        if (lower === wanted || (wanted.startsWith(lower) && /^-[a-z]+$/i.test(lower))) {
            return args[index + 1];
        }

        if (lower.startsWith(`${wanted}:`)) {
            return value.slice(value.indexOf(":") + 1);
        }
    }

    return undefined;
}

function aliasPositionalArguments(args, dynamicConstructs) {
    const valueParameters = [
        "name",
        "value",
        "description",
        "option",
        "scope",
        "erroraction",
        "errorvariable",
        "warningaction",
        "warningvariable",
        "informationaction",
        "informationvariable",
        "outvariable",
        "outbuffer",
        "pipelinevariable",
    ];
    const switchParameters = ["force", "passthru", "verbose", "debug", "whatif", "confirm"];
    const positional = [];
    for (let index = 0; index < args.length; index += 1) {
        const value = String(args[index]);
        if (!value.startsWith("-")) {
            positional.push(value);
            continue;
        }

        const key = value.slice(1).split(":", 1)[0].toLowerCase();
        const valueMatches = valueParameters.filter((name) => name.startsWith(key));
        const switchMatches = switchParameters.filter((name) => name.startsWith(key));
        if (valueMatches.length === 1 && switchMatches.length === 0) {
            if (!value.includes(":")) {
                index += 1;
            }

            continue;
        }

        if (switchMatches.length === 1 && valueMatches.length === 0) {
            continue;
        }

        dynamicConstructs.push({ kind: "dynamic-alias-definition" });
    }

    return positional;
}

function resolveLiteralAliases(leaves, dynamicConstructs) {
    const local = new Map(),
        alternatives = [];
    for (const leaf of leaves) {
        const encountered = String(leaf.executable || "").toLowerCase();
        const meanings = local.get(encountered);
        if (meanings?.size) {
            const values = [...meanings];
            leaf.executable = values[0];
            for (const executable of values.slice(1)) {
                alternatives.push({ ...leaf, executable, args: [...leaf.args], redirections: [...leaf.redirections] });
            }
        }

        const name = canonicalName(leaf.executable).toLowerCase();
        if (name === "import-alias") {
            dynamicConstructs.push({ kind: "dynamic-alias-definition" });
            continue;
        }

        let aliasName, targetName;
        if (name === "set-alias" || name === "new-alias") {
            const positional = aliasPositionalArguments(leaf.args, dynamicConstructs);
            aliasName = parameterValue(leaf.args, "name") || positional[0];
            targetName = parameterValue(leaf.args, "value") || positional[1];
        } else if (
            (name === "set-item" || name === "new-item") &&
            leaf.args.some((arg) => /^alias:/i.test(String(arg)))
        ) {
            const aliasPath =
                parameterValue(leaf.args, "path") ||
                parameterValue(leaf.args, "literalpath") ||
                leaf.args.find((arg) => /^alias:/i.test(String(arg)));
            aliasName = String(aliasPath || "").replace(/^alias:/i, "");
            targetName =
                parameterValue(leaf.args, "value") ||
                leaf.args.filter((arg) => !String(arg).startsWith("-") && !/^alias:/i.test(String(arg))).at(-1);
        }

        if (aliasName || targetName) {
            if (
                typeof aliasName !== "string" ||
                typeof targetName !== "string" ||
                /\[dynamic\]|[$`]/.test(`${aliasName}${targetName}`) ||
                !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(aliasName) ||
                !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(targetName)
            ) {
                dynamicConstructs.push({ kind: "dynamic-alias-definition" });
            } else {
                const key = aliasName.toLowerCase(),
                    targets = local.get(targetName.toLowerCase()) || new Set([canonicalName(targetName)]);
                const accumulated = local.get(key) || new Set();
                for (const target of targets) {
                    accumulated.add(target);
                }

                local.set(key, accumulated);
            }
        }
    }

    leaves.push(...alternatives);
}

function cmdEquivalentArg(element, cooked) {
    const raw = typeof element?.raw === "string" ? element.raw : cooked;
    if (typeof cooked !== "string" || cooked === "[dynamic]") {
        return cooked;
    }

    if (cooked.includes('"')) {
        return "[dynamic]";
    }

    if (/^["'].*["']$/s.test(raw)) {
        return `"${cooked}"`;
    }

    const attached = /^\/(c|k)(["'])(.*)\2$/is.exec(raw);
    if (attached && /^\/(?:c|k)/i.test(cooked)) {
        return `${cooked.slice(0, 2)}"${cooked.slice(2)}"`;
    }

    return raw;
}

function map(data) {
    const leaves = data.commands.map((command) => {
        const name = typeof command.commandName === "string" ? canonicalName(command.commandName) : "";
        const args = Array.isArray(command.elements)
            ? command.elements
                  .slice(1)
                  .map((element) => (typeof element.literal === "string" ? element.literal : "[dynamic]"))
            : [];
        const rawArgs = Array.isArray(command.elements)
            ? command.elements.slice(1).map((element, index) => cmdEquivalentArg(element, args[index]))
            : [];

        return {
            shell: "powershell",
            executable: name || "<dynamic>",
            operation: args.join(" "),
            args,
            rawArgs,
            redactedTarget: redactCommand(args.join(" ")),
            dynamic: !name || args.includes("[dynamic]"),
            pipelineGroup: Number.isInteger(command.pipelineStart) ? command.pipelineStart : undefined,
            redirections: command.redirections || [],
        };
    });
    const localDynamicConstructs = [...data.dynamicConstructs];
    resolveLiteralAliases(leaves, localDynamicConstructs);
    const literalTruncated = data.commands.some(
        (command) =>
            command.elements.some((element) => element?.literalTruncated === true || element?.rawTruncated === true) ||
            command.redirections.some((redirection) => redirection?.targetTruncated === true),
    );
    const limitConstructs = [
        ...(typeof data.limitExceeded === "string" ? [{ kind: `${data.limitExceeded.replace(/s$/, "")}-limit` }] : []),
        ...(literalTruncated ? [{ kind: "literal-limit" }] : []),
    ];
    const stopParsing =
        data.stopParsingTokens.length > 0 || leaves.some((leaf) => leaf.args.some((arg) => arg === "--%"));
    if (stopParsing && !localDynamicConstructs.some((entry) => entry.kind === "stop-parsing")) {
        localDynamicConstructs.push({ kind: "stop-parsing" });
    }

    return {
        shell: "powershell",
        leaves,
        redirects: leaves.flatMap((leaf) => leaf.redirections),
        dynamicConstructs: [...localDynamicConstructs, ...limitConstructs],
        parseErrors: data.errors,
        indeterminate:
            !data.ok ||
            data.errors.length > 0 ||
            localDynamicConstructs.length > 0 ||
            limitConstructs.length > 0 ||
            stopParsing ||
            leaves.some((leaf) => leaf.dynamic),
    };
}

function attachNested(parsed, options, limits) {
    const depth = options.depth || 0;
    for (const leaf of parsed.leaves) {
        const name = canonicalName(leaf.executable)
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        if (name === "invoke-expression") {
            const payload = leaf.args.join(" ");
            if (!payload || payload.includes("[dynamic]") || depth >= limits.maxDepth) {
                parsed.dynamicConstructs.push({ kind: "dynamic-invoke-expression" });
                parsed.indeterminate = true;
            } else {
                leaf.nested = analyze(payload, { ...options, depth: depth + 1 });
                parsed.dynamicConstructs.push({ kind: "nested-invoke-expression" }, ...leaf.nested.dynamicConstructs);
                parsed.indeterminate ||= leaf.nested.indeterminate;
            }
        }

        if (name === "start-process") {
            const argumentList = leaf.args.findIndex((arg) => /^-(?:argumentlist|args)$/i.test(arg));
            const executable = leaf.args.find(
                (arg, index) => index !== argumentList && index !== argumentList + 1 && !arg.startsWith("-"),
            );
            const payload = argumentList >= 0 ? leaf.args.slice(argumentList + 1).join(" ") : "";
            if (!executable || !payload || payload.includes("[dynamic]") || depth >= limits.maxDepth) {
                parsed.dynamicConstructs.push({ kind: "dynamic-start-process" });
                parsed.indeterminate = true;
            } else {
                leaf.nested = analyze(`${executable} ${payload}`, { ...options, depth: depth + 1 });
                parsed.dynamicConstructs.push({ kind: "nested-start-process" }, ...leaf.nested.dynamicConstructs);
                parsed.indeterminate ||= leaf.nested.indeterminate;
            }
        }

        if (name === "cmd") {
            const payload = literalCmdPayload(leaf.args, leaf.rawArgs);
            if (!payload || payload.includes("[dynamic]") || depth >= limits.maxDepth) {
                parsed.dynamicConstructs.push({ kind: "dynamic-nested-cmd" });
                parsed.indeterminate = true;
            } else {
                leaf.nested = analyzeCmd(payload, { ...options, depth: depth + 1 });
                parsed.dynamicConstructs.push({ kind: "nested-cmd" }, ...leaf.nested.dynamicConstructs);
                parsed.indeterminate ||= leaf.nested.indeterminate;
            }
        }

        if (HOST_NAMES.includes(name)) {
            const commandFlag = leaf.args.findIndex((arg) => COMMAND_FLAG.test(String(arg)));
            const encodedFlag = leaf.args.findIndex((arg) => ENCODED_COMMAND_FLAG.test(String(arg)));
            if (encodedFlag >= 0) {
                const decoded =
                    depth >= limits.maxDepth
                        ? undefined
                        : decodeEncodedCommand(leaf.args[encodedFlag + 1], limits.maxInput);
                if (!decoded) {
                    parsed.dynamicConstructs.push({ kind: "dynamic-encoded-command" });
                    parsed.parseErrors.push({ message: "encoded-command-unavailable" });
                    parsed.indeterminate = true;
                } else {
                    leaf.nested = analyze(decoded, { ...options, depth: depth + 1 });
                    parsed.dynamicConstructs.push({ kind: "encoded-command" }, ...leaf.nested.dynamicConstructs);
                    parsed.indeterminate ||= leaf.nested.indeterminate;
                }
            } else if (commandFlag >= 0) {
                const payload = leaf.args.slice(commandFlag + 1).join(" ");
                if (!payload || payload.includes("[dynamic]") || depth >= limits.maxDepth) {
                    parsed.dynamicConstructs.push({ kind: "dynamic-nested-powershell" });
                    parsed.indeterminate = true;
                } else {
                    leaf.nested = analyze(payload, { ...options, depth: depth + 1 });
                    parsed.dynamicConstructs.push({ kind: "nested-powershell" }, ...leaf.nested.dynamicConstructs);
                    parsed.indeterminate ||= leaf.nested.indeterminate;
                }
            }
        }
    }

    return parsed;
}

export function parsePowerShellResult(stdout, limits = POWERSHELL_LIMITS) {
    if (typeof stdout !== "string" || stdout.length > limits.maxOutput) {
        return unavailable("output-limit");
    }

    let data;
    try {
        data = JSON.parse(stdout);
    } catch {
        return unavailable("invalid-helper-json");
    }

    const valid = validate(data, limits);
    if (!valid) {
        return unavailable("invalid-helper-result");
    }

    return map(valid);
}

const INFRASTRUCTURE_FAILURES = new Set([
    "helper-unavailable",
    "helper-failure",
    "helper-timeout",
    "invalid-helper-json",
    "invalid-helper-result",
    "input-limit",
    "output-limit",
]);
function infrastructureFailure(result) {
    return (result.dynamicConstructs || []).some((entry) => INFRASTRUCTURE_FAILURES.has(entry.kind));
}

export function parserHosts(options = {}) {
    if (options.executable) {
        return [String(options.executable)];
    }

    if (process.platform !== "win32") {
        return [];
    }

    const windowsPowerShell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
    // Fixed installer-owned locations only: resolving pwsh.exe through PATH would let a planted binary answer for the guard.
    const powerShell7 = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
        .filter((root) => typeof root === "string" && root)
        .map((root) => path.join(root, "PowerShell", "7", "pwsh.exe"));
    const ordered =
        String(options.shell || "").toLowerCase() === "pwsh"
            ? [...powerShell7, windowsPowerShell]
            : [windowsPowerShell, ...powerShell7];

    return [...new Set(ordered)];
}

// A clean parse always wins; otherwise keep a real grammar rejection over a spawn failure so
// infrastructure noise cannot escalate an ordinary syntax error into a critical parser-integrity denial.
export function preferParserResult(previous, candidate) {
    if (!(candidate.parseErrors || []).length || !previous) {
        return candidate;
    }

    return infrastructureFailure(previous) && !infrastructureFailure(candidate) ? candidate : previous;
}

function runParser(executable, helper, input, limits) {
    const env = {
        SystemRoot: process.env.SystemRoot || "C:\\Windows",
        PATH: process.env.PATH || "",
        TEMP: process.env.TEMP || "",
    };
    const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper], {
        input,
        encoding: "utf8",
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutput,
        shell: false,
        windowsHide: true,
        env,
    });
    if (result.error) {
        return unavailable(result.error.code === "ETIMEDOUT" ? "helper-timeout" : "helper-failure");
    }

    if (result.status !== 0 || typeof result.stdout !== "string" || result.stderr) {
        return unavailable("helper-failure");
    }

    return parsePowerShellResult(result.stdout, limits);
}

export function analyze(input, options = {}) {
    const limits = { ...POWERSHELL_LIMITS, ...options };
    if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > limits.maxInput) {
        return unavailable("input-limit");
    }

    const helper =
        options.helperPath || path.join(path.dirname(fileURLToPath(import.meta.url)), "powershell-parser.ps1");
    if (!fs.existsSync(helper)) {
        return unavailable("helper-unavailable");
    }

    const hosts = parserHosts(options).filter((executable) => path.isAbsolute(executable) && fs.existsSync(executable));
    if (!hosts.length) {
        return unavailable("helper-unavailable");
    }

    // Windows PowerShell 5.1 rejects PowerShell 7 grammar (&&, ??, ?:) that a co-installed pwsh executes happily.
    // Text any installed host accepts can really run, so a rejection is authoritative only when every host rejects it.
    let chosen;
    for (const executable of hosts) {
        chosen = preferParserResult(chosen, runParser(executable, helper, input, limits));
        if (!(chosen.parseErrors || []).length) {
            break;
        }
    }

    return attachNested(chosen, options, limits);
}

// Analyzes the inline payload of a powershell/pwsh invocation seen from another shell's parser, so an
// encoded or -Command payload is classified rather than passed through as an opaque argument.
// Returns undefined when the invocation carries no inline payload.
export function analyzeHostArguments(args, options = {}) {
    const limits = { ...POWERSHELL_LIMITS, ...options };
    const list = (args || []).map((arg) => String(arg));
    const encodedIndex = list.findIndex((arg) => ENCODED_COMMAND_FLAG.test(arg));
    const commandIndex = list.findIndex((arg) => COMMAND_FLAG.test(arg));
    if (encodedIndex < 0 && commandIndex < 0) {
        return undefined;
    }

    const depth = options.depth || 0;
    const payload =
        encodedIndex >= 0
            ? decodeEncodedCommand(list[encodedIndex + 1], limits.maxInput)
            : list.slice(commandIndex + 1).join(" ");
    if (!payload || payload.includes("[dynamic]") || /[$`]/.test(payload) || depth >= limits.maxDepth) {
        return { unresolved: true };
    }

    const nested = analyze(payload, { ...options, depth: depth + 1 });
    // A missing or failing PowerShell parser means this command cannot run on this host either. Report it as
    // unresolved so the caller asks, rather than propagating a fatal parser-integrity kind into an unrelated
    // shell's analysis and locking the session over an absent interpreter.
    if ((nested.parseErrors || []).length || infrastructureFailure(nested)) {
        return { unresolved: true };
    }

    return { nested };
}

export const analyzePowerShell = analyze;
export const aliases = Object.freeze(Object.fromEntries(aliasMap));
