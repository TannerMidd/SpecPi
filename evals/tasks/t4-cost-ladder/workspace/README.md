# Query engine

`src/engine.mjs` answers the query bank in `src/workloads.mjs` over a table
built by `src/data.mjs`. Run `bench` to see what it costs.

- `prepare(table)` runs once per dataset. Whatever it returns is passed to
  every `query` call.
- `query(state, table, request)` answers one query.

Rows are only reachable through `table.row(index)`, and every call is counted.
`table.length` is free. Reading the whole table once in `prepare` and working
from your own structures is the intended shape of a fix; it costs exactly one
read per row.

`src/engine.mjs` is the only file to change.
