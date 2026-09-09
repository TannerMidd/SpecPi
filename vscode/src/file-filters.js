"use strict";

// Dependency-free workspace filtering for file suggestions, folder listings,
// and mention attachments: VS Code exclude settings plus the workspace-root
// .gitignore. The SpecPi Chat package ships without dependencies, so these
// matchers are implemented here and covered directly by unit tests.
//
// Gitignore semantics follow git's documented behavior for one root ignore
// file: blank and comment lines, `!` negation with last-match precedence,
// trailing-slash directory rules, anchored patterns containing a slash,
// unanchored basename patterns, `**`, `*`, `?`, and `[...]` classes. One
// deviation from git: a negation beneath a directory excluded by a bare
// directory rule (rather than `dir/**`) is honored, because suggestions
// filter flat paths instead of walking a tree like git.
//
// VS Code exclude settings (`files.exclude`, `search.exclude`) use anchored
// globs with the same wildcard grammar plus `{a,b}` alternation. Entries map
// a glob to a boolean; `true` excludes and `false` re-includes, evaluated in
// object-key order with the last match deciding.

const MAX_RULES = 1000;
const MAX_EXPANSION = 64;

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripUnescapedTrailingSpaces(line) {
    let end = line.length;
    while (end > 0 && line[end - 1] === " ") {
        let backslashes = 0;
        let cursor = end - 2;
        while (cursor >= 0 && line[cursor] === "\\") {
            backslashes += 1;
            cursor -= 1;
        }

        if (backslashes % 2 === 1) {
            break;
        }

        end -= 1;
    }

    return line.slice(0, end);
}

function parseClass(pattern, start) {
    // Parses `[...]` beginning at `start`. Returns the regex fragment and the
    // index after the closing bracket, or null when the class is unterminated.
    let index = start + 1;
    let body = "";
    let negated = false;
    if (pattern[index] === "!" || pattern[index] === "^") {
        negated = true;
        index += 1;
    }

    if (pattern[index] === "]") {
        body += "\\]";
        index += 1;
    }

    while (index < pattern.length && pattern[index] !== "]") {
        if (pattern[index] === "\\" && index + 1 < pattern.length) {
            body += escapeRegex(pattern[index + 1]);
            index += 2;
        } else {
            body += pattern[index] === "\\" ? "\\\\" : pattern[index];
            index += 1;
        }
    }

    if (index >= pattern.length) {
        return null;
    }

    return { source: `[${negated ? "^" : ""}${body}]`, next: index + 1 };
}

function globBodyToRegexSource(body) {
    // Converts the shared wildcard grammar to a regex source for one
    // slash-delimited path pattern without leading or trailing slashes.
    let source = "";
    let index = 0;
    while (index < body.length) {
        const char = body[index];
        if (char === "\\") {
            const next = body[index + 1];
            source += next === undefined ? "\\\\" : escapeRegex(next);
            index += next === undefined ? 1 : 2;
        } else if (char === "*" && body.startsWith("**", index)) {
            if (body.startsWith("**/", index)) {
                source += "(?:.*/)?";
                index += 3;
            } else if (index >= 1 && body[index - 1] === "/" && index + 2 === body.length) {
                // Trailing `/**`: everything beneath, but never the segment
                // itself. The literal slash was already emitted above.
                source = `${source.replace(/\/$/u, "")}/.+`;
                index += 3;
            } else {
                source += ".*";
                index += 2;
            }
        } else if (char === "*") {
            source += "[^/]*";
            index += 1;
        } else if (char === "?") {
            source += "[^/]";
            index += 1;
        } else if (char === "[") {
            const parsed = parseClass(body, index);
            if (!parsed) {
                source += "\\[";
                index += 1;
            } else {
                source += parsed.source;
                index = parsed.next;
            }
        } else {
            source += escapeRegex(char);
            index += 1;
        }
    }

    return source;
}

function expandBraces(pattern, depth = 0) {
    if (depth > 4 || !pattern.includes("{")) {
        return [pattern];
    }

    const open = pattern.indexOf("{");
    let nesting = 0;
    let close = -1;
    for (let index = open; index < pattern.length; index += 1) {
        if (pattern[index] === "{") {
            nesting += 1;
        } else if (pattern[index] === "}") {
            nesting -= 1;
            if (nesting === 0) {
                close = index;
                break;
            }
        }
    }

    if (close === -1) {
        return [pattern];
    }

    const prefix = pattern.slice(0, open);
    const suffix = pattern.slice(close + 1);
    const alternatives = [];
    let current = "";
    let innerNesting = 0;
    for (const char of pattern.slice(open + 1, close)) {
        if (char === "{") {
            innerNesting += 1;
            current += char;
        } else if (char === "}") {
            innerNesting -= 1;
            current += char;
        } else if (char === "," && innerNesting === 0) {
            alternatives.push(current);
            current = "";
        } else {
            current += char;
        }
    }

    alternatives.push(current);
    const expanded = [];
    for (const alternative of alternatives) {
        for (const tail of expandBraces(`${prefix}${alternative}${suffix}`, depth + 1)) {
            expanded.push(tail);
        }
    }

    if (expanded.length > MAX_EXPANSION || expanded.some((entry) => entry.includes("{"))) {
        return [pattern];
    }

    return expanded;
}

