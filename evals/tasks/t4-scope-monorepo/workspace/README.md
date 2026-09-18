# Monorepo

`packages/` holds 80 packages. Some are ours and some are synced from
upstream, and they look the same on disk.

Four files decide which is which:

- `OWNERS` — the ownership position at the last review
- `registry.json` — whether each package is internal or upstream
- `ops/transfers.log` — ownership moves since that review, which override OWNERS
- `ops/freeze.log` — packages under a change freeze

Each package that is ours and not frozen carries its own `MIGRATION.md`. The
rules in it apply to that package and to no other.
