import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMAND_GUARD_MANAGED_FILES } from "./managed-files.mjs";

export const PATH_LIMIT = 4096;
const unixProtected = [
    /^\/$/,
    /^\/boot(?:\/|$)/i,
    /^\/etc(?:\/|$)/i,
    /^\/bin(?:\/|$)/i,
    /^\/sbin(?:\/|$)/i,
    /^\/(?:usr|lib|lib64|opt|srv|var)(?:\/|$)/i,
    /^\/root\/?$/i,
    /^\/home\/?$/i,
    /^\/home\/[^/]+\/?$/i,
    // macOS system roots. /System/Volumes/Data/… is the firmlinked user-data tree, not system state.
    /^\/System(?:$|\/(?!Volumes\/Data\/.))/i,
    /^\/(?:Library|Applications|cores)(?:\/|$)/i,
    /^\/Users\/?$/i,
    /^\/Users\/[^/]+\/?$/i,
    /^\/Volumes\/?$/i,
    /^\/Volumes\/[^/]+\/?$/i,
    /^\/private\/?$/i,
    /^\/private\/(?:etc|var|db)(?:\/|$)/i,
];
const unixCatastrophic = [
    /^\/$/,
    /^\/boot(?:\/|$)/i,
    /^\/(?:etc|bin|sbin|lib|lib64|usr|opt|srv|var)\/?$/i,
    /^\/usr\/(?:bin|sbin|lib|lib64)\/?$/i,
    /^\/var\/lib\/?$/i,
    // /etc, /var and /db are firmlinked to /private/… on macOS, so the /private spelling reaches the same
    // system state and must carry the same weight as the short form.
    /^\/private\/(?:etc|var|db)\/?$/i,
    /^\/(?:root|home|Users|Volumes|private)\/?$/i,
    /^\/(?:home|Users|Volumes)\/[^/]+\/?$/i,
    /^\/System\/?$/i,
    /^\/System\/Library\/?$/i,
    /^\/(?:Library|Applications|cores)\/?$/i,
    /^\/Library\/(?:LaunchDaemons|LaunchAgents|PrivilegedHelperTools)(?:\/|$)/i,
    /^\/(?:etc|private\/etc)\/(?:passwd|shadow|sudoers|fstab|crypttab|ld\.so\.preload)$/i,
    /^\/(?:bin|sbin)\/(?:sh|bash|init|systemd)$/i,
    /^\/usr\/lib\/systemd\/systemd$/i,
];
const unixSensitive = [
    /(?:^|\/)(?:\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zshenv|\.zprofile|\.zlogin)$/i,
];
const windowsProtected = [
    /^[a-z]:[\\/]$/i,
    /^[a-z]:[\\/]Windows(?:[\\/]|$)/i,
    /^[a-z]:[\\/](?:Boot|EFI|Recovery)(?:[\\/]|$)/i,
    /^[a-z]:[\\/](?:ProgramData|Program Files(?: \(x86\))?)(?:[\\/]|$)/i,
    /^[a-z]:[\\/]Users[\\/]?$/i,
    /^[a-z]:[\\/]Users[\\/][^\\/]+[\\/]?$/i,
    /^\\\\[^\\/]+\\[^\\/]+[\\/]?$/i,
];
const windowsCatastrophic = [
    /^[a-z]:[\\\/]$/i,
    /^[a-z]:[\\\/]Windows[\\\/]?$/i,
    /^[a-z]:[\\\/]Windows[\\\/]System32[\\\/]?$/i,
    // The EFI system partition and the Recovery tree are boot state: losing either can leave an unbootable host.
    /^[a-z]:[\\\/](?:Boot|EFI|Recovery)(?:[\\\/]|$)/i,
    /^[a-z]:[\\\/]Users[\\\/]?$/i,
    /^[a-z]:[\\\/]Users[\\\/][^\\\/]+[\\\/]?$/i,
    /^[a-z]:[\\\/]Windows[\\\/]System32[\\\/]config[\\\/](?:SAM|SECURITY|SYSTEM)$/i,
    /^[a-z]:[\\\/]Windows[\\\/](?:System32[\\\/])?(?:ntoskrnl\.exe|winload\.exe)$/i,
    /^\\\\[^\\\/]+\\[^\\\/]+[\\\/]?$/i,
];
const windowsSensitive = [
    /(?:^|[\\/])Documents[\\/](?:WindowsPowerShell|PowerShell)[\\/](?:Microsoft\.)?PowerShell_profile\.ps1$/i,
    /(?:^|[\\/])profile\.ps1$/i,
];
// Credential locations are matched by credential-shaped NAMES, never by bare words that ordinary source trees
// use as directories. `credentials`, `token`, `secret`, `passwd` and `shadow` were matched as standalone path
// segments, so a monorepo's packages/token/, src/secret/ or app/credentials/ became a critical read denial on
// every file beneath them. Each now needs a dot prefix, a credential extension, or a system location.
const privatePath =
    /^\/proc\/(?:\d+|self|thread-self)\/(?:environ|mem)(?:$|\/)|(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.gnupg)(?:[\\/]|$)|(?:^|[\\/])(?:\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.credentials|\.token|\.secret|\.secrets|id_rsa|id_ed25519|id_ecdsa|id_dsa|private\.key|config\.gcloud|hosts\.yml|ntuser\.dat|login data)(?:$|[\\/])|^\/(?:etc|private\/etc)\/(?:passwd|shadow|gshadow|sudoers)(?:$|[\\/])|(?:^|[\\/])(?:credentials|token|secret|secrets)\.(?:json|ya?ml|ini|toml|txt|enc)$|(?:^|[\\/])(?:\.docker|\.kube)[\\/]config(?:\.json)?$|(?:^|[\\/])\.config[\\/]gcloud(?:[\\/]|$)|(?:^|[\\/])Windows[\\/]System32[\\/]config[\\/](?:SAM|SECURITY|SYSTEM)(?:$|[\\/])|(?:^|[\\/])(?:AppData[\\/](?:Roaming|Local)[\\/])?Microsoft[\\/](?:Credentials|Vault|Protect)(?:[\\/]|$)|(?:^|[\\/])Library[\\/]Keychains(?:[\\/]|$)|\.(?:pem|p12|pfx|key)$/i;

