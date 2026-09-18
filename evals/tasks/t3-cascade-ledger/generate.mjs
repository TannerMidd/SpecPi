// Generates t3-cascade-ledger: a long-horizon task built so that the three
// shortcuts that saturated every previous tier are all closed.
//
//  1. No batch fix. The verifier walks the chain in a fixed order and reports
//     ONLY the first failing module. Which module breaks next cannot be known
//     without fixing the current one, so a single sweeping edit cannot land it.
//  2. No exhaustive read. 1,200 modules exist and only 120 are in the chain.
//     Reading everything costs far more than following the chain, and the
//     chain order is not derivable from the filesystem.
//  3. No mechanical transform. Each fix is governed by one of 600 rules in
//     RULES.md, cited by id in the failure message, and the rules disagree:
//     late "superseding" rules retroactively change what an earlier module
//     should have done, so work already accepted has to be revisited.
//
// The verifier ships as .verify-impl.mjs and is reached through the shimmed
// `chainverify` command, whose first three invocations fail on purpose. That
// is how recovery gets measured: the fault clears on its own, so a harness
// that retries finishes and one that gives up does not.
//
// Regenerating is deterministic, but it changes nothing unless the constants
// below change. Afterwards run prettier over the generated verifier and
// re-pin FIXTURES.json, because the checker compares those files by hash.
//
// Score is the share of chain modules left correct, so partial progress is
// kept and a harness that repairs 40 of 120 scores 0.333 rather than zero.
// The consecutive depth the verifier reaches is reported alongside it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.argv[2];
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const write = (relative, text) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
};

const writeTaskFile = (relative, text) => fs.writeFileSync(path.join(root, "..", relative), text);

let seed = 20260918;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
const pick = (list) => list[Math.floor(rnd() * list.length)];

const DOMAINS = ["billing", "search", "inbox", "ledger", "routing", "identity", "media", "reports", "audit", "intake"];
const KINDS = ["api", "worker", "cron", "gateway", "cache", "stream", "codec", "policy"];
const TOTAL_MODULES = 1200;
const CHAIN_LENGTH = 120;
const RULE_COUNT = 600;

/* ---------- rules ---------- */

// Four families of transform. Each is a small, judged change: the rule says
// what the exported function must return, and the module has to be edited to
// match. None of them is a find-and-replace across the tree, because which
// rule governs which module is only stated in the failure message.
const FAMILIES = [
    {
        id: "scale",
        describe: (n) => `must multiply its input by ${n} and return the result`,
        body: (n) => `    return value * ${n};`,
        broken: (n) => `    return value * ${n + 1};`,
    },
    {
        id: "offset",
        describe: (n) => `must add ${n} to its input and return the result`,
        body: (n) => `    return value + ${n};`,
        broken: (n) => `    return value - ${n};`,
    },
    {
        id: "clamp",
        describe: (n) => `must return its input clamped to a maximum of ${n}`,
        body: (n) => `    return value > ${n} ? ${n} : value;`,
        broken: (n) => `    return value < ${n} ? ${n} : value;`,
    },
    {
        id: "floor",
        describe: (n) => `must return its input clamped to a minimum of ${n}`,
        body: (n) => `    return value < ${n} ? ${n} : value;`,
        broken: (n) => `    return value > ${n} ? ${n} : value;`,
    },
];

const rules = [];
for (let index = 0; index < RULE_COUNT; index++) {
    const family = FAMILIES[index % FAMILIES.length];
    const n = 2 + Math.floor(rnd() * 40);
    rules.push({ id: `R${String(index + 1).padStart(3, "0")}`, family: family.id, n, supersedes: null });
}

/* ---------- modules ---------- */

const names = new Set();
const modules = [];
while (modules.length < TOTAL_MODULES) {
    const name = `${pick(DOMAINS)}-${pick(KINDS)}-${String(modules.length).padStart(3, "0")}`;
    if (names.has(name)) {
        continue;
    }

    names.add(name);
    modules.push({ name, relative: `src/${name}.js` });
}

// The chain: a subset of the modules scattered through the tree, in an order that has
// nothing to do with their names or their position on disk.
const chainIndexes = new Set();
while (chainIndexes.size < CHAIN_LENGTH) {
    chainIndexes.add(Math.floor(rnd() * TOTAL_MODULES));
}

