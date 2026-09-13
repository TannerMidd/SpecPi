import fs from "node:fs";
import { collectQualityResults } from "./quality-results.mjs";
const [destination, qualification, ...directories] = process.argv.slice(2);
if (!destination || !qualification || directories.length < 2) {
    throw new Error(
        "Usage: node scripts/export-quality-results.mjs <new-public.json> <qualification.json> <original-or-continuation-directory ...>",
    );
}

if (fs.existsSync(destination)) {
    throw new Error("Public destination already exists.");
}

const result = collectQualityResults(directories, qualification);
fs.writeFileSync(destination, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
    JSON.stringify(
        {
            destination,
            trials: result.runs.length,
            invalidAttempts: result.invalidAttempts.length,
            changedOutcomes: result.grading.changedOutcomes,
            summary: result.summary,
        },
        null,
        2,
    ) + "\n",
);
