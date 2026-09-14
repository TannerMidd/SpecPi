"use strict";

// Root-only gitignore and boolean VS Code excludes, without dependencies.
// Match path components with dynamic programming, never a backtracking glob
// regex. Ancestors are evaluated independently: an excluded directory cannot
// be reopened by a rule for a descendant. Settings merge by key; false disables
// that key, rather than negating other enabled patterns.
const MAX_RULES = 1000;
const MAX_EXPANSION = 64;
const MAX_PATTERN_LENGTH = 4096;
const MAX_MATCH_WORK = 1_000_000;

function spend(budget, amount = 1) {
    budget.remaining -= amount;
    if (budget.remaining < 0) {
        throw new Error("Workspace ignore/exclude matching exceeded its work limit. Simplify the patterns.");
    }
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

function compileSegment(segment) {
    const characters = [...segment];
    const tokens = [];
    for (let index = 0; index < characters.length; index += 1) {
        const char = characters[index];
        if (char === "\\") {
            tokens.push({ literal: characters[++index] ?? "\\" });
        } else if (char === "*") {
            if (tokens.at(-1)?.kind !== "star") {
                tokens.push({ kind: "star" });
            }
        } else if (char === "?") {
            tokens.push({ kind: "any" });
        } else if (char === "[") {
            let cursor = index + 1;
            let body = "";
            if (characters[cursor] === "!" || characters[cursor] === "^") {
                body = "^";
                cursor += 1;
            }

            if (characters[cursor] === "]") {
                body += "\\]";
                cursor += 1;
            }

            for (; cursor < characters.length && characters[cursor] !== "]"; cursor += 1) {
                const current = characters[cursor];
                if (current === "\\" && cursor + 1 < characters.length) {
                    const literal = characters[++cursor];
                    body += ["\\", "]", "[", "^", "-"].includes(literal) ? `\\${literal}` : literal;
                } else {
                    body += current === "[" || current === "^" ? `\\${current}` : current;
                }
            }

            if (cursor === characters.length) {
                tokens.push({ literal: "[" });
            } else {
                // A regex is used only for one character class against one
                // character. Invalid ranges invalidate this rule alone.
                tokens.push({ class: new RegExp(`^[${body}]$`, "u") });
                index = cursor;
            }
        } else {
            tokens.push({ literal: char });
        }
    }

    return tokens;
}

function matchSegment(tokens, value, budget) {
    const characters = [...value];
    spend(budget, (tokens.length + 1) * (characters.length + 1));
    let previous = new Uint8Array(characters.length + 1);
    previous[0] = 1;
    for (const token of tokens) {
        const next = new Uint8Array(characters.length + 1);
        if (token.kind === "star") {
            next[0] = previous[0];
        }

        for (let index = 1; index <= characters.length; index += 1) {
            const char = characters[index - 1];
            next[index] =
                token.kind === "star"
                    ? previous[index] || next[index - 1]
                    : previous[index - 1] &&
                      (token.kind === "any" || token.literal === char || token.class?.test(char));
        }

        previous = next;
    }

    return previous[characters.length] === 1;
}

function matches(rule, segments, budget) {
    if (!rule.anchored) {
        return matchSegment(rule.parts[0], segments.at(-1), budget);
    }

    spend(budget, (rule.parts.length + 1) * (segments.length + 1));
    let previous = new Uint8Array(segments.length + 1);
    previous[0] = 1;
    for (const [partIndex, part] of rule.parts.entries()) {
        const next = new Uint8Array(segments.length + 1);
        if (part === null) {
            // A trailing /** requires a descendant, unlike an intermediate **/.
            const trailing = partIndex === rule.parts.length - 1;
            next[0] = trailing ? 0 : previous[0];
            for (let index = 1; index <= segments.length; index += 1) {
                next[index] = next[index - 1] || (trailing ? previous[index - 1] : previous[index]);
            }
        } else {
            for (let index = 1; index <= segments.length; index += 1) {
                next[index] = previous[index - 1] && matchSegment(part, segments[index - 1], budget);
            }
        }

        previous = next;
    }

    return previous[segments.length] === 1;
}

function expandBraces(pattern) {
    // Bound intermediate expansion too, not just the final result.
    let pending = [pattern];
    for (let depth = 0; depth < 5; depth += 1) {
        const expanded = [];
        let changed = false;
        for (const value of pending) {
            const open = value.indexOf("{");
            let nesting = 0;
            let close = -1;
            const alternatives = [];
            let start = open + 1;
            for (let index = open; open !== -1 && index < value.length; index += 1) {
                if (value[index] === "{") {
                    nesting += 1;
                } else if (value[index] === "}") {
                    nesting -= 1;
                    if (nesting === 0) {
                        alternatives.push(value.slice(start, index));
                        close = index;
                        break;
                    }
                } else if (value[index] === "," && nesting === 1) {
                    alternatives.push(value.slice(start, index));
                    start = index + 1;
                }

                if (alternatives.length >= MAX_EXPANSION) {
                    return [pattern];
                }
            }

            if (close === -1) {
                expanded.push(value);
            } else {
                changed = true;
                for (const alternative of alternatives) {
                    expanded.push(value.slice(0, open) + alternative + value.slice(close + 1));
                    if (expanded.length > MAX_EXPANSION) {
                        return [pattern];
                    }
                }
            }
        }

        pending = expanded;
        if (!changed) {
            return pending;
        }
    }

    return pending.some((entry) => entry.includes("{")) ? [pattern] : pending;
}

function compileBody(body, { anchored, exclude, dirOnly = false }) {
    if (body.length > MAX_PATTERN_LENGTH) {
        throw new Error("Workspace ignore/exclude patterns must not exceed 4096 characters.");
    }

    try {
        const parts = body.split("/").map((segment) => (segment === "**" && anchored ? null : compileSegment(segment)));

        return { parts, anchored, exclude, dirOnly };
    } catch (error) {
        if (error instanceof SyntaxError) {
            return null;
        }

        throw error;
    }
}

function addRule(rules, rule) {
    if (rule) {
        if (rules.length >= MAX_RULES) {
            throw new Error("Workspace ignore/exclude filtering supports at most 1000 rules.");
        }

        rules.push(rule);
    }
}

function parseIgnoreFile(text) {
    const rules = [];
    for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
        const line = stripUnescapedTrailingSpaces(rawLine);
        if (!line || line.startsWith("#")) {
            continue;
        }

        const negated = line.startsWith("!");
        let body = negated ? line.slice(1) : line;
        const hadLeadingSlash = body.startsWith("/");
        const dirOnly = body.endsWith("/") && !body.endsWith("\\/");
        if (dirOnly) {
            body = body.slice(0, -1);
        }

        if (hadLeadingSlash) {
            body = body.slice(1);
        }

        if (body) {
            addRule(
                rules,
                compileBody(body, { anchored: hadLeadingSlash || body.includes("/"), exclude: !negated, dirOnly }),
            );
        }
    }

    return rules;
}

