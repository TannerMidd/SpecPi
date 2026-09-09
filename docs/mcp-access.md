# MCP integration decision

MCP access is **deferred**, not enabled or bundled in this release. The selected integration plan required a restricted adapter profile before adoption. The published `pi-mcp-adapter@2.32.1` artifact does not meet that gate without upstream changes or a separately reviewed client.

The September 9, 2026 artifact review used npm integrity:

```text
sha512-GNLYa2U9T5ZqIhZmhx/RTenEjfakJTelq/z6Q+At5SIxyuYvrvobriDEVsnx+lqetVDizUCudTWLfdZytQu0rg==
```

| Published code | Finding | SpecPi requirement affected |
| --- | --- | --- |
| `index.ts`, `init.ts` | Programmatic configuration still loads metadata caches; initialization creates/updates a disk cache | Explicit in-memory-only metadata for the initial restricted pilot |
| `tool-approval.ts` | `ensureToolCallApproved` returns for an existing cached grant before consulting the broker | Every-call policy/root/schema revocation must be authoritative |
| `mcp-output-guard.ts` | Oversized output spills raw results to temporary files; the documented alternative disables output guarding | Bounded output without automatic raw retention |
| `types.ts` | Factory options provide `config` and `configPath`, not a complete restricted-mode contract | Supported integration controls rather than hidden monkey-patching |

These are compatibility findings against SpecPi's proposed contract, not claims that the adapter is generally unsafe. The published artifact differs from the moving `main` source inspected during planning: the session-branch approval restoration observed there was not found in this release's `index.ts`. Do not attribute that moving-branch behavior to 2.32.1.

No server was connected, no credentials or live Pi state were inspected, and the adapter was not registered in Pi. Adoption needs an upstream restricted mode with broker checks before all cached grants, controlled connection admission, optional in-memory metadata, no automatic raw spills, and disabled alternate execution/authentication routes. Tests must cover the exact published artifact and pinned Pi 0.84.4.

A first-party client using the official MCP SDK remains an alternative once a specific service operation is selected and its transport/credential ownership can be reviewed. There is no production server, MCP executable dependency, new authentication flow or placeholder MCP tool in this release. Existing service-specific tools continue to work under their own contracts.

References: [adapter project](https://github.com/nicobailon/pi-mcp-adapter), [npm version 2.32.1](https://www.npmjs.com/package/pi-mcp-adapter/v/2.32.1), [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Moving repository branches are not substitutes for inspecting the published tarball.
