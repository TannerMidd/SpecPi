import fs from "node:fs";
import path from "node:path";

export function integrationsFile(agentDir) {
    return path.join(agentDir, "specpi", "tool-integrations.json");
}

// Content corruption is repairable by an explicit selection; link and file-shape failures are not.
function corrupt(file, message) {
    const error = new Error(`${message}: ${file}`);
    error.corruptIntegrations = true;

    return error;
}

export function readIntegrations(agentDir) {
    const file = integrationsFile(agentDir);
    for (const target of [agentDir, path.dirname(file), file]) {
        try {
            if (fs.lstatSync(target).isSymbolicLink()) {
                throw new Error(`Tool integration configuration must not be a link: ${file}`);
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
        throw new Error(`Tool integration configuration is not a bounded regular file: ${file}`);
    }

    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        throw corrupt(file, "Tool integration configuration could not be read as JSON");
    }

    if (!value || value.schema !== 1 || typeof value.structuralSearch?.enabled !== "boolean") {
        throw corrupt(file, "Invalid tool integration configuration");
    }

    return value;
}
