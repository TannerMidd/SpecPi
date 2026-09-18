// Reference solution. Applies each owned, unfrozen package's own rules to its
// own config files and touches nothing else — the result a harness reaches by
// joining OWNERS, the registry, the transfer log and the freeze log, then
// reading thirty-four migration notes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function solve(workspaceDir) {
    const taskDir = path.dirname(fileURLToPath(import.meta.url));
    const key = JSON.parse(fs.readFileSync(path.join(taskDir, "KEY.json"), "utf8"));
    for (const [relative, entry] of Object.entries(key.files)) {
        if (entry.action !== "migrate") {
            continue;
        }

        fs.writeFileSync(path.join(workspaceDir, relative), entry.expected);
    }
}
