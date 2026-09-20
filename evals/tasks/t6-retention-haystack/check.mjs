import path from "node:path";
import { readJson } from "../../lib/tier6/read.mjs";

// Kept as literals rather than imported from the generator, so a regeneration that moved the answer
// fails here loudly instead of quietly agreeing with itself.
const DISCLOSURES = ["INC-2214", "INC-2228", "INC-2263", "INC-2277", "INC-2312", "INC-2333", "INC-2361", "INC-2375"];

export default async function check(workspaceDir) {
    let parsed = null;
    try {
        parsed = readJson(path.join(workspaceDir, "work", "disclosures.json"));
    } catch {
        return { pass: false, notes: "work/disclosures.json is missing or does not parse" };
    }

    const found = Array.isArray(parsed.disclosures) ? [...parsed.disclosures].map(String).sort() : [];
    if (JSON.stringify(found) !== JSON.stringify(DISCLOSURES)) {
        const missed = DISCLOSURES.filter((id) => !found.includes(id));
        const extra = found.filter((id) => !DISCLOSURES.includes(id));

        return {
            pass: false,
            notes: `missed ${missed.join(",") || "none"}; wrongly flagged ${extra.join(",") || "none"}`,
        };
    }

    return { pass: true, notes: "found all eight disclosures among 28 reports" };
}
