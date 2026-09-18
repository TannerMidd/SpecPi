// Generates t4-browser-triage: fifty widgets across ten routes, forty of them
// defective, each carrying its own acceptance criterion in the page so a
// defect is a fact rather than an opinion.
//
// The three shortcuts that saturate a QA task are all closed:
//
//  1. No static read. Credit for a defect is 40% for naming it and 60% for
//     quoting what the browser actually printed, and every widget's output
//     carries its own reference word, so the evidence for one widget is never
//     the evidence for another.
//  2. No shotgunning. Ten of the fifty widgets are correct, and reporting one
//     costs a full defect. Listing all fifty scores 0.15.
//  3. No finishing. Fifty widgets at four to six commands each is more work
//     than the budget holds, so the score is yield, not completion.
//
// The answer key is not written by hand: this script drives the real engine
// through every widget and records what it printed. It then builds a second,
// entirely correct copy of the same application and drives that too, and
// fails if any "defect" produces the same output as its own fixed version.
// That check is not decoration — it caught a tax bug that rounded to exactly
// the same cent as the correct formula, i.e. a defect that was not one.
//
// Regenerate with:
//
//     node evals/tasks/t4-browser-triage/generate.mjs \
//         evals/tasks/t4-browser-triage/workspace
//
// then run `npm run format` and regenerate once more, because the checker
// compares the app by hash and prettier owns the final byte layout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2]);
const taskDir = path.dirname(root);

const ROUTES = [
    ["/dashboard", "Dashboard"],
    ["/catalog", "Catalog"],
    ["/cart", "Cart"],
    ["/checkout", "Checkout"],
    ["/account", "Account"],
    ["/orders", "Orders"],
    ["/support", "Support"],
    ["/settings", "Settings"],
    ["/billing", "Billing"],
    ["/reports", "Reports"],
];

const WORDS = [
    "amber",
    "basalt",
    "cedar",
    "damask",
    "ember",
    "flax",
    "garnet",
    "hazel",
    "indigo",
    "jasper",
    "kelp",
    "larch",
    "mica",
    "nutmeg",
    "onyx",
    "pumice",
    "quartz",
    "rowan",
    "sable",
    "thistle",
];

// Each widget draws from its own stream, so building the same widget twice —
// once defective, once fixed — produces the same parameters both times. The
// shadow build depends on that: without it the two copies would differ by
// their random numbers rather than by the defect.
function streamFor(index) {
    let seed = (20260918 + index * 7919) & 0x7fffffff;

    return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
}

/* ------------------------------------------------------------- templates */

