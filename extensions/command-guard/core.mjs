import crypto from "node:crypto";
import { analyze as analyzeBash } from "./bash.mjs";
import { analyze as analyzeCmd } from "./cmd.mjs";
import { analyze as analyzePowerShell } from "./powershell.mjs";
import {
    catastrophicTextScan,
    evaluateRules,
    findMutates,
    GUARD_APPROVAL_RULES,
    POLICY_VERSION,
    ruleCatalog,
} from "./rules.mjs";
import { classifyPath, pathDecision } from "./paths.mjs";
import { boundedReason, redactCommand } from "./redact.mjs";

export const MODES = Object.freeze(["guard", "strict", "off", "locked"]);
// The single place the accepted native-child preflight contract is pinned. `zenpi doctor` compares the
// installed package against this so a pi-subagents bump surfaces as a diagnostic instead of silently
// failing every protected launch closed.
export const SUPPORTED_SUBAGENT_CONTRACT = Object.freeze({
    packageName: "pi-subagents",
    packageVersion: "0.58.0",
    version: 2,
});
export const LIMITS = Object.freeze({
    maxInput: 128 * 1024,
    maxDepth: 8,
    maxTokens: 4096,
    maxLeaves: 128,
    timeoutMs: 3000,
    cacheSize: 256,
});
const rank = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const actionRank = Object.freeze({ allow: 0, ask: 1, deny: 2 });
const analysisCache = new Map();
const builtInRuleIds = new Set(ruleCatalog.ruleIds);
const categories = new Set([
    "filesystem",
    "disk",
    "system",
    "security",
    "process",
    "network",
    "git",
    "database",
    "container",
    "cloud",
    "package",
    "protected-path",
    "dynamic",
    "unknown",
]);

function empty() {
    return {
        action: "allow",
        severity: "low",
        category: "unknown",
        ruleIds: [],
        leaves: [],
        reason: "No protected operation was detected.",
        indeterminate: false,
    };
}

function malformedDecision() {
    return {
        action: "deny",
        severity: "critical",
        category: "security",
        ruleIds: ["policy.integrity"],
        leaves: [],
        reason: "The command policy returned malformed decision data; execution is denied.",
        indeterminate: true,
    };
}

function validDecision(value) {
    const validLeaf = (leaf) =>
        leaf &&
        typeof leaf === "object" &&
        typeof leaf.executable === "string" &&
        Buffer.byteLength(leaf.executable, "utf8") <= 256 &&
        typeof leaf.operation === "string" &&
        Buffer.byteLength(leaf.operation, "utf8") <= 4096 &&
        (!Object.hasOwn(leaf, "redactedTarget") ||
            (typeof leaf.redactedTarget === "string" && Buffer.byteLength(leaf.redactedTarget, "utf8") <= 512));

    return (
        value &&
        typeof value === "object" &&
        ["allow", "ask", "deny"].includes(value.action) &&
        Object.hasOwn(rank, value.severity) &&
        categories.has(value.category) &&
        Array.isArray(value.ruleIds) &&
        value.ruleIds.length <= 32 &&
        (value.action === "allow" || value.ruleIds.length > 0) &&
        value.ruleIds.every(
            (id) => typeof id === "string" && /^[a-z][a-z0-9.-]{2,95}$/.test(id) && builtInRuleIds.has(id),
        ) &&
        Array.isArray(value.leaves) &&
        value.leaves.length <= LIMITS.maxLeaves &&
        value.leaves.every(validLeaf) &&
        typeof value.reason === "string" &&
        Buffer.byteLength(value.reason, "utf8") > 0 &&
        Buffer.byteLength(value.reason, "utf8") <= 512 &&
        (!Object.hasOwn(value, "saferAlternative") ||
            (typeof value.saferAlternative === "string" && Buffer.byteLength(value.saferAlternative, "utf8") <= 512)) &&
        (!Object.hasOwn(value, "indeterminate") || typeof value.indeterminate === "boolean")
    );
}

export function aggregateDecisions(decisions, options = {}) {
    if (!Array.isArray(decisions) || decisions.some((item) => !validDecision(item))) {
        return malformedDecision();
    }

    const list = decisions;
    if (!list.length) {
        return empty();
    }

    const result = list.reduce((best, item) => {
        const a =
            rank[item.severity] > rank[best.severity] ||
            (rank[item.severity] === rank[best.severity] && actionRank[item.action] > actionRank[best.action]);
        if (!a) {
            return best;
        }

        return {
            ...item,
            ruleIds: [...new Set(item.ruleIds || [])].slice(0, 32),
            leaves: (item.leaves || []).slice(0, LIMITS.maxLeaves),
            reason: boundedReason(item.reason),
        };
    }, empty());
    if (result.action === "deny" || result.severity === "critical") {
        return { ...result, action: "deny", indeterminate: Boolean(result.indeterminate) };
    }

    if (result.action === "ask" && options.hasUI === false) {
        return {
            ...result,
            action: "deny",
            reason: "Approval is unavailable in this non-interactive session.",
            indeterminate: Boolean(result.indeterminate),
        };
    }

    return { ...result, indeterminate: Boolean(result.indeterminate) };
}

