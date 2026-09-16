# SpecPi Remote security boundaries

SpecPi Remote puts a network front end on a local coding agent. That is a meaningful increase in exposure over running Pi at a terminal, and this document is specific about what the daemon does and does not guarantee.

It is trusted host code running with your privileges. It is **not** a sandbox, and it does not add a policy layer of its own.

## Network exposure

The daemon binds `127.0.0.1` and nothing else. Reachability from a phone comes from a tunnel you configure — Tailscale, WireGuard, or an SSH forward — never from an exposed listener. There is no relay mode, no hosted component, and no outbound connection to anything.

Traffic inside the tunnel is the tunnel's business. Over a plain SSH forward or a raw Tailscale IP the daemon speaks unencrypted HTTP; confidentiality comes from the transport underneath it. `tailscale serve` terminates TLS and is the recommended setup.

## Authentication

A pairing token is generated in memory at daemon start and printed to the local console. It is never written to disk: there is no credential file to leak, and a restart issues a new token.

Every request requires it, including the static client assets — an unauthenticated probe gets an identical 401 for every path and learns nothing about the surface. Comparison is constant-time. The token may be supplied as a bearer header, a cookie, or a `?t=` query parameter; the query form exists only so a pairing link can be opened once, and the daemon immediately redirects it into an `HttpOnly`, `SameSite=Strict` cookie so it does not persist in browser history or leak through a `Referer`.

The cookie is not marked `Secure`, because a `Secure` cookie is never sent over a plain-HTTP tunnel and the daemon would simply stop working. Anyone who obtains the token can drive the agent and answer its approvals.

## Credentials and session data

Provider credentials stay with Pi. The daemon never reads, stores, or proxies authentication files, provider credentials, trust decisions, or sessions. It reads only what the UI functionally needs from the connected conversation: `get_state`, `get_messages`, `get_entries`, `get_session_stats`.

Conversation content — prompts, model output, tool output, and approval context — does cross the tunnel to the phone and is rendered there. Treat the phone as inside your trust boundary.

## Rendering

Model output, tool output, and extension dialog text are untrusted. The client places every such value with `textContent`; nothing uses `innerHTML`. The daemon sends a `default-src 'none'` Content-Security-Policy with no inline script permitted, as the backstop for a mistake in that discipline. Tool output is truncated at a fixed budget with a visible marker, so what is on screen is never mistaken for the whole thing.

## Approvals

Approval dialogs are not Pi built-ins and not SpecPi code. They are `ctx.ui.select()` and `ctx.ui.confirm()` calls made by your permission package — `@gotgenes/pi-permission-system` in a default SpecPi install — surfaced over RPC as `extension_ui_request`. Remote renders them and returns the answer. It does not evaluate policy and does not duplicate enforcement.

The rules the daemon does enforce:

- **Bound to a connection.** An approval is handed to exactly one stream, and only that stream can answer it. A second phone, or the same phone reconnected, cannot grant an approval it never saw rendered.
- **No live connection means cancelled.** A dialog raised while nothing is connected is cancelled immediately, not left pending for whoever connects next.
- **Disconnect cancels.** When the answering stream closes, everything it owned is cancelled. Measured on loopback, the daemon sees the disconnect and sends the cancel within a few milliseconds.
- **A second connection supersedes the first.** The older stream is closed and its pending approvals cancelled — never transferred.
- **Too large to render is cancelled, not truncated.** A dialog past the display budget is refused outright. Approving against context the phone could not show is worse than walking to the desktop.
- **Answers must fit their dialog.** A `select` answer must be one of the options the agent actually offered; a `confirm` answer must be a boolean. A malformed answer is rejected rather than coerced, because coercion is how a malformed `confirm` becomes a grant.
- **Fire-and-forget requests are never answered.** `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text` are displayed only; replying to one would desynchronise the sub-protocol.
- **Shutdown cancels.** Pending approvals are cancelled on shutdown, never granted.

### The race this cannot close

Pi auto-resolves a timed dialog on the agent side — for `select`, with `undefined` — and its RPC documentation states that clients need not track timeouts. Remote cannot rely on that default meaning "deny", so it runs its own timer with a safety margin and sends `cancelled: true` ahead of the agent's deadline.

That is a race, not a guarantee. If the agent's auto-resolve lands before the daemon's cancel, the agent's default wins. Phone latency makes this window more relevant than it would be for a local client: a device waking from sleep can lose several seconds. The daemon narrows the window; it does not own the timer.

## Command surface

The daemon refuses any RPC command outside an explicit allowlist, at the bridge as well as at the HTTP layer. `bash` and `abort_bash` are excluded deliberately: arbitrary command execution from a phone is a far larger surface than remote approvals, and nothing in the mobile use case needs it. This is a refusal, not a hidden button.

Request bodies are capped at 1 MB and RPC records at 8 MB. An oversized upload is refused on its declared length before it is transferred.

## What it does not do

The daemon changes no Pi settings, edits no permission configuration, and installs nothing. It has no update mechanism and no telemetry. It cannot confine what the agent does once a tool call is approved — that authority belongs to your permission package and to Pi.

Another process running as the same user can read this process's memory, including the pairing token. Machine-level compromise is out of scope.

## Reporting

Report vulnerabilities through the process in the repository's [SECURITY.md](../SECURITY.md).