// Each template renders one widget: markup, a script, the commands that
// exercise it, and the command whose output is the evidence. `broken` and
// `fixed` differ by one behaviour, and the acceptance criterion in `spec` is
// what makes the difference judgeable from the page alone. Every visible
// result carries the widget's own reference word so no two widgets can be
// confirmed by the same string.
const TEMPLATES = [
    {
        kind: "calculation",
        title: "Order total",
        build: (id, defective, rnd, ref) => {
            const qty = 3;
            // Rounding the unit price before multiplying only diverges from
            // rounding once at the end for some prices, so the price is
            // chosen rather than drawn: at the wrong one this "defect" prints
            // the correct total and the widget is unjudgeable.
            let unit = 100 + Math.floor(rnd() * 900);
            while (Math.round((unit * 108) / 100) * qty === Math.round((unit * qty * 108) / 100)) {
                unit += 1;
            }

            return {
                spec: `Total must be quantity × $${(unit / 100).toFixed(2)} × 1.08, rounded to the nearest cent once, at the end.`,
                html: `<label for="${id}-qty">Quantity</label>
    <input id="${id}-qty" type="text" value="1">
    <button id="${id}-go" type="button">Recalculate</button>
    <output id="${id}-out">$0.00 (${ref})</output>`,
                js: `(function () {
    const unit = ${unit};
    const out = document.querySelector("#${id}-out");
    document.querySelector("#${id}-go").addEventListener("click", function () {
        const qty = Number(document.querySelector("#${id}-qty").value) || 0;
        ${
            defective
                ? "const total = Math.round((unit * 108) / 100) * qty;"
                : "const total = Math.round((unit * qty * 108) / 100);"
        }
        out.textContent = "$" + (total / 100).toFixed(2) + " (${ref})";
    });
})();`,
                probe: [`type #${id}-qty ${qty}`, `click #${id}-go`],
                evidence: `text --selector=#${id}-out`,
                note: defective ? "rounds the unit price before multiplying" : "rounds once at the end",
            };
        },
    },
    {
        kind: "validation",
        title: "Contact address",
        build: (id, defective, rnd, ref) => ({
            spec: 'An address with no @ must print "Invalid address" and must not be saved.',
            html: `<label for="${id}-mail">Email</label>
    <input id="${id}-mail" type="text" value="">
    <button id="${id}-go" type="button">Save</button>
    <output id="${id}-out">— (${ref})</output>`,
            js: `(function () {
    const out = document.querySelector("#${id}-out");
    document.querySelector("#${id}-go").addEventListener("click", function () {
        const value = document.querySelector("#${id}-mail").value;
        ${
            defective
                ? `if (value.length === 0) {
            out.textContent = "Invalid address (${ref})";

            return;
        }`
                : `if (value.indexOf("@") < 0) {
            out.textContent = "Invalid address (${ref})";

            return;
        }`
        }
        out.textContent = "Saved " + value + " (${ref})";
    });
})();`,
            probe: [`type #${id}-mail ${ref}.example.invalid`, `click #${id}-go`],
            evidence: `text --selector=#${id}-out`,
            note: defective ? "saves an address with no @" : "rejects it correctly",
        }),
    },
    {
        kind: "pagination",
        title: "Result pages",
        build: (id, defective, rnd, ref) => {
            const pages = 6 + Math.floor(rnd() * 6);

            return {
                spec: `"Next" must advance exactly one page and must stop at page ${pages}.`,
                html: `<button id="${id}-next" type="button">Next</button>
    <output id="${id}-out">Page 1 of ${pages} (${ref})</output>`,
                js: `(function () {
    const total = ${pages};
    let page = 1;
    const out = document.querySelector("#${id}-out");
    document.querySelector("#${id}-next").addEventListener("click", function () {
        ${defective ? "page = Math.min(total, page + 2);" : "page = Math.min(total, page + 1);"}
        out.textContent = "Page " + page + " of " + total + " (${ref})";
    });
})();`,
                probe: [`click #${id}-next`],
                evidence: `text --selector=#${id}-out`,
                note: defective ? "advances two pages" : "advances one page",
            };
        },
    },
    {
        kind: "aria-state",
        title: "Details disclosure",
        build: (id, defective, rnd, ref) => ({
            spec: 'The toggle must report aria-expanded="true" while the panel is open.',
            html: `<button id="${id}-toggle" type="button" aria-expanded="false" aria-controls="${id}-panel">Details ${ref}</button>
    <div id="${id}-panel" hidden>Shipment routed via the ${ref} hub.</div>`,
            js: `(function () {
    const toggle = document.querySelector("#${id}-toggle");
    const panel = document.querySelector("#${id}-panel");
    toggle.addEventListener("click", function () {
        const open = panel.hidden;
        panel.hidden = !open;
        ${defective ? 'toggle.classList.toggle("open", open);' : 'toggle.setAttribute("aria-expanded", String(open));'}
    });
})();`,
            probe: [`click #${id}-toggle`],
            evidence: `a11y --selector=#${id}-toggle`,
            note: defective ? "aria-expanded never changes" : "aria-expanded tracks the panel",
        }),
    },
    {
        kind: "runtime-error",
        title: "Saved view",
        build: (id, defective, rnd, ref) => {
            const suffix = id.split("-")[1];

            return {
                spec: "Applying a saved view must not raise a console error when no view is stored.",
                html: `<button id="${id}-apply" type="button">Apply view</button>
    <output id="${id}-out">default (${ref})</output>`,
                js: `(function () {
    const out = document.querySelector("#${id}-out");
    function renderPanel${suffix}(node) {
        return (node === null ? "default" : node.textContent) + " (${ref})";
    }

    document.querySelector("#${id}-apply").addEventListener("click", function () {
        const saved = document.querySelector("#${id}-saved");
        ${defective ? `out.textContent = renderView${suffix}(saved);` : `out.textContent = renderPanel${suffix}(saved);`}
    });
})();`,
                probe: [`click #${id}-apply`],
                evidence: "console",
                note: defective ? `calls renderView${suffix}, which does not exist` : "calls the function that exists",
            };
        },
    },
    {
        kind: "network",
        title: "Preference sync",
        build: (id, defective, rnd, ref) => ({
            spec: 'A sync response outside 2xx must print "Sync failed" followed by the reference from the response body.',
            html: `<button id="${id}-sync" type="button">Sync</button>
    <output id="${id}-out">— (${ref})</output>`,
            js: `(function () {
    const out = document.querySelector("#${id}-out");
    document.querySelector("#${id}-sync").addEventListener("click", function () {
        fetch("/api/${id}/sync", { method: "POST" })
            .then(function (response) {
                return response.json().then(function (body) {
                    ${
                        defective
                            ? 'out.textContent = "Synced " + body.ref;'
                            : 'out.textContent = (response.ok ? "Synced " : "Sync failed ") + body.ref;'
                    }
                });
            });
    });
})();`,
            probe: [`click #${id}-sync`],
            evidence: `text --selector=#${id}-out`,
            api: {
                [`POST /api/${id}/sync`]: { status: 503, body: { error: "sync backend unavailable", ref } },
            },
            note: defective ? "reports success on a 503" : "reports the failure",
        }),
    },
    {
        kind: "persistence",
        title: "Draft note",
        build: (id, defective, rnd, ref) => ({
            spec: 'Saving a draft must survive navigation: returning to this route must restore it and echo "restored: <text>".',
            html: `<label for="${id}-note">Note</label>
    <input id="${id}-note" type="text" value="">
    <button id="${id}-save" type="button">Save draft</button>
    <output id="${id}-out">restored: (none) [${ref}]</output>`,
            js: `(function () {
    const key = "${id}.draft";
    const field = document.querySelector("#${id}-note");
    const out = document.querySelector("#${id}-out");
    const saved = localStorage.getItem(key);
    if (saved !== null) {
        field.value = saved;
        out.textContent = "restored: " + saved + " [${ref}]";
    }

    document.querySelector("#${id}-save").addEventListener("click", function () {
        ${
            defective
                ? ""
                : `localStorage.setItem(key, field.value);
        `
        }out.textContent = "restored: " + field.value + " [${ref}]";
    });
})();`,
            probe: [`type #${id}-note ${ref}-draft`, `click #${id}-save`, "goto /dashboard", "goto ${route}"],
            evidence: `text --selector=#${id}-out`,
            note: defective ? "never writes the draft to storage" : "persists the draft",
        }),
    },
    {
        kind: "accessible-name",
        title: "Quick search",
        build: (id, defective, rnd, ref) => ({
            spec: `The ${ref} search field must have an accessible name; a placeholder alone is not one.`,
            html: defective
                ? `<input id="${id}-field" type="text" placeholder="Search ${ref} orders">
    <button id="${id}-go" type="button">Search</button>`
                : `<label for="${id}-field">Search ${ref} orders</label>
    <input id="${id}-field" type="text" placeholder="Search ${ref} orders">
    <button id="${id}-go" type="button">Search</button>`,
            js: `(function () {
    const field = document.querySelector("#${id}-field");
    document.querySelector("#${id}-go").addEventListener("click", function () {
        field.setAttribute("data-state", "searched");
    });
})();`,
            probe: [],
            evidence: `a11y --selector=#${id}-field`,
            note: defective ? "named only by its placeholder" : "has a label",
        }),
    },
    {
        kind: "double-submit",
        title: "Ticket submission",
        build: (id, defective, rnd, ref) => ({
            spec: `Submit must disable itself on the first click so the ${ref} queue receives one ticket.`,
            html: `<button id="${id}-submit" type="button">Submit ticket</button>
    <output id="${id}-out">submissions: 0 to ${ref}</output>`,
            js: `(function () {
    let filed = 0;
    const button = document.querySelector("#${id}-submit");
    const out = document.querySelector("#${id}-out");
    button.addEventListener("click", function () {
        filed += 1;
        ${defective ? 'button.setAttribute("data-state", "sent");' : "button.disabled = true;"}
        out.textContent = "submissions: " + filed + " to ${ref}";
    });
})();`,
            probe: [`click #${id}-submit`, `click #${id}-submit`],
            evidence: `text --selector=#${id}-out`,
            note: defective ? "files the ticket twice" : "files it once",
        }),
    },
    {
        kind: "filtering",
        title: "Tag filter",
        build: (id, defective, rnd, ref) => {
            const items = [0, 1, 2, 3, 4].map(() => WORDS[Math.floor(rnd() * WORDS.length)]);
            const needle = items[2].slice(1, 3);

            return {
                spec: "Filtering must list every tag containing the text typed, not only the tags starting with it.",
                html: `<label for="${id}-q">Filter</label>
    <input id="${id}-q" type="text" value="">
    <button id="${id}-go" type="button">Filter</button>
    <output id="${id}-out">${items.join(", ")}</output>`,
                js: `(function () {
    const items = ${JSON.stringify(items)};
    const out = document.querySelector("#${id}-out");
    document.querySelector("#${id}-go").addEventListener("click", function () {
        const needle = document.querySelector("#${id}-q").value;
        const kept = items.filter(function (item) {
            ${defective ? "return item.indexOf(needle) === 0;" : "return item.indexOf(needle) >= 0;"}
        });
        out.textContent = kept.length === 0 ? "no ${ref} matches for " + needle : kept.join(", ") + " for " + needle;
    });
})();`,
                probe: [`type #${id}-q ${needle}`, `click #${id}-go`],
                evidence: `text --selector=#${id}-out`,
                note: defective ? "anchors the match to the start" : "matches anywhere",
            };
        },
    },
];