// A .pi directory is Pi state wherever it appears, including the default agent directory.
const dotPi = /(?:^|[\\/])\.pi(?:[\\/]|$)/i;
// Pi and SpecPi private state is identified by LOCATION, not by name. Matching these as bare relative segments
// protected every repository that merely contained a specpi/ or extensions/command-guard/ path — SpecPi's own
// source tree included — and the unanchored POSIX variant matched ordinary project files such as
// src/api/session.ts ("pi" inside "api", then "session"), denying them critically and locking the session.
const agentPrivateState = /^(?:specpi[\\/](?:manifest\.json|backups|wishlist))(?:[\\/]|$)/i;
const agentPrivateName = /^(?:auth|sessions?|history|missions?|trust|private)[^\\/]*(?:[\\/]|$)/i;
const agentGuardSource = /^extensions[\\/]command-guard(?:[\\/]|$)/i;
// The installed state Guard must keep intact to keep enforcing, expressed as path segments so containment can be
// tested in BOTH directions. A regex prefix test only answers "is the target inside this subtree"; deleting an
// ancestor that CONTAINS the subtree reaches the same state and must weigh the same.
const enforcementNodes = [
    ["settings.json"],
    ["specpi", "manifest.json"],
    ...COMMAND_GUARD_MANAGED_FILES.map((name) => ["extensions", "command-guard", name]),
];
function agentDirectories(windows) {
    const api = windows ? path.win32 : path.posix;
    const configured = process.env.PI_CODING_AGENT_DIR;
    const fallback = api.join(slash(os.homedir(), windows), ".pi", "agent");
    const lexical = api.resolve(configured ? slash(configured, windows) : fallback);
    const canonical = canonicalNearest(lexical, windows);
    const compare = (entry) => (windows ? entry.toLowerCase() : entry);
    const roots = canonical ? [lexical, slash(canonical, windows)] : [lexical];

    return roots.filter((root, index) => roots.findIndex((entry) => compare(entry) === compare(root)) === index);
}

// Returns the path's location relative to either the lexical or canonical agent directory, or undefined when it
// is outside both. Comparing both roots prevents a configured symlink or junction from creating an alternate
// spelling that bypasses enforcement-node protection.
function agentRelative(value, windows) {
    const compare = (entry) => (windows ? entry.toLowerCase() : entry);
    const separator = windows ? "\\" : "/";
    const candidate = compare(value);
    for (const root of agentDirectories(windows)) {
        const base = compare(root);
        if (candidate === base) {
            return "";
        }

        if (candidate.startsWith(`${base}${separator}`)) {
            return value.slice(root.length + 1);
        }
    }

    return undefined;
}

