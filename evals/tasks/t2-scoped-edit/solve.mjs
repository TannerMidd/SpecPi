import fs from "node:fs";
import path from "node:path";

export default async function solve(workspaceDir) {
    fs.writeFileSync(
        path.join(workspaceDir, "src", "app.js"),
        "export const VERSION = 2;\nexport function label() {\n    return `app v${VERSION}`;\n}\n",
    );
}