/* --------------------------------------------------------------- widgets */

// Four broken and one correct per template, shuffled across the routes, so
// neither the route nor the position predicts which widgets are defective.
const plan = [];
for (let index = 0; index < TEMPLATES.length; index++) {
    for (let copy = 0; copy < 5; copy++) {
        plan.push({ template: index, defective: copy < 4 });
    }
}

let shuffleSeed = 20260918;
const shuffle = () => ((shuffleSeed = (shuffleSeed * 1103515245 + 12345) & 0x7fffffff), shuffleSeed / 0x7fffffff);
for (let index = plan.length - 1; index > 0; index--) {
    const swap = Math.floor(shuffle() * (index + 1));
    [plan[index], plan[swap]] = [plan[swap], plan[index]];
}

function buildWidgets(forceCorrect) {
    return plan.map((entry, index) => {
        const id = `w-${String(index + 1).padStart(2, "0")}`;
        const template = TEMPLATES[entry.template];
        const route = ROUTES[index % ROUTES.length][0];
        const ref = `${WORDS[index % WORDS.length]}${index + 1}`;
        const defective = forceCorrect ? false : entry.defective;
        const built = template.build(id, defective, streamFor(index), ref);

        return {
            id,
            route,
            ref,
            kind: template.kind,
            title: template.title,
            defective,
            ...built,
            probe: built.probe.map((step) => step.split("${route}").join(route)),
        };
    });
}

