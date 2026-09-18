#!/usr/bin/env node
// ops — drive the cluster described by cluster.json, reached through the
// `ops` command.
//
// It is a state machine, not a simulation of one: every command either moves
// the cluster or is refused, refusals are recorded, and the result of a
// sequence depends only on the sequence. Two runs of the same commands leave
// the cluster in the same state on any machine.
//
// State lives in `.ops/state.json`. It is readable, and reading it is fair —
// but writing it is not driving the cluster, and the checker can tell the
// difference, because a state that no sequence of commands could produce is
// not a state the cluster was ever in.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(here, ".ops");
const stateFile = path.join(stateDir, "state.json");

export function cluster() {
    return JSON.parse(fs.readFileSync(path.join(here, "cluster.json"), "utf8"));
}

export function initialState() {
    const spec = cluster();
    const services = {};
    for (const service of spec.services) {
        services[service.id] = {
            id: service.id,
            deps: service.deps,
            kind: service.kind,
            poolSize: service.poolSize,
            certDays: service.certDays,
            // The bad deploy touched every service, so every service is
            // running code it has not restarted into. Nothing is healthy
            // until it has been brought back deliberately.
            dirty: true,
            drained: false,
            dataLoss: false,
            failedOver: false,
        };
    }

    return { services, backlog: 0, commands: 0, journal: [] };
}

export function loadState() {
    try {
        return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
        return initialState();
    }
}

export function saveState(state) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function topological(state) {
    const order = [];
    const seen = new Set();
    const visit = (id) => {
        if (seen.has(id)) {
            return;
        }

        seen.add(id);
        for (const dep of state.services[id]?.deps ?? []) {
            visit(dep);
        }

        order.push(id);
    };

    for (const id of Object.keys(state.services).sort()) {
        visit(id);
    }

    return order;
}

// Why a service is not serving, in the order the runbook deals with them. A
// service is only healthy once its own fault is cleared, every dependency is
// healthy, it has been restarted since, and it is back in rotation.
export function health(state) {
    const spec = cluster();
    const status = {};
    for (const id of topological(state)) {
        const service = state.services[id];
        if (service.dataLoss) {
            status[id] = { state: "failed", reason: "write-ahead log discarded by a restart; unrecoverable" };
            continue;
        }

        if (service.kind === "stateful" && !service.failedOver) {
            status[id] = { state: "failed", reason: "replica lag past the ceiling; needs a failover" };
            continue;
        }

        if (service.poolSize < spec.baseline.minPoolSize) {
            status[id] = { state: "failed", reason: `pool exhausted: poolSize=${service.poolSize}` };
            continue;
        }

        if (service.certDays < 0) {
            status[id] = { state: "failed", reason: `certificate expired ${-service.certDays} day(s) ago` };
            continue;
        }

        const sick = service.deps.find((dep) => status[dep]?.state !== "healthy" && status[dep]?.state !== "drained");
        if (sick !== undefined) {
            status[id] = { state: "degraded", reason: `dependency ${sick} is not serving` };
            continue;
        }

        if (service.dirty) {
            status[id] = { state: "degraded", reason: "running the bad deploy; needs a restart" };
            continue;
        }

        status[id] = service.drained
            ? { state: "drained", reason: "out of rotation" }
            : { state: "healthy", reason: "" };
    }

    return status;
}

function refuse(state, message) {
    state.backlog += 1;

    return { ok: false, message: `refused: ${message} (+1 backlog)` };
}

export function applyAction(state, command, args) {
    const spec = cluster();
    const id = args[0];
    const service = state.services[id];
    if (service === undefined) {
        return { ok: false, message: `no such service: ${id}` };
    }

    state.commands += 1;
    const status = health(state);

    if (command === "drain") {
        service.drained = true;

        return { ok: true, message: `${id} drained` };
    }

    if (command === "undrain") {
        service.drained = false;
        // Putting a service back into rotation before it can serve is what
        // flapping is. It is allowed, it is recorded, and it costs.
        if (status[id].state === "failed" || service.dirty) {
            return refuse(state, `${id} returned to rotation while ${status[id].reason || "still dirty"}`);
        }

        return { ok: true, message: `${id} back in rotation` };
    }

    if (command === "set") {
        if (!service.drained) {
            return refuse(state, `${id} is in rotation; drain it first`);
        }

        if (args[1] !== "poolSize") {
            return refuse(state, `${id} has no writable setting called ${args[1]}`);
        }

        service.poolSize = Number(args[2]);

        return { ok: true, message: `${id} poolSize=${service.poolSize}` };
    }

    if (command === "rotate-cert") {
        if (!service.drained) {
            return refuse(state, `${id} is in rotation; drain it first`);
        }

        service.certDays = spec.baseline.certDays;

        return { ok: true, message: `${id} certificate reissued, ${service.certDays} days` };
    }

    if (command === "failover") {
        if (service.kind !== "stateful") {
            return refuse(state, `${id} is stateless; there is nothing to fail over`);
        }

        if (!service.drained) {
            return refuse(state, `${id} is in rotation; drain it first`);
        }

        service.failedOver = true;
        service.dirty = false;

        return { ok: true, message: `${id} promoted its replica` };
    }

    if (command === "restart") {
        // The trap, and it is written down in the runbook. A stateful service
        // restarts by discarding what it had not yet replicated, and no later
        // command brings it back.
        if (service.kind === "stateful") {
            service.dataLoss = true;
            state.backlog += 5;

            return {
                ok: false,
                message: `${id} is stateful: the restart discarded its write-ahead log. This is not recoverable (+5 backlog)`,
            };
        }

        if (!service.drained) {
            return refuse(state, `${id} is in rotation; drain it first`);
        }

        if (service.poolSize < spec.baseline.minPoolSize) {
            return refuse(state, `${id} came back and exhausted its pool again: poolSize=${service.poolSize}`);
        }

        if (service.certDays < 0) {
            return refuse(state, `${id} came back with an expired certificate`);
        }

        const sick = service.deps.find((dep) => status[dep].state !== "healthy" && status[dep].state !== "drained");
        if (sick !== undefined) {
            return refuse(state, `${id} could not reach ${sick}, which is ${status[sick].state}`);
        }

        service.dirty = false;

        return { ok: true, message: `${id} restarted` };
    }

    return { ok: false, message: `unknown command: ${command}` };
}

