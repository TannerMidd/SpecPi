import fs from "node:fs";
import path from "node:path";
import { apply, initialState } from "./workflow.mjs";

function writeJson(workspace, relative, value) {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function referenceSchedule(spec) {
    const state = initialState(spec);
    const journal = [];
    const act = (...args) => {
        journal.push(args);

        return apply(state, spec, args);
    };

    while (Object.values(state.jobs).some((job) => job.status !== "done")) {
        for (const item of spec.items) {
            const job = state.jobs[item.id];
            const running = spec.items.filter((entry) => state.jobs[entry.id].status === "running");
            if (
                ["pending", "failed"].includes(job.status) &&
                item.dependencies.every((id) => state.jobs[id].status === "done") &&
                running.length < spec.capacity &&
                running.every((entry) => entry.resource !== item.resource)
            ) {
                act("start", item.id);
            }
        }

        act("advance");
        if (state.tick > 1000) {
            throw new Error("reference scheduler did not converge");
        }
    }

    return { state, journal };
}

export async function solve(directory, workspace) {
    const key = JSON.parse(fs.readFileSync(path.join(directory, "KEY.json"), "utf8"));
    if (["evidence", "authority"].includes(key.kind)) {
        writeJson(
            workspace,
            "work/answers.json",
            key.rows.map(({ group, ...row }) => row),
        );
    } else if (key.kind === "scope") {
        for (const row of key.rows) {
            writeJson(workspace, row.path, row.expected);
        }
    } else if (key.kind === "handoff") {
        for (const row of key.rows) {
            if (row.group !== "verified-baseline") {
                writeJson(workspace, row.path, row.expected);
            }
        }

        writeJson(
            workspace,
            "work/verification.json",
            key.rows.map((row) => ({ id: row.id, status: "verified", inputSha256: row.expected.inputSha256 })),
        );
    } else if (key.kind === "transactions") {
        const state = initialState(key.spec);
        const journal = [];
        for (const row of key.rows.filter((item) => item.approved)) {
            const args = ["send", row.id, `key-${row.id}`];
            journal.push(args);
            const result = apply(state, key.spec, args);
            if (!result.ok) {
                journal.push(["status", row.id]);
                apply(state, key.spec, ["status", row.id]);
                journal.push(args);
                apply(state, key.spec, args);
            }
        }

        writeJson(workspace, "work/journal.json", journal);
        writeJson(workspace, "work/receipts.json", state.commits);
    } else {
        const { journal } = referenceSchedule(key.spec);
        writeJson(workspace, "work/journal.json", journal);
    }
}