const widgets = buildWidgets(false);
const shadow = buildWidgets(true);

/* ----------------------------------------------------------- app writing */

function writeApp(target, list) {
    fs.rmSync(path.join(target, "app"), { recursive: true, force: true });
    fs.mkdirSync(path.join(target, "app", "js"), { recursive: true });
    fs.mkdirSync(path.join(target, "app", "pages"), { recursive: true });
    const routeTable = {};
    const api = {};
    for (const [route, title] of ROUTES) {
        const own = list.filter((widget) => widget.route === route);
        const nav = ROUTES.map(([href, label]) => `<a href="${href}">${label}</a>`).join("\n      ");
        const sections = own
            .map(
                (widget) => `  <section id="${widget.id}" class="widget" data-widget="${widget.id}">
    <h3>${widget.title}</h3>
    <p class="spec">${widget.spec}</p>
    ${widget.html}
  </section>
  <script src="js/${widget.id}.js"></script>`,
            )
            .join("\n");
        const file = `pages/${route.slice(1)}.html`;
        routeTable[route] = file;
        fs.writeFileSync(
            path.join(target, "app", file),
            `<!doctype html>
<html lang="en">
<head>
  <title>${title}</title>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <nav aria-label="Main">
      ${nav}
    </nav>
  </header>
  <main>
${sections}
  </main>
</body>
</html>
`,
        );
        for (const widget of own) {
            fs.writeFileSync(path.join(target, "app", "js", `${widget.id}.js`), `${widget.js}\n`);
            Object.assign(api, widget.api ?? {});
        }
    }

    fs.writeFileSync(path.join(target, "app", "routes.json"), `${JSON.stringify(routeTable, null, 2)}\n`);
    fs.writeFileSync(path.join(target, "app", "api.json"), `${JSON.stringify(api, null, 2)}\n`);

    return Object.keys(api).length;
}

