import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    const lines = fs
        .readFileSync(path.join(workspaceDir, "unsorted.txt"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .sort();
    fs.writeFileSync(path.join(workspaceDir, "sorted.txt"), `${lines.join("\n")}\n`);
}
