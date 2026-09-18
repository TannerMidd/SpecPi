Read RUNBOOK.md, then run `ops status`.

A deploy went out across the whole cluster and was rolled back at the edge but
not in the services. Nothing is serving. Bring the cluster back.

`ops` with no arguments lists the commands. `ops verify` tells you how many
services are serving and names the first one in dependency order that is not.

Three things the runbook says, which are worth taking seriously:

- Almost every action is refused unless the service is drained first, and a
  refusal is recorded against you.
- Not every failure has the same cause. Some services are out of pool and
  some have an expired certificate, and the fix for one does nothing for the
  other.
- Two services are stateful. Restarting one destroys it, permanently, and no
  later command brings it back. `ops show` and `ops status` both say which.

A service cannot come back before the services it depends on, so the order is
the dependency order.

How it is scored: mostly on how much of the cluster is serving at the end, and
partly on how much backlog it took — refusals and flaps both count, and a
destroyed service costs five. Bringing back half the cluster cleanly scores
well; there is more here than the time holds, and partial work counts in full.

`cluster.json`, `RUNBOOK.md` and `ops` itself are fixed. Everything else in
the workspace is yours, including `notes/` and any scratch files you want.