const endpoints = writeApp(root, widgets);

fs.writeFileSync(
    path.join(root, "README.md"),
    `# Storefront QA

\`app/\` is a small web application: ten routes, fifty widgets. Drive it with
the \`webqa\` command — run \`webqa\` with no arguments for the command list.

Every widget states its own acceptance criterion in the \`.spec\` paragraph
beside it. That sentence is the contract. A widget whose behaviour does not
match its own criterion is a defect; a widget that matches it is not, however
unusual the code looks.

Some widgets are correct. Reporting one as broken costs more than leaving it
out, so confirm before you file.
`,
);

/* ------------------------------------------------------------ answer key */

// The key is read out of the fixture, never asserted against it: this drives
// the real engine through every widget and records what it printed.
function probeAll(target, list) {
    const impl = path.join(target, ".webqa-impl.mjs");
    const run = (args) => {
        const result = spawnSync(process.execPath, [impl, ...args], { encoding: "utf8", cwd: target });

        return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    };

    const observed = new Map();
    for (const widget of list) {
        run(["reset"]);
        run(["goto", widget.route]);
        for (const step of widget.probe) {
            run(step.split(" "));
        }

        observed.set(widget.id, run(widget.evidence.split(" ")));
    }

    fs.rmSync(path.join(target, ".webqa"), { recursive: true, force: true });

    return observed;
}

const observed = probeAll(root, widgets);

// The same application with every defect removed, driven the same way. A
// "defect" whose fixed version prints the same thing is not a defect, and
// this is where the suite finds that out rather than a harness finding it.
const shadowDir = path.join(root, ".shadow");
fs.rmSync(shadowDir, { recursive: true, force: true });
fs.mkdirSync(shadowDir, { recursive: true });
for (const name of [".webqa-impl.mjs", ".webqa-dom.mjs"]) {
    fs.copyFileSync(path.join(root, name), path.join(shadowDir, name));
}

writeApp(shadowDir, shadow);
const shadowObserved = probeAll(shadowDir, shadow);
fs.rmSync(shadowDir, { recursive: true, force: true });

