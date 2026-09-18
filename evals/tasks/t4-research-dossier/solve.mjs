// Reference solution. Answers every question with the value the corpus
// carries and cites the documents it comes from — the file a harness reaches
// by following each question through the registry, the RFC series and the
// documents that supersede them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function solve(workspaceDir) {
    const taskDir = path.dirname(fileURLToPath(import.meta.url));
    const key = JSON.parse(fs.readFileSync(path.join(taskDir, "KEY.json"), "utf8"));
    const answers = {};
    for (const question of key) {
        answers[question.id] = { answer: question.answer, sources: question.sources };
    }

    fs.writeFileSync(path.join(workspaceDir, "answers.json"), `${JSON.stringify(answers, null, 2)}\n`);
}
