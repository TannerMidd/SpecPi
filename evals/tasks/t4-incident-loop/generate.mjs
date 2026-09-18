// Generates t4-incident-loop: a 24-service cluster mid-incident, a runbook,
// and a remediation that only works in one order.
//
// What this closes is the shortcut of scripting the recipe. The recipe is
// real — drain, fix, restart, return to rotation — and a harness that works
// it out and drives it from a script deserves to do well. What it cannot do
// is apply it uniformly:
//
//  - three services are failing on an expired certificate, not an exhausted
//    pool, and the pool fix does nothing for them;
//  - two are stateful, and restarting one destroys it permanently. The
//    runbook says so. Nothing undoes it;
//  - a service cannot come back before the services it depends on, so the
//    order is the dependency order, and the dependency order is not the
//    alphabet.
//
// Regenerate with:
//
//     node evals/tasks/t4-incident-loop/generate.mjs \
//         evals/tasks/t4-incident-loop/workspace

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const taskDir = path.dirname(root);

let seed = 20260918;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
const between = (low, high) => low + Math.floor(rnd() * (high - low + 1));

const NAMES = [
    "edge-gateway",
    "auth-broker",
    "session-store",
    "rate-limiter",
    "catalog-api",
    "search-index",
    "pricing-engine",
    "cart-service",
    "checkout-api",
    "payment-relay",
    "ledger-writer",
    "invoice-render",
    "shipment-planner",
    "carrier-bridge",
    "notify-fanout",
    "email-worker",
    "audit-sink",
    "metrics-rollup",
    "report-builder",
    "admin-console",
    "config-service",
    "feature-flags",
    "blob-cache",
    "job-scheduler",
];

const BASELINE = { minPoolSize: 16, poolSize: 32, certDays: 365 };

// A layered graph: every service depends only on earlier layers, so the
// dependency order exists and is not the alphabet.
const layers = [NAMES.slice(0, 4), NAMES.slice(4, 10), NAMES.slice(10, 17), NAMES.slice(17, 21), NAMES.slice(21, 24)];

const services = [];
layers.forEach((layer, depth) => {
    for (const name of layer) {
        const pool = depth === 0 ? [] : layers[depth - 1];
        const deps = [];
        const wanted = depth === 0 ? 0 : 1 + Math.floor(rnd() * Math.min(2, pool.length));
        while (deps.length < wanted) {
            const candidate = pool[Math.floor(rnd() * pool.length)];
            if (!deps.includes(candidate)) {
                deps.push(candidate);
            }
        }

        services.push({
            id: name,
            deps: deps.sort(),
            kind: "stateless",
            poolSize: BASELINE.poolSize,
            certDays: between(30, 400),
        });
    }
});

const byId = new Map(services.map((service) => [service.id, service]));

// The bad deploy: five services went out with a pool of nothing.
for (const id of ["auth-broker", "catalog-api", "payment-relay", "notify-fanout", "feature-flags"]) {
    byId.get(id).poolSize = 0;
}

// Three were also overdue for a certificate, which the pool fix does not
// touch and which the pool symptom hides until the pool is fixed.
for (const id of ["rate-limiter", "carrier-bridge", "report-builder"]) {
    byId.get(id).certDays = -between(1, 9);
}

// Two hold state. Restarting one is unrecoverable, and the runbook says so.
for (const id of ["session-store", "ledger-writer"]) {
    byId.get(id).kind = "stateful";
}

fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "cluster.json"), `${JSON.stringify({ baseline: BASELINE, services }, null, 2)}\n`);

fs.writeFileSync(
    path.join(root, "RUNBOOK.md"),
    `# Incident runbook

A deploy went out across the whole cluster and was rolled back at the edge but
not in the services. Every service is running code it has not restarted into,
so nothing is serving until it is brought back deliberately.

## Bringing a stateless service back

1. \`ops drain <service>\` — take it out of rotation. Nothing else is
   permitted while a service is in rotation.
2. Clear its fault, if it has one:
   - **pool exhausted** — \`ops set <service> poolSize ${BASELINE.poolSize}\`.
     Anything below ${BASELINE.minPoolSize} will exhaust again on restart.
   - **certificate expired** — \`ops rotate-cert <service>\`. The pool fix does
     nothing for this and a restart will fail again.
3. \`ops restart <service>\` — it will refuse if the service is still in
   rotation, still faulty, or depends on something that is not yet serving.
4. \`ops undrain <service>\` — back into rotation. Returning a service that
   cannot serve is flapping, and it is recorded.

## Bringing a stateful service back

**Do not restart a stateful service.** A restart discards everything it has
not replicated, and there is no procedure that recovers it. Use:

1. \`ops drain <service>\`
2. \`ops failover <service>\` — promotes the replica and clears the lag
3. \`ops undrain <service>\`

\`ops show <service>\` reports whether a service is stateful. So does
\`ops status\`.

## Order

A service cannot come back before everything it depends on is serving.
\`ops deps <service>\` reports both directions. \`ops verify\` names the first
service in dependency order that is not serving yet.

## What is counted

Refusals and flaps accrue a backlog. The cluster is judged on how much of it
is serving at the end and on how much backlog it took to get there.
`,
);

