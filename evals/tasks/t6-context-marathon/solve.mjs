import fs from "node:fs";
import path from "node:path";
import { isDisclosure } from "../../lib/tier6/key.mjs";

// Same key as the haystack, plus the one fact the marathon exists to test: the ticket is read from
// the brief at the start and carried to the end.
export default async function solve(workspaceDir) {
    const brief = fs.readFileSync(path.join(workspaceDir, "BRIEF.md"), "utf8");
    const ticket = /\*\*(CHG-\d+)\*\*/u.exec(brief)?.[1] ?? "";

    const dir = path.join(workspaceDir, "incidents");
    const entries = fs.readdirSync(dir).sort();
    const disclosures = [];
    for (const entry of entries) {
        const id = entry.replace(/\.md$/u, "");
        if (isDisclosure(fs.readFileSync(path.join(dir, entry), "utf8"), id)) {
            disclosures.push(id);
        }
    }

    fs.mkdirSync(path.join(workspaceDir, "work"), { recursive: true });
    fs.writeFileSync(
        path.join(workspaceDir, "work", "review.json"),
        `${JSON.stringify({ ticket, disclosures: disclosures.sort(), reviewed: entries.length }, null, 2)}\n`,
    );
}