export function analyzeCommand(command, options = {}) {
    const shell = String(options.shell || (options.platform === "win32" ? "powershell" : "bash")).toLowerCase();
    const cacheKey =
        options.cache !== false && typeof command === "string" && Buffer.byteLength(command, "utf8") <= LIMITS.maxInput
            ? sha256(
                  JSON.stringify({
                      shell,
                      command,
                      cwd: options.cwd || "",
                      parser: 1,
                      policy: POLICY_VERSION,
                      helper: options.helperPath || "",
                      executable: options.executable || "",
                  }),
              )
            : "";
    if (cacheKey && analysisCache.has(cacheKey)) {
        const cached = analysisCache.get(cacheKey);
        analysisCache.delete(cacheKey);
        analysisCache.set(cacheKey, cached);

        return structuredClone(cached);
    }

    let result;
    try {
        if (shell === "powershell" || shell === "pwsh") {
            result = analyzePowerShell(command, options);
        } else if (shell === "cmd" || shell === "cmd.exe") {
            result = analyzeCmd(command, options);
        } else {
            result = analyzeBash(command, options);
        }
    } catch {
        result = {
            shell,
            leaves: [],
            redirects: [],
            dynamicConstructs: [{ kind: "parser-exception" }],
            parseErrors: [],
            indeterminate: true,
        };
    }

    try {
        attachBashHostPayloads(result, options);
    } catch {
        result.dynamicConstructs.push({ kind: "parser-exception" });
        result.indeterminate = true;
    }

    if (cacheKey) {
        analysisCache.set(cacheKey, result);
        if (analysisCache.size > LIMITS.cacheSize) {
            analysisCache.delete(analysisCache.keys().next().value);
        }
    }

    return structuredClone(result);
}

export function clearAnalysisCache() {
    analysisCache.clear();
}