const chain = [...chainIndexes].map((index) => modules[index]);
// Shuffle so chain order is independent of file order.
for (let index = chain.length - 1; index > 0; index--) {
    const swap = Math.floor(rnd() * (index + 1));
    [chain[index], chain[swap]] = [chain[swap], chain[index]];
}

// Assign each chain step a governing rule. Fifteen late steps supersede an
// earlier step's rule, which sends the harness back to a module it already
// fixed and had accepted.
const steps = chain.map((module, position) => ({
    position,
    module,
    rule: rules[Math.floor(rnd() * RULE_COUNT)],
    supersedes: null,
}));

const supersedeAt = [14, 22, 29, 37, 44, 51, 58, 66, 73, 81, 88, 96, 103, 111, 117];
for (const at of supersedeAt) {
    if (at >= steps.length) {
        continue;
    }

    const targetPosition = Math.floor(rnd() * Math.max(1, at - 6));
    steps[at].supersedes = targetPosition;
}

const ruleFor = (family, n) => FAMILIES.find((entry) => entry.id === family).describe(n);
const bodyFor = (family, n) => FAMILIES.find((entry) => entry.id === family).body(n);
const brokenFor = (family, n) => FAMILIES.find((entry) => entry.id === family).broken(n);

/* ---------- RULES.md ---------- */

const ruleLines = ["# Transform rules", "", "Each rule governs one exported `apply(value)`.", ""];
for (const rule of rules) {
    ruleLines.push(`## ${rule.id}`, "", `\`apply\` ${ruleFor(rule.family, rule.n)}.`, "");
}

// The superseding rules are appended as their own section so they read as
// late amendments rather than as part of the original list.
ruleLines.push("## Amendments", "");
for (const step of steps) {
    if (step.supersedes === null) {
        continue;
    }

    const target = steps[step.supersedes];
    ruleLines.push(
        `- **${step.rule.id}-A** supersedes the rule for \`${target.module.name}\`: once ${step.rule.id} is in force,`,
        `  \`${target.module.name}\` ${ruleFor(step.rule.family, step.rule.n)} instead.`,
        "",
    );
}

write("RULES.md", `${ruleLines.join("\n")}\n`);

/* ---------- modules on disk ---------- */

const stepByModule = new Map(steps.map((step) => [step.module.name, step]));
for (const module of modules) {
    const step = stepByModule.get(module.name);
    // Off-chain modules are already correct and must stay untouched; they are
    // the bulk that makes reading everything the expensive path.
    const rule = step ? step.rule : rules[Math.floor(rnd() * RULE_COUNT)];
    const correct = !step;
    const lines = [
        `// module ${module.name}`,
        `// governed by ${rule.id}`,
        "",
        "export function apply(value) {",
        correct ? bodyFor(rule.family, rule.n) : brokenFor(rule.family, rule.n),
        "}",
        "",
    ];
    write(module.relative, lines.join("\n"));
}

/* ---------- effective rules, after amendments ---------- */

// An amendment retroactively changes what an earlier module must do, so the
// state the workspace is graded against is the rule in force at the end of
// the chain, not the one the module was first fixed under.
function effectiveRule(step) {
    let current = { family: step.rule.family, n: step.rule.n };
    for (const other of steps) {
        if (other.supersedes === null) {
            continue;
        }

        if (steps[other.supersedes].module.name === step.module.name) {
            current = { family: other.rule.family, n: other.rule.n };
        }
    }

    return current;
}

const CASES = [0, 1, 3, 7, 12, 25, 41, 64];
const APPLY = {
    scale: (n) => (value) => value * n,
    offset: (n) => (value) => value + n,
    clamp: (n) => (value) => (value > n ? n : value),
    floor: (n) => (value) => (value < n ? n : value),
};

const digestOf = (family, n) =>
    createHash("sha256")
        .update(JSON.stringify(CASES.map(APPLY[family](n))))
        .digest("hex");

const answer = steps.map((step) => {
    const rule = effectiveRule(step);

    return {
        position: step.position,
        module: step.module.name,
        relative: step.module.relative,
        ruleId: step.rule.id,
        family: rule.family,
        n: rule.n,
        digest: digestOf(rule.family, rule.n),
        supersedes: step.supersedes,
        supersededModule: step.supersedes === null ? null : steps[step.supersedes].module.name,
    };
});
writeTaskFile("CHAIN.json", `${JSON.stringify(answer, null, 2)}\n`);

