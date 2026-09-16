# Third-party components

SpecPi Remote has **no runtime dependencies**. The daemon is built entirely on Node.js built-ins: `node:http`, `node:child_process`, `node:crypto`, `node:events`, `node:fs/promises`, `node:path`, and `node:url`. The phone client is plain HTML, CSS, and ES modules with no framework, no bundler, and no external asset — nothing is fetched from a CDN at runtime.

This was a deliberate transport decision rather than an accident of scope. Node 22 ships a WebSocket client but no WebSocket server, so a WebSocket transport would have required either the `ws` package or a hand-rolled RFC 6455 implementation. Remote is a separate artifact and could have taken that dependency — `packages/browser-qa` in this repository ships five pinned runtime dependencies — but for a security-sensitive remote-control path a small audit surface was worth more than duplex convenience. Server-Sent Events plus POST needs nothing beyond `node:http`, and its `Last-Event-ID` resume mirrors Pi's own `get_entries { since }` cursor, so the same idiom appears at both layers.

If that trade is ever revisited, the replacement must be pinned to an exact reviewed version and recorded here, per the repository's dependency rule in `AGENTS.md`.

## Development tooling

Formatting and linting come from the repository root: Prettier, ESLint, `@stylistic/eslint-plugin`, and `@typescript-eslint/parser`, at the versions pinned in the root `package.json` and documented in the root [THIRD_PARTY.md](../THIRD_PARTY.md). Tests use Node's built-in `node:test` runner. There is no separate tooling installation for this package.

## Runtime environment

Node.js 22.19.0 or newer, and a Pi installation the daemon spawns as `pi --mode rpc`. Pi and its own dependencies retain their upstream licenses and are not vendored here.

## Interface coupling

Remote renders approval dialogs raised by whatever permission package the host Pi installation has loaded. In a default SpecPi install that is **`@gotgenes/pi-permission-system` 32.0.2**, pinned by the root `templates/settings.json`. Its dialog titles, option strings, and message bodies are in practice the contract the approval cards render against, and SpecPi does not own them. A change to that package's dialog shapes can change how approvals appear here. This is an interface coupling, not a bundled dependency: Remote does not install, require, or version the package.

Remote also depends on the RPC contract documented in Pi's own `docs/rpc.md`, verified against Pi **0.84.4**.
