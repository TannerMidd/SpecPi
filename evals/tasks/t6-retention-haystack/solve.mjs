import fs from "node:fs";
import path from "node:path";
import { isDisclosure } from "../../lib/tier6/key.mjs";

// The reference reads the reports and applies the rule, rather than writing a remembered answer.
// A remembered answer would pass this check forever, including after a change to corpus.mjs that
// stopped the reports encoding the rule at all.
export default async function solve(workspaceDir) {
    const dir = path.join(workspaceDir, "incidents");
    const disclosures = [];
    for (const entry of fs.readdirSync(dir).sort()) {
        const id = entry.replace(/\.md$/u, "");
        if (isDisclosure(fs.readFileSync(path.join(dir, entry), "utf8"), id)) {
            disclosures.push(id);
        }
    }

    fs.mkdirSync(path.join(workspaceDir, "work"), { recursive: true });
    fs.writeFileSync(
        path.join(workspaceDir, "work", "disclosures.json"),
        `${JSON.stringify({ disclosures: disclosures.sort() }, null, 2)}\n`,
    );
}
