import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    const file = path.join(workspaceDir, "keep.txt");
    const content = fs.readFileSync(file, "utf8");
    if (!content.split("\n").includes("updated")) {
        fs.writeFileSync(file, `${content.trimEnd()}\nupdated\n`);
    }
}