const BASH_HOSTS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
function attachBashHostPayloads(analysis, options, depth = options.depth || 0) {
    for (const leaf of analysis.leaves || []) {
        if (leaf.nested) {
            attachBashHostPayloads(leaf.nested, options, depth + 1);
            continue;
        }

        const name = String(leaf.executable || "")
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        if (!BASH_HOSTS.has(name)) {
            continue;
        }

        const flag = (leaf.args || []).findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(String(arg)));
        const payload = flag >= 0 ? leaf.args[flag + 1] : undefined;
        if (
            typeof payload !== "string" ||
            !payload ||
            /\[dynamic\]|[$`]/.test(payload) ||
            depth >= (options.maxDepth || LIMITS.maxDepth)
        ) {
            if (flag >= 0) {
                analysis.dynamicConstructs.push({ kind: "dynamic-nested-bash" });
                analysis.indeterminate = true;
            }

            continue;
        }

        leaf.nested = analyzeBash(payload, { ...options, shell: "bash", depth: depth + 1 });
        analysis.dynamicConstructs.push({ kind: "nested-bash" }, ...leaf.nested.dynamicConstructs);
        analysis.indeterminate ||= leaf.nested.indeterminate;
        attachBashHostPayloads(leaf.nested, options, depth + 1);
    }
}

function flattenLeaves(analysis) {
    return [
        ...(analysis.leaves || []),
        ...(analysis.leaves || []).flatMap((leaf) => (leaf.nested ? flattenLeaves(leaf.nested) : [])),
    ];
}

function clearlyReadOnly(analysis) {
    const leaves = flattenLeaves(analysis).filter((leaf) => leaf.executable !== "<redirect>");
    if (
        !leaves.length ||
        (analysis.redirects || []).some((redirect) =>
            String(typeof redirect === "string" ? redirect : redirect.operator || "").includes(">"),
        )
    ) {
        return false;
    }

    return leaves.every((leaf) => {
        const name = String(leaf.executable || "")
            .toLowerCase()
            .replace(/\.exe$/, "")
            .split(/[\\/]/)
            .pop();
        if (
            [
                "pwd",
                "ls",
                "printf",
                "echo",
                "cat",
                "less",
                "more",
                "true",
                "false",
                "whoami",
                "id",
                "uname",
                "date",
                "basename",
                "dirname",
                "realpath",
                "which",
                "where",
                "type",
                "grep",
                "rg",
                "head",
                "tail",
                "wc",
            ].includes(name)
        ) {
            return true;
        }

        if (name === "find") {
            return !findMutates(leaf.args);
        }

        if (name === "git") {
            return (
                ["status", "diff", "log", "show", "blame"].includes(String(leaf.args?.[0] || "").toLowerCase()) ||
                (String(leaf.args?.[0] || "").toLowerCase() === "branch" &&
                    (leaf.args || []).some((arg) => ["--list", "-l"].includes(arg)))
            );
        }

        if (/^(?:get|test|select|where|measure|compare)-/.test(name)) {
            return true;
        }

        return ["gci", "gl", "gps", "pwd", "dir"].includes(name);
    });
}

export function decideCommand(command, options = {}) {
    const mode = MODES.includes(options.mode) ? options.mode : "guard";
    if (mode === "off") {
        return { ...empty(), reason: "Command guard is off for this session." };
    }

    if (mode === "locked") {
        return {
            action: "deny",
            severity: "critical",
            category: "security",
            ruleIds: ["session.locked"],
            leaves: [],
            reason: "The command guard is locked after a critical attempt.",
            indeterminate: false,
        };
    }

    if (typeof command !== "string") {
        return malformedDecision();
    }

    // Enforcement always reparses the complete call. The cache is reserved for explicit analysis-only callers;
    // an approval must never reuse parser state from an earlier attempt.
    const analysis = analyzeCommand(command, { ...options, cache: false });
    const fatalKinds = new Set([
        "helper-unavailable",
        "helper-failure",
        "helper-timeout",
        "invalid-helper-json",
        "invalid-helper-result",
        "parser-exception",
        "input-limit",
        "output-limit",
        "token-limit",
        "command-limit",
        "element-limit",
        "redirection-limit",
        "literal-limit",
        "leaf-limit",
        "depth-limit",
    ]);
    const parserFailure =
        (analysis.dynamicConstructs || []).some((entry) => fatalKinds.has(entry.kind)) ||
        (analysis.parseErrors || []).some((error) =>
            /\blimit\b/i.test(typeof error === "string" ? error : error?.message || ""),
        );
    const decisions = evaluateRules(analysis, { ...options, criticalOnly: parserFailure });
    if (parserFailure) {
        // The structural analysis is unusable, so fall back to reading the raw text before settling for an ask.
        const unparsed = catastrophicTextScan(command, options);
        if (unparsed) {
            decisions.push(unparsed);
        }

        decisions.push({
            action: "ask",
            severity: "high",
            category: "dynamic",
            ruleIds: ["parser.indeterminate"],
            leaves: [],
            reason: "The command parser is unavailable, exceeded a safety limit, or failed; approval is required.",
            indeterminate: true,
        });
    }

    if ((analysis.parseErrors || []).length) {
        decisions.push({
            action: "ask",
            severity: "high",
            category: "dynamic",
            ruleIds: ["parser.syntax"],
            leaves: [],
            reason: "Malformed shell syntax requires approval.",
            indeterminate: true,
        });
    }

    if (analysis.indeterminate && !decisions.some((item) => item.ruleIds?.includes("parser.indeterminate"))) {
        decisions.push({
            action: "ask",
            severity: "high",
            category: "dynamic",
            ruleIds: ["parser.indeterminate"],
            leaves: [],
            reason: "The command could not be completely analyzed and requires approval.",
            indeterminate: true,
        });
    }

    // Guard stays quiet for determinate noncritical work, with one explicit exception set: rules such as
    // git.force-push and git.destructive that discard or rewrite work still surface as approvals rather than
    // running silently.
    const applicable =
        mode === "guard"
            ? decisions.filter(
                  (item) =>
                      item.action === "deny" ||
                      item.severity === "critical" ||
                      item.indeterminate ||
                      (item.ruleIds || []).some((id) => GUARD_APPROVAL_RULES.has(id)),
              )
            : decisions;
    const result = aggregateDecisions(applicable, options);
    if (mode === "strict" && result.action === "allow" && !clearlyReadOnly(analysis)) {
        return {
            ...aggregateDecisions(
                [
                    {
                        action: "ask",
                        severity: "medium",
                        category: "unknown",
                        ruleIds: ["strict.execution"],
                        leaves: [],
                        reason: "Strict mode requires approval for commands that are not proven read-only.",
                    },
                ],
                options,
            ),
            indeterminate: false,
        };
    }

    return { ...result, indeterminate: Boolean(result.indeterminate || analysis.indeterminate) };
}

export function decidePath(input, operation, options = {}) {
    const mode = MODES.includes(options.mode) ? options.mode : "guard";
    if (mode === "off") {
        return { ...empty(), reason: "Command guard is off for this session." };
    }

    if (mode === "locked") {
        return {
            action: "deny",
            severity: "critical",
            category: "security",
            ruleIds: ["session.locked"],
            leaves: [],
            reason: "The command guard is locked after a critical attempt.",
            indeterminate: false,
        };
    }

    const classification = classifyPath(input, { ...options, read: operation === "read" });
    const decision = pathDecision(input, { ...options, read: operation === "read" });
    if (mode === "strict" && operation !== "read" && decision.action === "allow") {
        decision.action = "ask";
        decision.severity = "medium";
        decision.category = "filesystem";
        decision.ruleIds = ["strict.mutation"];
        decision.reason = "Strict mode requires approval for mutation.";
    }

    return { ...aggregateDecisions([decision], options), indeterminate: Boolean(classification.indeterminate) };
}

export function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function bindingForChild(mode, nonce) {
    const childMode = mode === "strict" ? "strict" : "guard";

    return {
        mode: childMode,
        policyVersion: POLICY_VERSION,
        parentLocked: false,
        nonce: String(nonce || crypto.randomBytes(12).toString("hex")).slice(0, 64),
    };
}

export function validateBinding(value, parentMode = "guard") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);
    if (keys.length !== 4 || !["mode", "policyVersion", "parentLocked", "nonce"].every((key) => keys.includes(key))) {
        return false;
    }

    if (
        !["guard", "strict"].includes(value.mode) ||
        value.policyVersion !== POLICY_VERSION ||
        typeof value.nonce !== "string" ||
        !/^[A-Za-z0-9_-]{8,64}$/.test(value.nonce) ||
        typeof value.parentLocked !== "boolean"
    ) {
        return false;
    }

    if (value.parentLocked) {
        return false;
    }

    if (parentMode === "strict" && value.mode !== "strict") {
        return false;
    }

    return true;
}

function validateJsonValue(value, depth, seen, count) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return true;
    }

    if (typeof value === "number") {
        return Number.isFinite(value);
    }

    if (!value || typeof value !== "object" || depth > 16 || seen.has(value)) {
        return false;
    }

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.every(
                (item, index) => Object.hasOwn(value, index) && validateJsonValue(item, depth + 1, seen, count),
            );
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return false;
        }

        for (const key of Object.keys(value)) {
            count.value += 1;
            if (count.value > 256 || !validateJsonValue(value[key], depth + 1, seen, count)) {
                return false;
            }
        }

        return true;
    } finally {
        seen.delete(value);
    }
}

export function validateExtensionBindings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);
    if (keys.length > 16 || keys.some((key) => !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/.test(key))) {
        return false;
    }

    if (!validateJsonValue(value, 0, new Set(), { value: 0 })) {
        return false;
    }

    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024;
    } catch {
        return false;
    }
}

export function readChildBinding(env = process.env) {
    if (env.PI_SUBAGENT_CHILD !== "1") {
        return undefined;
    }

    try {
        const encoded = env.PI_SUBAGENT_EXTENSION_BINDINGS || "";
        if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
            return undefined;
        }

        const all = JSON.parse(encoded);
        if (!validateExtensionBindings(all)) {
            return undefined;
        }

        const binding = all["zenpi.command-guard/1"];

        return validateBinding(binding) ? binding : undefined;
    } catch {
        return undefined;
    }
}

export function injectBinding(input, mode, nonce) {
    const copy = { ...(input && typeof input === "object" ? input : {}) };
    const supplied = copy.extensionBindings;
    if (supplied !== undefined && !validateExtensionBindings(supplied)) {
        throw new Error("Malformed extension bindings.");
    }

    const bindings = supplied ? { ...supplied } : {};
    if (Object.hasOwn(bindings, "zenpi.command-guard/1")) {
        throw new Error("The reserved command-guard binding is supervisor-owned.");
    }

    bindings["zenpi.command-guard/1"] = bindingForChild(mode, nonce);
    if (!validateExtensionBindings(bindings)) {
        throw new Error("Extension bindings exceed the safety limits.");
    }

    copy.extensionBindings = bindings;

    return copy;
}

export const evaluatePolicy = decideCommand;
export const policyDecision = decideCommand;
export { redactCommand };
