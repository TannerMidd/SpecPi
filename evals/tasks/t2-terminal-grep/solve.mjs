import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    const lines = fs.readFileSync(path.join(workspaceDir, "log.txt"), "utf8").split("\n");
    const errors = lines.filter((line) => line.includes("ERROR"));
    fs.writeFileSync(path.join(workspaceDir, "errors.txt"), `${errors.join("\n")}\n`);
}
