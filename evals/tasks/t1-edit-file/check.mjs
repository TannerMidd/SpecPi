import fs from "node:fs";
import path from "node:path";

export default async function check(workspaceDir) {
    const file = path.join(workspaceDir, "config.json");
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return { pass: false, notes: "config.json is not valid JSON" };
    }

    if (parsed.debug !== true) {
        return { pass: false, notes: `debug is ${JSON.stringify(parsed.debug)}, expected true` };
    }

    if (parsed.name !== "eval") {
        return { pass: false, notes: "other keys must stay unchanged" };
    }

    return { pass: true, notes: "debug is true, other keys intact" };
}
