import { VALIDATOR_CATALOG } from "./validators.mjs";

const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "capability",
    "for",
    "missing",
    "need",
    "needed",
    "of",
    "support",
    "the",
    "to",
    "tool",
    "tools",
]);

const VALIDATORS = new Set(Object.keys(VALIDATOR_CATALOG));

function compact(value, maxLength) {
    return String(value ?? "")
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function normalizeToken(token) {
    if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
        return token.slice(0, -1);
    }

    return token;
}

export function normalizeCapability(value) {
    const tokens = compact(value, 120)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean)
        .map(normalizeToken)
        .filter((token) => !STOP_WORDS.has(token));

    return [...new Set(tokens)].slice(0, 10).join("-") || "uncategorized-gap";
}

export function validateCapabilityRegistry(registry) {
    if (registry?.schema !== 1 || !Array.isArray(registry.capabilities)) {
        throw new Error("schema or capabilities array is invalid");
    }

    const ids = new Set();
    const aliases = new Set();
    for (const item of registry.capabilities) {
        if (
            typeof item?.id !== "string" ||
            normalizeCapability(item.id) !== item.id ||
            typeof item.title !== "string" ||
            item.title.trim().length < 3 ||
            !Array.isArray(item.aliases) ||
            typeof item.shippedVersion !== "string" ||
            typeof item.shippedAt !== "string" ||
            !Number.isFinite(Date.parse(item.shippedAt)) ||
            !Array.isArray(item.validations) ||
            item.validations.length === 0 ||
            item.validations.some((validator) => !VALIDATORS.has(validator))
        ) {
            throw new Error(`invalid capability entry: ${item?.id || "unknown"}`);
        }

        if (ids.has(item.id) || aliases.has(item.id)) {
            throw new Error(`duplicate capability registry key: ${item.id}`);
        }

        ids.add(item.id);
        for (const alias of item.aliases) {
            if (
                typeof alias !== "string" ||
                normalizeCapability(alias) !== alias ||
                ids.has(alias) ||
                aliases.has(alias)
            ) {
                throw new Error(`duplicate or invalid capability alias: ${alias}`);
            }

            aliases.add(alias);
        }
    }

    return registry;
}

export function isValidValidatorName(value) {
    return VALIDATORS.has(value);
}
