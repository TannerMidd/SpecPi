import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    const file = path.join(workspaceDir, "config.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    parsed.debug = true;
    fs.writeFileSync(file, `${JSON.stringify(parsed)}\n`);
}
