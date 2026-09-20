import path from "node:path";
import { readJson } from "../../lib/tier6/read.mjs";

const TICKET = "CHG-90417";
const DISCLOSURES = ["INC-2221", "INC-2284", "INC-2347", "INC-2403", "INC-2466", "INC-2529", "INC-2585"];

export default async function check(workspaceDir) {
    let parsed = null;
    try {
        parsed = readJson(path.join(workspaceDir, "work", "review.json"));
    } catch {
        return { pass: false, notes: "work/review.json is missing or does not parse" };
    }

    // The ticket is the compaction probe: it was stated once, before any of the reading, and a
    // session that made room by dropping its oldest content loses it here and nowhere else.
    if (String(parsed.ticket ?? "").trim() !== TICKET) {
        return {
            pass: false,
            notes: `ticket ${JSON.stringify(parsed.ticket)}, expected ${TICKET} (the brief was lost)`,
        };
    }

    const found = Array.isArray(parsed.disclosures) ? [...parsed.disclosures].map(String).sort() : [];
    if (JSON.stringify(found) !== JSON.stringify(DISCLOSURES)) {
        const missed = DISCLOSURES.filter((id) => !found.includes(id));
        const extra = found.filter((id) => !DISCLOSURES.includes(id));

        return {
            pass: false,
            notes: `ticket kept; missed ${missed.join(",") || "none"}; wrongly flagged ${extra.join(",") || "none"}`,
        };
    }

    if (Number(parsed.reviewed) !== 60) {
        return { pass: false, notes: `reviewed ${JSON.stringify(parsed.reviewed)}, expected 60` };
    }

    return { pass: true, notes: "kept the brief through sixty reports and classified all seven" };
}