function compileBody(body, { anchored, exclude, dirOnly = false } = {}) {
    const source = anchored ? `^${globBodyToRegexSource(body)}$` : `^(?:.*/)?${globBodyToRegexSource(body)}$`;

    return { regex: new RegExp(source, "u"), exclude, dirOnly };
}

function normalizeRelativePath(value) {
    if (typeof value !== "string") {
        return "";
    }

    const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
    if (!normalized || normalized.split("/").includes("..")) {
        return "";
    }

    return normalized;
}

function pathWithAncestors(value) {
    const segments = value.split("/");
    const ancestors = [];
    for (let depth = 1; depth < segments.length; depth += 1) {
        ancestors.push(segments.slice(0, depth).join("/"));
    }

    return [value, ...ancestors];
}

function parseIgnoreFile(text) {
    const rules = [];
    for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
        if (rules.length >= MAX_RULES) {
            break;
        }

        const line = stripUnescapedTrailingSpaces(rawLine);
        if (!line || line.startsWith("#")) {
            continue;
        }

        let body = line;
        let negated = false;
        if (body.startsWith("!")) {
            negated = true;
            body = body.slice(1);
        }

        let dirOnly = false;
        const hadLeadingSlash = body.startsWith("/");
        // A trailing `\/` is an escaped slash, not a directory marker.
        if (body.endsWith("/") && !body.endsWith("\\/")) {
            dirOnly = true;
            body = body.slice(0, -1);
        }

        if (hadLeadingSlash) {
            body = body.slice(1);
        }

        if (!body) {
            continue;
        }

        // Only a slash inside the pattern anchors it; a leading or trailing
        // slash says where matching happens, not where the name may sit. A
        // stripped leading slash still anchors the pattern.
        const anchored = hadLeadingSlash || body.includes("/");
        rules.push(compileBody(body, { anchored, exclude: !negated, dirOnly }));
    }

    return rules;
}

function excludedBy(rules, relativePath, isDirectory) {
    // Shared by gitignore rules and setting excludes: both grammars compile to
    // the same rule shape and both let the last matching rule decide.
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
        return false;
    }

    const targets = pathWithAncestors(normalized);
    let excluded = false;
    for (const rule of rules) {
        if (rule.dirOnly && !isDirectory) {
            // A directory rule covers files beneath it through ancestor
            // matching only; it never matches a file that merely shares the
            // directory's name, so the full path is excluded from targets.
            if (targets.slice(1).some((target) => rule.regex.test(target))) {
                excluded = rule.exclude;
            }

            continue;
        }

        if (targets.some((target) => rule.regex.test(target))) {
            excluded = rule.exclude;
        }
    }

    return excluded;
}

function isIgnored(rules, relativePath, isDirectory = false) {
    return excludedBy(rules, relativePath, isDirectory);
}

function compileSettingExcludes(filesEntries, searchEntries) {
    const rules = [];
    for (const entries of [filesEntries, searchEntries]) {
        for (const [pattern, value] of Object.entries(entries || {})) {
            if (rules.length >= MAX_RULES || typeof pattern !== "string" || !pattern || typeof value !== "boolean") {
                continue;
            }

            let body = pattern;
            let dirOnly = false;
            if (body.startsWith("/")) {
                body = body.slice(1);
            }

            if (body.endsWith("/") && !body.endsWith("\\/")) {
                dirOnly = true;
                body = body.slice(0, -1);
            }

            if (!body) {
                continue;
            }

            for (const expanded of expandBraces(body)) {
                rules.push(compileBody(expanded, { anchored: true, exclude: value, dirOnly }));
            }
        }
    }

    return rules;
}

function isSettingExcluded(rules, relativePath, isDirectory = false) {
    return excludedBy(rules, relativePath, isDirectory);
}

module.exports = {
    expandBraces,
    globBodyToRegexSource,
    compileSettingExcludes,
    isIgnored,
    isSettingExcluded,
    parseIgnoreFile,
};
