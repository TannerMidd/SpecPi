import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(workspaceDir, "data.json"), "utf8"));
    } catch {
        return { pass: false, notes: "data.json does not parse" };
    }

    const keys = Object.keys(parsed).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["enabled", "name", "version"])) {
        return { pass: false, notes: `unexpected keys: ${JSON.stringify(keys)}` };
    }

    if (parsed.name !== "widget" || parsed.version !== 2 || parsed.enabled !== true) {
        return { pass: false, notes: `unexpected values: ${JSON.stringify(parsed)}` };
    }

    return { pass: true, notes: "data.json is valid with the required fields" };
}
