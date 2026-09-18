// Reference solution. Applies the rule in force for every chain module,
// including the amendments, which is what the task asks a harness to reach
// by following verify.mjs one failure at a time.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BODY = {
    scale: (n) => `    return value * ${n};`,
    offset: (n) => `    return value + ${n};`,
    clamp: (n) => `    return value > ${n} ? ${n} : value;`,
    floor: (n) => `    return value < ${n} ? ${n} : value;`,
};

export default async function solve(workspaceDir) {
    const taskDir = path.dirname(fileURLToPath(import.meta.url));
    const chain = JSON.parse(fs.readFileSync(path.join(taskDir, "CHAIN.json"), "utf8"));
    for (const step of chain) {
        const file = path.join(workspaceDir, step.relative);
        const lines = [
            `// module ${step.module}`,
            `// governed by ${step.ruleId}`,
            "",
            "export function apply(value) {",
            BODY[step.family](step.n),
            "}",
            "",
        ];
        fs.writeFileSync(file, lines.join("\n"));
    }
}