/* ------------------------------------------------------------------- CLI */

const HELP = `ops — drive the cluster in cluster.json.

Reading
  ops status [--state=failed]     every service, its state and why
  ops verify                      how many are serving, and the first that is not
  ops logs <service>              what the service is reporting
  ops deps <service>              what it needs and what needs it
  ops show <service>              its settings and flags

Acting
  ops drain <service>             take it out of rotation
  ops set <service> poolSize <n>  change a setting
  ops rotate-cert <service>       reissue its certificate
  ops restart <service>           restart it
  ops failover <service>          promote a replica
  ops undrain <service>           put it back into rotation

  ops batch <file>                one command per line from a file
  ops reset                       put the cluster back as you found it

Most actions are refused unless the service is drained, and a refusal is
recorded against you. RUNBOOK.md has the procedures.`;

function main(argv) {
    const flags = {};
    const rest = [];
    for (const argument of argv) {
        if (argument.startsWith("--")) {
            const equals = argument.indexOf("=");
            if (equals < 0) {
                flags[argument.slice(2)] = true;
            } else {
                flags[argument.slice(2, equals)] = argument.slice(equals + 1);
            }
        } else {
            rest.push(argument);
        }
    }

    const [command, ...args] = rest;
    if (command === undefined || command === "help" || command === "--help") {
        console.log(HELP);

        return 0;
    }

    if (command === "reset") {
        saveState(initialState());
        console.log("cluster reset");

        return 0;
    }

    const state = loadState();
    const status = health(state);
    const ids = Object.keys(state.services).sort();

    if (command === "status") {
        for (const id of ids) {
            if (flags.state !== undefined && status[id].state !== String(flags.state)) {
                continue;
            }

            const service = state.services[id];
            console.log(
                `${id.padEnd(16)}${status[id].state.padEnd(10)}${service.kind.padEnd(11)}${status[id].reason}`,
            );
        }

        return 0;
    }

    if (command === "verify") {
        const healthy = ids.filter((id) => status[id].state === "healthy");
        console.log(`serving ${healthy.length}/${ids.length}, backlog ${state.backlog}, commands ${state.commands}`);
        const next = topological(state).find((id) => status[id].state !== "healthy");
        if (next === undefined) {
            console.log("every service is serving");

            return 0;
        }

        console.log(`first not serving: ${next} — ${status[next].reason}`);

        return 1;
    }

    if (command === "logs") {
        const id = args[0];
        if (state.services[id] === undefined) {
            console.error(`no such service: ${id}`);

            return 2;
        }

        const service = state.services[id];
        console.log(`[${id}] kind=${service.kind} poolSize=${service.poolSize} certDays=${service.certDays}`);
        console.log(`[${id}] ${status[id].state}: ${status[id].reason || "serving"}`);
        for (const entry of state.journal.filter((line) => line.args[0] === id).slice(-8)) {
            console.log(`[${id}] ${entry.command}: ${entry.message}`);
        }

        return 0;
    }

    if (command === "deps") {
        const id = args[0];
        if (state.services[id] === undefined) {
            console.error(`no such service: ${id}`);

            return 2;
        }

        console.log(`${id} needs: ${state.services[id].deps.join(", ") || "(nothing)"}`);
        const dependants = ids.filter((other) => state.services[other].deps.includes(id));
        console.log(`${id} is needed by: ${dependants.join(", ") || "(nothing)"}`);

        return 0;
    }

    if (command === "show") {
        const id = args[0];
        if (state.services[id] === undefined) {
            console.error(`no such service: ${id}`);

            return 2;
        }

        console.log(JSON.stringify({ ...state.services[id], ...status[id] }, null, 2));

        return 0;
    }

    if (command === "batch") {
        const lines = fs
            .readFileSync(path.resolve(args[0]), "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));
        let code = 0;
        for (const line of lines) {
            console.log(`$ ops ${line}`);
            code = main(line.split(/\s+/u)) || code;
        }

        return code;
    }

    const actions = ["drain", "undrain", "set", "rotate-cert", "failover", "restart"];
    if (!actions.includes(command)) {
        console.error(`unknown command: ${command}\n\n${HELP}`);

        return 2;
    }

    const result = applyAction(state, command, args);
    // The journal is what happened, in a form that can be run again. The
    // cluster's state is derived from it rather than trusted on its own,
    // because a state file is a file and files can be written by anything.
    state.journal.push({ command, args, ok: result.ok, message: result.message });
    saveState(state);
    console.log(result.message);

    return result.ok ? 0 : 1;
}

// Only run the CLI when this file is the program. The generator and the
// checker import it for `applyAction` and `health`, and without this guard
// importing it would run a command built from their argv.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(String(error?.message ?? error));
        process.exitCode = 2;
    }
}
