import fs from "node:fs";
import path from "node:path";

export function readIntegrations(agentDir) {
    const file = path.join(agentDir, "specpi", "tool-integrations.json");
    for (const target of [agentDir, path.dirname(file), file]) {
        try {
            if (fs.lstatSync(target).isSymbolicLink()) {
                throw new Error("Tool integration configuration must not be a link.");
            }
        } catch (error) {
            if (error.code === "ENOENT") {
                return { schema: 1, structuralSearch: { enabled: false } };
            }

            throw error;
        }
    }

    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) {
        throw new Error("Tool integration configuration is not a bounded regular file.");
    }

    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        throw new Error("Tool integration configuration could not be read as JSON.");
    }

    if (!value || value.schema !== 1 || typeof value.structuralSearch?.enabled !== "boolean") {
        throw new Error("Invalid tool integration configuration.");
    }

    return value;
}
