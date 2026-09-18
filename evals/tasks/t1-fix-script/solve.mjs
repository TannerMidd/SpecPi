import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    fs.writeFileSync(path.join(workspaceDir, "add.js"), "export function add(a, b) {\n    return a + b;\n}\n");
}
