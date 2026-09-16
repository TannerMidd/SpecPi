# SpecPi Remote

Drive a local Pi coding agent from a phone: send prompts, steer a running turn, stop it, switch models, and answer tool-approval dialogs from a mobile web page.

SpecPi Remote is a **separate artifact**. It is not installed by the `specpi` npm package and the SpecPi installer never acquires it. Running a remote-control daemon should be a deliberate, separate act.

## What it is

A small Node daemon that spawns `pi --mode rpc`, binds an HTTP server to `127.0.0.1`, and serves a phone-first web client over that connection. It is a transport and display layer: it changes no Pi settings, no permission policies, and installs nothing. Your Permission System package remains the thing that decides what the agent may do.

```
Phone (mobile web / PWA)
   |  authenticated HTTP over a tunnel (Tailscale / WireGuard / SSH)
   v
SpecPi Remote daemon (127.0.0.1 only)
   |  pi --mode rpc, strict LF JSONL framing
   v
Pi agent + your installed packages, including Permission System
```

## Requirements

- Node.js 22.19.0 or newer
- A working `pi` on your `PATH` (or pass `--pi`)
- A tunnel to reach the machine from your phone: Tailscale, WireGuard, or an SSH port forward

On Windows an npm-installed `pi` is really `pi.cmd`, which Node cannot spawn directly. The daemon resolves it through `PATHEXT` and invokes it via `cmd.exe` with quoted arguments rather than handing the command line to a shell. This is automatic; `--pi` also accepts an explicit path to a `.cmd` or `.exe`.

## Running it

```sh
node bin/specpi-remote.mjs --cwd /path/to/your/project
```

The daemon prints a pairing link containing a one-time token:

```
http://127.0.0.1:8787/?t=<token>
```

Open that link on the phone **through your tunnel**, replacing `127.0.0.1` with the tunnel host. The token moves into an `HttpOnly` cookie on first load, so it does not linger in browser history.

Options:

| Flag              | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `--port <number>` | Port to bind on `127.0.0.1` (default `8787`)         |
| `--cwd <path>`    | Working directory for the agent (default: current)   |
| `--pi <command>`  | Pi executable (default `pi`, or `SPECPI_REMOTE_PI_BIN`) |
| `--token <value>` | Use a fixed pairing token instead of generating one  |

### Reaching it from the phone

The daemon binds loopback and nothing else. Pick one:

- **Tailscale** — `tailscale serve https / http://127.0.0.1:8787`. This gives you a real certificate, which is what makes the page installable to the home screen.
- **SSH** — `ssh -L 8787:127.0.0.1:8787 you@host` from the phone, then open `http://localhost:8787`. Also a secure context, because the origin is literally `localhost`.
- **Plain Tailscale IP** — `http://100.x.x.x:8787` works, but it is not a secure context, so the service worker will not register and the page cannot be installed. Everything else functions normally.

Never port-forward this to the internet. There is no relay mode and none is planned.

## Using it

- **Send / Steer** — the button becomes "Steer" while a turn is running, and the message is delivered as a steering message rather than a new prompt.
- **Stop** — aborts the current turn.
- **Approvals** — appear as cards above the composer. Every option is an explicit tap; there are no gesture shortcuts for granting permission.
- **Model and thinking** — populated from the agent, applied immediately.
- **Reconnect** — the page resumes the event stream where it left off. If it was away longer than the daemon's buffer, it says so and reloads the transcript rather than showing one with an invisible gap.

## What it deliberately does not do

- No remote shell. Pi's `bash` and `abort_bash` RPC commands are refused by the daemon, not just hidden in the UI.
- No internet relay hosting, and no multi-user access. One phone drives the agent; a second connection supersedes the first and cancels any approval the first was holding.
- No agent-side behaviour changes. Remote is a client of Pi's existing RPC surface.

## Development

```sh
npm test          # node --test tests/*.test.mjs
npm run check     # syntax check plus the full suite
```

Tests run against a synthetic RPC peer in `tests/fixtures/fake-pi.mjs`. They load no Pi, read no user configuration, and contact no provider: `PI_CODING_AGENT_DIR` points at a throwaway directory for every run. Real Pi is only ever exercised by manual device testing.

See [SECURITY.md](SECURITY.md) for the trust boundaries, including the one race this design cannot close.
