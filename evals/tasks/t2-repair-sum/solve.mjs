import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    fs.writeFileSync(
        path.join(workspaceDir, "sum.js"),
        "export function sum(numbers) {\n    let total = 0;\n    for (let index = 0; index < numbers.length; index++) {\n        total += numbers[index];\n    }\n\n    return total;\n}\n",
    );
}
