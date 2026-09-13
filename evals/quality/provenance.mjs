import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function sourceDigests() {
    const files = fs
        .readdirSync(new URL("./", import.meta.url))
        .filter((name) => name.endsWith(".mjs") || name === "repository-sources.json")
        .sort();

    return {
        ...Object.fromEntries(files.map((name) => [name, sha256(fs.readFileSync(new URL(name, import.meta.url)))])),
        "specpi-review/SKILL.md": sha256(fs.readFileSync(path.join(repositoryRoot, "skills/specpi-review/SKILL.md"))),
        "package.json": sha256(fs.readFileSync(path.join(repositoryRoot, "package.json"))),
        "quality-evaluation.test.mjs": sha256(
            fs.readFileSync(path.join(repositoryRoot, "tests/quality-evaluation.test.mjs")),
        ),
        "quality-browser.test.mjs": sha256(
            fs.readFileSync(path.join(repositoryRoot, "tests/quality-browser.test.mjs")),
        ),
    };
}