const inert = widgets.filter((widget) => widget.defective && observed.get(widget.id) === shadowObserved.get(widget.id));
const phantom = widgets.filter(
    (widget) => !widget.defective && observed.get(widget.id) !== shadowObserved.get(widget.id),
);

/* ----------------------------------------------------------- key writing */

// The fragments a harness cannot quote without having determined the widget's
// real behaviour. Every widget stamps its own reference word into its output,
// so a fragment set proves one widget and never another. The a11y rows are
// long, so those are reduced to the selector plus the attribute in question
// rather than demanding the whole line come back verbatim.
function tokensFor(widget, text) {
    const lines = text.split("\n").filter(Boolean);
    if (widget.kind === "runtime-error") {
        const line = lines.find((entry) => entry.startsWith("ERROR")) ?? lines[0] ?? "";

        return [line.replace(/^ERROR\s+/u, "")];
    }

    if (widget.kind === "aria-state") {
        const row = lines[0] ?? "";
        const match = /aria-expanded="[^"]*"/u.exec(row);

        return [`${widget.id}-toggle`, match === null ? row : match[0]];
    }

    if (widget.kind === "accessible-name") {
        const row = lines[0] ?? "";
        const match = /name="[^"]*"/u.exec(row);

        return [`${widget.id}-field`, match === null ? row : match[0]];
    }

    return [lines[lines.length - 1] ?? ""];
}

const key = widgets.map((widget) => ({
    id: widget.id,
    route: widget.route,
    kind: widget.kind,
    title: widget.title,
    ref: widget.ref,
    defective: widget.defective,
    spec: widget.spec,
    probe: widget.probe,
    evidence: widget.evidence,
    observed: observed.get(widget.id),
    tokens: tokensFor(widget, observed.get(widget.id)),
    note: widget.note,
}));

fs.writeFileSync(path.join(taskDir, "KEY.json"), `${JSON.stringify(key, null, 2)}\n`);

const fixtures = {};
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
        } else if (entry.isFile()) {
            const relative = path.relative(root, full).split(path.sep).join("/");
            const text = fs.readFileSync(full, "utf8").split("\r\n").join("\n");
            fixtures[relative] = createHash("sha256").update(text).digest("hex");
        }
    }
};

walk(path.join(root, "app"));
for (const name of [".webqa-impl.mjs", ".webqa-dom.mjs"]) {
    const text = fs.readFileSync(path.join(root, name), "utf8").split("\r\n").join("\n");
    fixtures[name] = createHash("sha256").update(text).digest("hex");
}

fs.writeFileSync(path.join(taskDir, "FIXTURES.json"), `${JSON.stringify(fixtures, null, 2)}\n`);

const defective = key.filter((entry) => entry.defective).length;
console.log(`widgets: ${key.length}, defective: ${defective}, correct: ${key.length - defective}`);
console.log(`routes: ${ROUTES.length}, api endpoints: ${endpoints}`);

const problems = [];
if (inert.length > 0) {
    problems.push(`defects that behave exactly like their fixed version: ${inert.map((w) => w.id).join(", ")}`);
}

if (phantom.length > 0) {
    problems.push(`correct widgets that differ from the reference build: ${phantom.map((w) => w.id).join(", ")}`);
}

const blank = key.filter((entry) => entry.tokens.some((token) => token.length === 0)).map((entry) => entry.id);
if (blank.length > 0) {
    problems.push(`widgets with no evidence token: ${blank.join(", ")}`);
}

const seen = new Map();
for (const entry of key) {
    const fingerprint = entry.tokens.join(" | ");
    seen.set(fingerprint, [...(seen.get(fingerprint) ?? []), entry.id]);
}

const shared = [...seen].filter(([, ids]) => ids.length > 1);
if (shared.length > 0) {
    problems.push(`tokens shared by more than one widget: ${shared.map(([, ids]) => ids.join("/")).join(", ")}`);
}

for (const problem of problems) {
    console.error(problem);
}

process.exitCode = problems.length > 0 ? 1 : 0;
