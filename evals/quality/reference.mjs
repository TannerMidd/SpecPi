import fs from "node:fs";
import path from "node:path";
import { challengeReference } from "./challenge-reference.mjs";
import { repositorySources, repositoryMutations } from "./repository-tasks.mjs";

// Oracle qualification only. Never placed in model fixtures or used as a candidate answer.
export function applyReferenceRepair(id, root) {
    const mutation = repositoryMutations[id];
    const files = mutation ? { [mutation.path]: repositorySources.files[mutation.path] } : challengeReference[id];
    if (files) {
        for (const [name, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(root, name), content);
        }

        return;
    }

    const change = (file, before, after) => {
        const target = path.join(root, file);
        const source = fs.readFileSync(target, "utf8");
        if (!source.includes(before)) {
            throw new Error("Reference repair no longer matches the fixture.");
        }

        fs.writeFileSync(target, source.replace(before, after));
    };

    if (id === "page-boundary") {
        change("main.mjs", "total >=", "total >");
    } else if (id === "explicit-zero") {
        change("main.mjs", "options.retries || 3", "options.retries ?? 3");
    } else if (id === "caller-migration") {
        change("format.mjs", 'currency = "USD"', '{ currency = "USD" } = {}');
        change("main.mjs", 'cents, "EUR"', 'cents, { currency: "EUR" }');
        change("billing/invoice.mjs", 'cents, "GBP"', 'cents, { currency: "GBP" }');
    } else if (id === "path-boundary") {
        change(
            "main.mjs",
            "candidate.startsWith(root)",
            'root === "/" || candidate === root || candidate.startsWith(root + "/")',
        );
    } else if (id === "stale-check") {
        change(
            "main.mjs",
            "before.head === after.head",
            "before.head === after.head && Object.keys(before.inputs).length === Object.keys(after.inputs).length && Object.entries(before.inputs).every(([key, value]) => Object.hasOwn(after.inputs, key) && after.inputs[key] === value)",
        );
    } else if (id === "existing-reuse") {
        change("main.mjs", "export function list", 'import { statusLabel } from "./status.mjs";\nexport function list');
        change("main.mjs", '"Status: " + value', '"Status: " + statusLabel(value)');
    } else if (id === "browser-persistence") {
        change(
            "app.mjs",
            "form.addEventListener",
            'saved.textContent = localStorage.getItem("name") ?? "";\nform.addEventListener',
        );
        change(
            "app.mjs",
            "saved.textContent = form.elements.name.value;",
            'const value = form.elements.name.value.trim();\n    if (!value) { return; }\n    localStorage.setItem("name", value);\n    saved.textContent = value;',
        );
    }
}