/* ---------- verify.mjs ---------- */

// What the harness is given. It reveals exactly one failure at a time, and it
// carries digests rather than rule parameters: reading it tells you which
// module is next and which rule governs it, never what the fix is.
const verify = `#!/usr/bin/env node
// Walks the chain in order and reports the FIRST module that is wrong.
// It will not tell you what comes next until this one passes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const chain = JSON.parse(fs.readFileSync(path.join(here, ".chain.json"), "utf8"));
const CASES = ${JSON.stringify(CASES)};

let reached = 0;
for (const step of chain) {
    const file = path.join(here, step.relative);
    let apply = null;
    try {
        const loaded = await import(\`\${pathToFileURL(file).href}?t=\${fs.statSync(file).mtimeMs}\`);
        apply = loaded.apply;
    } catch (error) {
        console.log(\`FAIL \${step.module} (chain position \${step.position} of \${chain.length})\`);
        console.log(\`  rule \${step.ruleId} — see RULES.md, including the Amendments section\`);
        console.log(\`  \${step.relative} could not be imported: \${String(error?.message ?? error).split("\\n")[0]}\`);
        process.exit(1);
    }

    if (typeof apply !== "function") {
        console.log(\`FAIL \${step.module} (chain position \${step.position} of \${chain.length})\`);
        console.log(\`  rule \${step.ruleId} — see RULES.md, including the Amendments section\`);
        console.log(\`  \${step.relative} does not export apply\`);
        process.exit(1);
    }

    let outputs = null;
    try {
        outputs = CASES.map((value) => apply(value));
    } catch (error) {
        console.log(\`FAIL \${step.module} (chain position \${step.position} of \${chain.length})\`);
        console.log(\`  rule \${step.ruleId} — see RULES.md, including the Amendments section\`);
        console.log(\`  apply threw: \${String(error?.message ?? error).split("\\n")[0]}\`);
        process.exit(1);
    }

    if (createHash("sha256").update(JSON.stringify(outputs)).digest("hex") !== step.digest) {
        console.log(\`FAIL \${step.module} (chain position \${step.position} of \${chain.length})\`);
        console.log(\`  rule \${step.ruleId} — see RULES.md, including the Amendments section\`);
        console.log(\`  \${step.relative}: apply(\${CASES.join(", ")}) returned \${outputs.join(", ")}\`);
        process.exit(1);
    }

    reached = step.position + 1;
}

console.log(\`OK all \${chain.length} chain modules satisfy their rules\`);
console.log(\`reached \${reached}\`);
`;

write("verify.mjs", verify);
write(
    ".chain.json",
    `${JSON.stringify(
        answer.map((step) => ({
            position: step.position,
            module: step.module,
            relative: step.relative,
            ruleId: step.ruleId,
            digest: step.digest,
        })),
        null,
        2,
    )}\n`,
);

write(
    "README.md",
    `# Transform modules

\`src/\` holds ${TOTAL_MODULES} modules. Each exports \`apply(value)\` and each names
the rule that governs it in a comment at the top. The rules are in \`RULES.md\`.

Some modules do not satisfy their rule. Run:

    node verify.mjs

It reports the first module that is wrong and stops. Fix that module, run it
again, and it reports the next one. It never reports more than one at a time,
and the order is not the order of the files on disk.

Read the Amendments section of \`RULES.md\`. A few late rules change what an
earlier module must do, so a module you already fixed can come back.
`,
);

console.log(`modules: ${TOTAL_MODULES}, chain: ${CHAIN_LENGTH}, rules: ${RULE_COUNT}`);
console.log(`amendments: ${steps.filter((step) => step.supersedes !== null).length}`);
const srcBytes = fs
    .readdirSync(path.join(root, "src"))
    .reduce((total, name) => total + fs.statSync(path.join(root, "src", name)).size, 0);
console.log(
    `src ${(srcBytes / 1024).toFixed(0)} KB, RULES.md ${(fs.statSync(path.join(root, "RULES.md")).size / 1024).toFixed(0)} KB`,
);
