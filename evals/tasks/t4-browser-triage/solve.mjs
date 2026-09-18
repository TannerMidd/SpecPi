// Reference solution. Files every defective widget with the evidence the
// browser prints for it — the same file a harness reaches by driving all
// fifty widgets and comparing each against the criterion beside it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function solve(workspaceDir) {
    const taskDir = path.dirname(fileURLToPath(import.meta.url));
    const key = JSON.parse(fs.readFileSync(path.join(taskDir, "KEY.json"), "utf8"));
    const findings = key
        .filter((entry) => entry.defective)
        .map((entry) => ({
            widget: entry.id,
            route: entry.route,
            kind: entry.kind,
            observed: entry.observed,
            summary: entry.note,
        }));
    fs.writeFileSync(path.join(workspaceDir, "findings.json"), `${JSON.stringify({ findings }, null, 2)}\n`);
}
