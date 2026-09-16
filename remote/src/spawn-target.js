// Works out how to actually spawn Pi.
//
// On Windows an npm-installed `pi` is really `pi.cmd`, and Node cannot spawn a
// .cmd directly: bare `spawn("pi")` fails with ENOENT because PATHEXT is only
// consulted under a shell, and passing the .cmd path fails outright since the
// 2024 spawn hardening. Using `shell: true` would fix it by handing the whole
// command line to cmd.exe for parsing, which is exactly what we do not want.
//
// So we resolve the executable ourselves and, only for a batch shim, invoke
// cmd.exe explicitly with an argument string we quote. POSIX needs none of this
// and takes the straight path.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

const DIRECT_EXECUTABLE = new Set([".exe", ".com"]);
const BATCH_SHIM = new Set([".cmd", ".bat"]);

export function spawnTarget(
    command,
    args,
    { platform = process.platform, env = process.env, exists = fileExists } = {},
) {
    if (platform !== "win32") {
        return { file: command, args, options: {} };
    }

    const resolved = resolveOnWindows(command, env, exists);
    if (!resolved) {
        // Nothing found. Hand back the original so spawn produces its own
        // ENOENT, which names the command the user actually asked for.
        return { file: command, args, options: {} };
    }

    const extension = path.extname(resolved).toLowerCase();
    if (DIRECT_EXECUTABLE.has(extension)) {
        return { file: resolved, args, options: {} };
    }

    if (!BATCH_SHIM.has(extension)) {
        return { file: resolved, args, options: {} };
    }

    // cmd.exe /d /s /c "<quoted command line>". windowsVerbatimArguments stops
    // Node re-escaping what we have already quoted for cmd.exe's own parser.
    const commandLine = [resolved, ...args].map(quoteForCmd).join(" ");

    return {
        file: env.ComSpec || env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", `"${commandLine}"`],
        options: { windowsVerbatimArguments: true },
    };
}

function resolveOnWindows(command, env, exists) {
    const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);

    // An explicit path is never searched for on PATH.
    if (path.isAbsolute(command) || /[\\/]/u.test(command)) {
        return firstMatch(path.resolve(command), extensions, exists);
    }

    for (const directory of (env.PATH || env.Path || "").split(path.delimiter)) {
        if (!directory) {
            continue;
        }

        const match = firstMatch(path.join(directory, command), extensions, exists);
        if (match) {
            return match;
        }
    }

    return null;
}

function firstMatch(base, extensions, exists) {
    // An extension the user already supplied wins outright.
    if (extensions.includes(path.extname(base).toLowerCase()) && exists(base)) {
        return base;
    }

    for (const extension of extensions) {
        const candidate = `${base}${extension}`;
        if (exists(candidate)) {
            return candidate;
        }
    }

    // A bare extensionless file is not runnable on Windows, so it is not a
    // match: the npm `pi` shell shim sits next to `pi.cmd` and would otherwise
    // shadow it.
    return null;
}

function fileExists(candidate) {
    try {
        return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
        return false;
    }
}

// cmd.exe quoting, not shell quoting. A caret or ampersand inside an unquoted
// argument would otherwise be read as an operator.
export function quoteForCmd(value) {
    if (value.length > 0 && !/[\s"^&|<>()%!]/u.test(value)) {
        return value;
    }

    return `"${value.replace(/"/gu, '""')}"`;
}