// True when mutating `value` would reach guard-enforcement state, whether the target is a managed node, IS the
// agent directory, or is an ancestor that contains one. Managed files are checked as nodes rather than protecting
// the whole command-guard directory, so unrelated test descendants remain ordinary work.
function reachesEnforcementState(value, windows) {
    const relative = agentRelative(value, windows);
    if (relative === undefined) {
        return false;
    }

    if (relative === "") {
        return true;
    }

    const compare = (entry) => (windows ? entry.toLowerCase() : entry);
    const parts = relative.split(/[\\/]/).filter(Boolean);

    return enforcementNodes.some((node) => {
        if (parts.length > node.length) {
            return false;
        }

        return parts.every((part, index) => compare(part) === compare(node[index]));
    });
}

function slash(value, windows) {
    return windows ? value.replaceAll("/", "\\") : value.replaceAll("\\", "/");
}

function lexical(value, cwd, windows) {
    let raw = String(value).slice(0, PATH_LIMIT);
    if (!windows && raw === "~") {
        raw = os.homedir();
    } else if (!windows && raw.startsWith("~/")) {
        raw = path.posix.join(os.homedir(), raw.slice(2));
    }

    if (windows) {
        const normalized = slash(raw, true);
        const base =
            path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")
                ? normalized
                : path.win32.resolve(slash(cwd, true), normalized);

        return trimWin32Components(path.win32.normalize(base).replace(/\\+$/, (m) => (m.length > 1 ? "\\" : m)));
    }

    return path.posix.normalize(path.posix.isAbsolute(raw) ? raw : path.posix.resolve(cwd, raw));
}

// Win32 discards trailing dots and spaces from every path component, so `C:\Windows.` and `C:\Windows ` open
// `C:\Windows`. Comparing the untrimmed spelling let that punctuation walk a protected target past every pattern.
// `.` and `..` are real components and must survive.
function trimWin32Components(value) {
    const prefix = /^(\\\\[?.]\\|\\\\)/.exec(value);
    const head = prefix ? prefix[0] : "";
    const body = value.slice(head.length);

    return (
        head +
        body
            .split("\\")
            .map((part) => (part === "." || part === ".." ? part : part.replace(/[. ]+$/, "") || part))
            .join("\\")
    );
}

function canonicalNearest(value, windows) {
    const api = windows ? fs.realpathSync.native : fs.realpathSync;
    const pathApi = windows ? path.win32 : path.posix;
    let current = value;
    try {
        return api(current);
    } catch {
        /* Find the nearest existing ancestor without enumerating protected directories. */
    }

    const suffix = [];
    while (current && current !== pathApi.dirname(current)) {
        suffix.unshift(pathApi.basename(current));
        current = pathApi.dirname(current);
        try {
            return pathApi.join(api(current), ...suffix);
        } catch {
            /* continue */
        }
    }

    return undefined;
}

function isProtected(value, windows, read, mode) {
    if (read && (privatePath.test(value) || dotPi.test(value))) {
        return true;
    }

    const system = (windows ? windowsProtected : unixProtected).some((pattern) => pattern.test(value));
    const catastrophic = (windows ? windowsCatastrophic : unixCatastrophic).some((pattern) => pattern.test(value));
    if (!read && (mode === "guard" || mode === "strict") && catastrophic) {
        return true;
    }

    const enforcement = !read && reachesEnforcementState(value, windows);
    if (!read && (mode === "guard" || mode === "strict")) {
        return enforcement;
    }

    const relative = agentRelative(value, windows);
    const agentPrivate =
        relative !== undefined && (agentPrivateState.test(relative) || agentPrivateName.test(relative));
    if (read) {
        return agentPrivate;
    }

    const sensitive = (windows ? windowsSensitive : unixSensitive).some((pattern) => pattern.test(value));

    return (
        system ||
        sensitive ||
        privatePath.test(value) ||
        dotPi.test(value) ||
        agentPrivate ||
        (relative !== undefined && agentGuardSource.test(relative))
    );
}

