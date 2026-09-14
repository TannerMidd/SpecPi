#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHostEnvironment, findCodeExecutable } from "./host-environment.mjs";

const executable = findCodeExecutable();
const environment = createHostEnvironment();
process.stdout.write(`Opening SpecPi Chat with a deterministic test agent and isolated fixture workspace.\n`);
process.stdout.write(`Development profile retained at ${environment.directory}\n`);
const child = spawn(executable, environment.args, {
    env: environment.env,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
});
child.once("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
child.unref();
