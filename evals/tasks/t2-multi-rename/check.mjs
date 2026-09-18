import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export default async function check(workspaceDir) {
    const lib = fs.readFileSync(path.join(workspaceDir, "lib.js"), "utf8");
    if (!lib.includes("newName") || lib.includes("oldName")) {
        return { pass: false, notes: "lib.js does not export only newName" };
    }

    const result = spawnSync(process.execPath, [path.join(workspaceDir, "main.js")], { encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim() !== "hi") {
        return { pass: false, notes: `main.js printed ${JSON.stringify(result.stdout)}` };
    }

    return { pass: true, notes: "rename complete, main.js prints hi" };
}
