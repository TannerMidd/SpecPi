#!/usr/bin/env node
// SpecPi Remote daemon entry point.
//
// Starts Pi in RPC mode, binds a loopback HTTP server, and prints a pairing
// link. Reachability from a phone is the tunnel's job, not this process's.

import { RpcBridge } from "../src/rpc-bridge.js";
import { RemoteServer } from "../src/server.js";
import { TokenAuth } from "../src/auth.js";

const USAGE = `SpecPi Remote — drive a local Pi agent from a phone

Usage: specpi-remote [options]

Options:
  --port <number>    Port to bind on 127.0.0.1 (default 8787)
  --cwd <path>       Working directory for the Pi agent (default: current)
  --pi <command>     Pi executable (default: pi, or SPECPI_REMOTE_PI_BIN)
  --token <value>    Use a fixed pairing token instead of generating one
  -h, --help         Show this help

The daemon binds 127.0.0.1 only. Reach it from a phone over Tailscale,
WireGuard, or an SSH tunnel. Never expose the port directly.
`;

function parseArgs(argv) {
    const options = { port: 8787, cwd: process.cwd(), pi: undefined, token: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "-h" || arg === "--help") {
            return { help: true };
        }

        if (arg === "--port") {
            const value = Number.parseInt(argv[++index], 10);
            if (!Number.isInteger(value) || value < 1 || value > 65535) {
                return { error: "--port must be a port number between 1 and 65535" };
            }

            options.port = value;
            continue;
        }

        if (arg === "--cwd") {
            options.cwd = argv[++index];
            if (!options.cwd) {
                return { error: "--cwd requires a path" };
            }

            continue;
        }

        if (arg === "--pi") {
            options.pi = argv[++index];
            if (!options.pi) {
                return { error: "--pi requires a command" };
            }

            continue;
        }

        if (arg === "--token") {
            options.token = argv[++index];
            if (!options.token) {
                return { error: "--token requires a value" };
            }

            continue;
        }

        return { error: `Unknown option: ${arg}` };
    }

    return { options };
}

async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
        process.stdout.write(USAGE);

        return;
    }

    if (parsed.error) {
        process.stderr.write(`${parsed.error}\n\n${USAGE}`);
        process.exitCode = 1;

        return;
    }

    const { options } = parsed;
    const auth = new TokenAuth({ token: options.token });
    const bridge = new RpcBridge({
        cwd: options.cwd,
        command: options.pi || process.env.SPECPI_REMOTE_PI_BIN || "pi",
    });
    const server = new RemoteServer({ bridge, auth, port: options.port });

    bridge.start();
    await server.listen();

    process.stdout.write(
        [
            "",
            "SpecPi Remote is listening on 127.0.0.1 only.",
            `  Agent directory: ${options.cwd}`,
            "",
            "Pair a phone by opening this link through your tunnel,",
            "replacing 127.0.0.1 with the tunnel host:",
            "",
            `  http://127.0.0.1:${options.port}/?t=${auth.token}`,
            "",
            "The token moves into a cookie on first load. Keep this link private:",
            "anyone holding it can drive the agent and answer its approvals.",
            "",
        ].join("\n"),
    );

    let closing = false;
    const shutdown = async () => {
        if (closing) {
            return;
        }

        closing = true;
        process.stdout.write("\nShutting down. Pending approvals are cancelled, not granted.\n");
        await server.close();
        await bridge.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    bridge.on("closed", (reason) => {
        process.stderr.write(`Pi is no longer running: ${reason}\n`);
    });
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
});