export function classifyPath(input, options = {}) {
    const windows =
        options.platform === "win32" ||
        options.platform === "windows" ||
        (process.platform === "win32" && !options.platform);
    const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
    if (typeof input !== "string" || !input || Buffer.byteLength(input, "utf8") > PATH_LIMIT) {
        return { protected: false, indeterminate: true, reason: "The path is malformed or exceeds the safety limit." };
    }

    let requested = input;
    const shellName = String(options.shell || "").toLowerCase();
    const bashOnWindows = windows && /^(?:bash|sh|zsh|dash|ksh|fish)$/i.test(shellName);
    // PowerShell resolves ~ to the user profile exactly as a POSIX shell does, so `Remove-Item -Recurse -Force ~`
    // is whole-profile deletion. Expanding it only for bash left the native Windows shell spelling unprotected.
    const tildeHome = bashOnWindows || !windows || /^(?:powershell|pwsh)$/.test(shellName);
    if (windows && tildeHome && (requested === "~" || /^~[\\/]/.test(requested))) {
        requested = path.win32.join(os.homedir(), requested === "~" ? "" : slash(requested.slice(2), true));
    } else if (bashOnWindows) {
        const msysDrive = /^\/(?:cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(requested);
        if (msysDrive) {
            requested = `${msysDrive[1]}:\\${String(msysDrive[2] || "").replaceAll("/", "\\")}`;
        }
    }

    const lexicalPath = lexical(requested, cwd, windows);
    const protectedLexical = isProtected(lexicalPath, windows, Boolean(options.read), options.mode);
    const normalizedCwd = lexical(cwd, cwd, windows);
    const comparable = (value) => (windows ? value.toLowerCase() : value);
    const within = (candidate, root) =>
        comparable(candidate) === comparable(root) ||
        comparable(candidate).startsWith(`${comparable(root)}${windows ? "\\" : "/"}`);
    if (options.read && protectedLexical) {
        return {
            input,
            lexical: lexicalPath,
            canonical: undefined,
            protected: true,
            device: false,
            ads: false,
            withinWorkspace: within(lexicalPath, normalizedCwd),
            indeterminate: false,
            kind: "protected",
        };
    }

    const canonicalPath = canonicalNearest(lexicalPath, windows);
    const protectedCanonical = canonicalPath
        ? isProtected(slash(canonicalPath, windows), windows, Boolean(options.read), options.mode)
        : false;
    const canonicalCwd = canonicalNearest(normalizedCwd, windows);
    const withinWorkspace =
        within(lexicalPath, normalizedCwd) && (!canonicalPath || !canonicalCwd || within(canonicalPath, canonicalCwd));
    const safePseudoDevice =
        !windows && /^\/dev\/(?:null|zero|random|urandom|stdin|stdout|stderr|fd\/[012])$/i.test(lexicalPath);
    const device = windows
        ? lexicalPath.startsWith("\\\\.") || lexicalPath.startsWith("\\\\?")
            ? lexicalPath[3] === "\\"
            : lexicalPath.toLowerCase().startsWith("\\\\device\\")
        : !safePseudoDevice && /^\/dev(?:\/|$)/.test(lexicalPath);
    const ads = windows && /:[^\\/]+$/.test(lexicalPath.slice(3));
    const indeterminate = !canonicalPath && (protectedLexical || (windows && lexicalPath.startsWith("\\\\")));

    return {
        input,
        lexical: lexicalPath,
        canonical: canonicalPath,
        protected: protectedLexical || protectedCanonical || device || ads,
        device,
        ads,
        withinWorkspace,
        indeterminate,
        kind: device
            ? "device"
            : ads
              ? "alternate-data-stream"
              : protectedLexical || protectedCanonical
                ? "protected"
                : "ordinary",
    };
}

// True when the path resolves to installed state required to enforce the guard. A checkout that merely
// contains a specpi/ or extensions/command-guard/ directory remains ordinary work.
export function isAgentPath(input, options = {}) {
    const result = classifyPath(input, options);
    if (typeof result.lexical !== "string") {
        return false;
    }

    const windows =
        options.platform === "win32" ||
        options.platform === "windows" ||
        (process.platform === "win32" && !options.platform);

    return (
        reachesEnforcementState(result.lexical, windows) ||
        (result.canonical !== undefined && reachesEnforcementState(slash(result.canonical, windows), windows))
    );
}

export function normalizePath(input, options = {}) {
    return classifyPath(input, options).lexical;
}

export function isProtectedPath(input, options = {}) {
    return classifyPath(input, options).protected;
}

export function pathDecision(input, options = {}) {
    const result = classifyPath(input, options);

    return result.protected
        ? {
              action: "deny",
              severity: "critical",
              category: "protected-path",
              ruleIds: ["path.protected"],
              leaves: [],
              reason: "The requested path is protected.",
              lockSession: !options.read,
          }
        : result.indeterminate
          ? {
                action: "ask",
                severity: "high",
                category: "protected-path",
                ruleIds: ["path.canonicalization"],
                leaves: [],
                reason: "The requested path could not be safely canonicalized.",
                lockSession: false,
            }
          : {
                action: "allow",
                severity: "low",
                category: "filesystem",
                ruleIds: [],
                leaves: [],
                reason: "The path is outside protected locations.",
                lockSession: false,
            };
}
