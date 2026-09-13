import { tasks as initialTasks, baselineCommit } from "./tasks.mjs";
import { challengeTasks } from "./challenge-tasks.mjs";
import { repositoryTasks } from "./repository-tasks.mjs";
export { baselineCommit };
export const suiteVersion = "2.0.0";
export const tasks = [
    ...initialTasks.map((task) => ({
        ...task,
        difficulty: ["caller-migration", "stale-check", "browser-persistence"].includes(task.id) ? "medium" : "easy",
        provenance: { kind: "authored-v1", commit: baselineCommit },
        ...(task.id === "stale-check"
            ? {
                  request:
                      task.request +
                      " Each receipt is { head: string, inputs: Record<string, string> }; changing head also invalidates it.",
              }
            : {}),
    })),
    ...challengeTasks.map((task) => ({ ...task, provenance: { kind: "authored-v2" } })),
    ...repositoryTasks,
];
const ids = new Set();
for (const task of tasks) {
    if (ids.has(task.id) || !/^[a-z0-9-]+$/u.test(task.id) || !["easy", "medium", "hard"].includes(task.difficulty)) {
        throw new Error("Invalid or duplicate quality task metadata.");
    }

    ids.add(task.id);
    const names = Object.keys(task.files);
    if (
        !names.length ||
        names.length > 40 ||
        Object.values(task.files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 256 * 1024
    ) {
        throw new Error("Quality fixture exceeds its inventory bound.");
    }

    for (const name of names) {
        if (
            !/^[A-Za-z0-9_./-]+$/u.test(name) ||
            name.startsWith("/") ||
            name.split("/").some((part) => !part || part === "." || part === "..")
        ) {
            throw new Error("Invalid quality fixture path.");
        }
    }
}
