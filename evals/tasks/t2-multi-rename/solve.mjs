import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    fs.writeFileSync(path.join(workspaceDir, "lib.js"), 'export function newName() {\n    return "hi";\n}\n');
    fs.writeFileSync(
        path.join(workspaceDir, "main.js"),
        'import { newName } from "./lib.js";\n\nconsole.log(newName());\n',
    );
}
