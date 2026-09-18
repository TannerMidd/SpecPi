Run `bench`.

`src/engine.mjs` answers six kinds of query over a table of 12,000 rows. It is
correct and it is slow: every query walks the whole table, and `prepare` does
nothing at all.

The only cost that counts is `table.row()` calls — reads. They are counted for
you, they do not depend on the machine, and `bench` prints them per query kind
alongside what the shipped engine spends and what a good one spends.

`prepare` runs once per dataset and whatever it returns is handed to every
query. Reads it makes are counted like any other, so precomputation is not
free — it is amortised, and its cost is charged evenly across the six kinds.

Your job is to make the engine cheaper without making it wrong.

How it is scored:

- Each query kind is scored on its own, from the shipped cost down to one pass
  over the table, on a log scale. Fixing one kind of six is worth about a
  sixth of the mark, whichever kind it is.
- Correctness gates everything. A kind with a single wrong answer scores zero
  for speed no matter what it costs, and wrong answers scale the whole result
  down.
- You are scored on a second dataset you have not seen, with a different size
  and a different seed. An engine that remembers answers rather than computing
  them scores nothing.
- Six kinds is more than the time holds. Partial work counts in full.

Only `src/engine.mjs` and `notes/` are yours. `src/data.mjs`, `src/workloads.mjs`
and the bench itself are fixed.
