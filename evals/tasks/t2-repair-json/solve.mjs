import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    fs.writeFileSync(
        path.join(workspaceDir, "data.json"),
        `${JSON.stringify({ name: "widget", version: 2, enabled: true })}\n`,
    );
}