function excludedBy(rules, relativePath, isDirectory) {
    if (!rules.length || typeof relativePath !== "string" || !relativePath) {
        return false;
    }

    if (relativePath.length > MAX_PATTERN_LENGTH) {
        throw new Error("Workspace paths exceed the ignore/exclude matching limit.");
    }

    const normalized = relativePath
        .replaceAll("\\", "/")
        .replace(/^\.\//u, "")
        .replace(/^\/+|\/+$/gu, "");
    const segments = normalized.split("/");
    if (!normalized || segments.includes("..")) {
        return false;
    }

    const budget = { remaining: MAX_MATCH_WORK };
    // Parent exclusion prevents traversal. A parent negation only reopens
    // that parent; it does not cancel a rule matching the file itself.
    for (let depth = 1; depth <= segments.length; depth += 1) {
        let excluded = false;
        const directory = depth < segments.length || isDirectory;
        const target = segments.slice(0, depth);
        for (const rule of rules) {
            spend(budget);
            if ((!rule.dirOnly || directory) && matches(rule, target, budget)) {
                excluded = rule.exclude;
            }
        }

        if (excluded) {
            return true;
        }
    }

    return false;
}

function compileSettingExcludes(filesEntries, searchEntries) {
    const rules = [];
    for (const [pattern, value] of Object.entries({ ...filesEntries, ...searchEntries })) {
        if (!pattern || value !== true) {
            continue;
        }

        let body = pattern.replace(/^\//u, "");
        const dirOnly = body.endsWith("/") && !body.endsWith("\\/");
        if (dirOnly) {
            body = body.slice(0, -1);
        }

        if (body.length > MAX_PATTERN_LENGTH) {
            throw new Error("Workspace ignore/exclude patterns must not exceed 4096 characters.");
        }

        if (body) {
            for (const expanded of expandBraces(body)) {
                addRule(rules, compileBody(expanded, { anchored: true, exclude: true, dirOnly }));
            }
        }
    }

    return rules;
}

module.exports = {
    expandBraces,
    compileSettingExcludes,
    isIgnored: excludedBy,
    isSettingExcluded: excludedBy,
    parseIgnoreFile,
};
