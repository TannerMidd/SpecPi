import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    const spec = fs.readFileSync(path.join(workspaceDir, "spec.txt"), "utf8");
    const fileLine = spec.split("\n").find((line) => line.startsWith("output file:"));
    const contentLine = spec.split("\n").find((line) => line.startsWith("content:"));
    const name = fileLine.slice("output file:".length).trim();
    const content = contentLine.slice("content:".length).trim();
    fs.writeFileSync(path.join(workspaceDir, name), `${content}\n`);
    fs.readFileSync(path.join(workspaceDir, name), "utf8");
}
