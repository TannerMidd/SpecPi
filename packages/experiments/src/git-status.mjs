// Git status parsing shared with SpecPi's /scope extension. Kept here so this package
// installs on its own: the two copies must agree on Git's porcelain -z framing, not on
// any SpecPi state.

export function sanitizePathLabel(value) {
    return String(value).replace(/[%\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => encodeURIComponent(character));
}

export function parsePorcelainEntries(output) {
    if (typeof output !== "string") {
        throw new Error("Git status output is unavailable");
    }

    const fields = output.split("\0");
    const entries = [];
    for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (!field) {
            continue;
        }

        if (field.length < 4 || field[2] !== " ") {
            throw new Error("Malformed NUL-delimited Git status output");
        }

        const status = field.slice(0, 2);
        const candidate = field.slice(3);
        if (!candidate || candidate.includes("\0")) {
            throw new Error("Malformed Git status path");
        }

        entries.push({ status, path: candidate.replaceAll("\\", "/") });
        if (status.includes("R") || status.includes("C")) {
            index += 1;
            if (index >= fields.length || !fields[index]) {
                throw new Error("Malformed Git rename status");
            }

            if (status.includes("R")) {
                entries.push({ status, path: fields[index].replaceAll("\\", "/") });
            }
        }
    }

    return entries;
}

export function parsePorcelainZ(output) {
    return [...new Set(parsePorcelainEntries(output).map((entry) => entry.path))].sort();
}
