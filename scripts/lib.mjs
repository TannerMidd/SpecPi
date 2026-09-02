import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const AGENTS_START = "<!-- specpi:start -->";
export const AGENTS_END = "<!-- specpi:end -->";
export const SHELL_START = "# >>> SpecPi >>>";
export const SHELL_END = "# <<< SpecPi <<<";

export function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}

export function deepEqual(a, b) {
    return isDeepStrictEqual(a, b);
}

export function packageSource(entry) {
    return typeof entry === "string" ? entry : entry?.source;
}

export function packageIdentity(entry) {
    const source = packageSource(entry);
    if (typeof source !== "string") {
        return undefined;
    }

    if (!source.startsWith("npm:")) {
        return source;
    }

    const spec = source.slice(4);
    if (spec.startsWith("@")) {
        const slash = spec.indexOf("/");
        const versionAt = slash < 0 ? -1 : spec.indexOf("@", slash);

        return `npm:${versionAt < 0 ? spec : spec.slice(0, versionAt)}`;
    }

    const versionAt = spec.lastIndexOf("@");

    return `npm:${versionAt > 0 ? spec.slice(0, versionAt) : spec}`;
}

export function mergePackages(existing, desired) {
    const result = Array.isArray(existing) ? structuredClone(existing) : [];
    for (const wanted of desired) {
        const identity = packageIdentity(wanted);
        const index = result.findIndex((entry) => packageIdentity(entry) === identity);
        if (index >= 0) {
            result[index] = structuredClone(wanted);
        } else {
            result.push(structuredClone(wanted));
        }
    }

    return result;
}

export function restorePackageChanges(current, changes, warnings = []) {
    const result = Array.isArray(current) ? structuredClone(current) : [];
    for (const change of changes) {
        const currentIndex = result.findIndex((entry) => packageIdentity(entry) === change.identity);
        if (currentIndex < 0 || !deepEqual(result[currentIndex], change.installed)) {
            warnings.push(`Preserved modified package setting: ${change.identity}`);
            continue;
        }

        if (change.beforeExists) {
            result[currentIndex] = structuredClone(change.before);
        } else {
            result.splice(currentIndex, 1);
        }
    }

    return result;
}

function markerRange(text, start, end) {
    const startIndex = text.indexOf(start);
    const endIndex = text.indexOf(end);
    if (startIndex < 0 !== endIndex < 0) {
        throw new Error(`Malformed managed block: expected both ${start} and ${end}`);
    }

    if (startIndex < 0) {
        return undefined;
    }

    if (text.indexOf(start, startIndex + start.length) >= 0 || text.indexOf(end, endIndex + end.length) >= 0) {
        throw new Error(`Malformed managed block: duplicate ${start} or ${end}`);
    }

    if (endIndex < startIndex) {
        throw new Error(`Malformed managed block: ${end} precedes ${start}`);
    }

    return { startIndex, endIndex: endIndex + end.length };
}

export function upsertManagedBlock(text, start, end, body) {
    const normalized = String(text ?? "").replace(/\r\n/g, "\n");
    const block = `${start}\n${String(body).trim()}\n${end}`;
    const range = markerRange(normalized, start, end);
    if (!range) {
        return `${normalized.trimEnd()}${normalized.trim() ? "\n\n" : ""}${block}\n`;
    }

    const before = normalized.slice(0, range.startIndex).trimEnd();
    const after = normalized.slice(range.endIndex).trimStart();

    return `${before}${before ? "\n\n" : ""}${block}${after ? `\n\n${after}` : "\n"}`;
}

export function removeManagedBlock(text, start, end) {
    const normalized = String(text ?? "").replace(/\r\n/g, "\n");
    const range = markerRange(normalized, start, end);
    if (!range) {
        return normalized;
    }

    const before = normalized.slice(0, range.startIndex).trimEnd();
    const after = normalized.slice(range.endIndex).trimStart();
    if (!before && !after) {
        return "";
    }

    return `${before}${before && after ? "\n\n" : ""}${after}\n`;
}

export function readPath(object, pathParts) {
    let current = object;
    for (const part of pathParts) {
        if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
            return { exists: false, value: undefined };
        }

        current = current[part];
    }

    return { exists: true, value: structuredClone(current) };
}

export function setPath(object, pathParts, value) {
    let current = object;
    for (const part of pathParts.slice(0, -1)) {
        if (current[part] === null || typeof current[part] !== "object" || Array.isArray(current[part])) {
            current[part] = {};
        }

        current = current[part];
    }

    current[pathParts.at(-1)] = structuredClone(value);
}

export function deletePath(object, pathParts) {
    let current = object;
    const parents = [];
    for (const part of pathParts.slice(0, -1)) {
        if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
            return;
        }

        parents.push([current, part]);
        current = current[part];
    }

    if (!current || typeof current !== "object") {
        return;
    }

    delete current[pathParts.at(-1)];

    for (const [parent, key] of parents.reverse()) {
        const child = parent[key];
        if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
            delete parent[key];
        } else {
            break;
        }
    }
}