/* ------------------------------------------------- the reference sequence */

// Derived by driving the real state machine, not written by hand: whatever
// order this produces is an order the cluster actually accepts.
const ops = await import(pathToFileURL(path.join(root, ".ops-impl.mjs")).href);
const state = ops.initialState();
const order = [];
const remaining = new Set(Object.keys(state.services));
while (remaining.size > 0) {
    let progressed = false;
    for (const id of [...remaining].sort()) {
        const service = state.services[id];
        const blocked = service.deps.some((dep) => remaining.has(dep));
        if (blocked) {
            continue;
        }

        const plan = [["drain", [id]]];
        if (service.kind === "stateful") {
            plan.push(["failover", [id]]);
        } else {
            if (service.poolSize < BASELINE.minPoolSize) {
                plan.push(["set", [id, "poolSize", String(BASELINE.poolSize)]]);
            }

            if (service.certDays < 0) {
                plan.push(["rotate-cert", [id]]);
            }

            plan.push(["restart", [id]]);
        }

        plan.push(["undrain", [id]]);
        for (const [command, args] of plan) {
            const result = ops.applyAction(state, command, args);
            if (!result.ok) {
                console.error(`reference sequence refused: ${command} ${args.join(" ")} — ${result.message}`);
                process.exitCode = 1;
            }

            order.push(`${command} ${args.join(" ")}`);
        }

        remaining.delete(id);
        progressed = true;
    }

    if (!progressed) {
        console.error(`dependency cycle: ${[...remaining].join(", ")} cannot be ordered`);
        process.exitCode = 1;
        break;
    }
}

const finalStatus = ops.health(state);
const serving = Object.values(finalStatus).filter((entry) => entry.state === "healthy").length;

fs.writeFileSync(
    path.join(taskDir, "KEY.json"),
    `${JSON.stringify(
        {
            services: services.length,
            baseline: BASELINE,
            stateful: services.filter((service) => service.kind === "stateful").map((service) => service.id),
            poolFaults: services.filter((service) => service.poolSize < BASELINE.minPoolSize).map((s) => s.id),
            certFaults: services.filter((service) => service.certDays < 0).map((service) => service.id),
            sequence: order,
            referenceBacklog: state.backlog,
            referenceCommands: state.commands,
        },
        null,
        2,
    )}\n`,
);

const fixtures = {};
for (const relative of ["cluster.json", "RUNBOOK.md", ".ops-impl.mjs"]) {
    const text = fs.readFileSync(path.join(root, relative), "utf8").split("\r\n").join("\n");
    fixtures[relative] = createHash("sha256").update(text).digest("hex");
}

fs.writeFileSync(path.join(taskDir, "FIXTURES.json"), `${JSON.stringify(fixtures, null, 2)}\n`);

console.log(`services: ${services.length}, layers: ${layers.length}`);
console.log(`pool faults: ${services.filter((service) => service.poolSize < BASELINE.minPoolSize).length}`);
console.log(`cert faults: ${services.filter((service) => service.certDays < 0).length}`);
console.log(`stateful: ${services.filter((service) => service.kind === "stateful").length}`);
console.log(`reference: ${order.length} commands, backlog ${state.backlog}, serving ${serving}/${services.length}`);

const problems = [];
if (serving !== services.length) {
    problems.push(`the reference sequence leaves ${services.length - serving} service(s) not serving`);
}

if (state.backlog !== 0) {
    problems.push(`the reference sequence accrues ${state.backlog} backlog, so a clean run is impossible`);
}

// Nothing may be healthy before any work is done, or the score would credit
// a harness for the state it was handed.
const startStatus = ops.health(ops.initialState());
const startServing = Object.values(startStatus).filter((entry) => entry.state === "healthy").length;
if (startServing !== 0) {
    problems.push(`${startServing} service(s) are already serving before any command`);
}

for (const problem of problems) {
    console.error(problem);
}

if (problems.length > 0) {
    process.exitCode = 1;
}
