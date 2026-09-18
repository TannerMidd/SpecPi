import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    const file = path.join(workspaceDir, "CHANGELOG.md");
    const content = fs.readFileSync(file, "utf8");
    if (!content.split("\n").includes("- v2 released")) {
        fs.writeFileSync(file, `${content.trimEnd()}\n- v2 released\n`);
    }
}
