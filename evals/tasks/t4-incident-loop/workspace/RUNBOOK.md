# Incident runbook

A deploy went out across the whole cluster and was rolled back at the edge but
not in the services. Every service is running code it has not restarted into,
so nothing is serving until it is brought back deliberately.

## Bringing a stateless service back

1. `ops drain <service>` — take it out of rotation. Nothing else is
   permitted while a service is in rotation.
2. Clear its fault, if it has one:
   - **pool exhausted** — `ops set <service> poolSize 32`.
     Anything below 16 will exhaust again on restart.
   - **certificate expired** — `ops rotate-cert <service>`. The pool fix does
     nothing for this and a restart will fail again.
3. `ops restart <service>` — it will refuse if the service is still in
   rotation, still faulty, or depends on something that is not yet serving.
4. `ops undrain <service>` — back into rotation. Returning a service that
   cannot serve is flapping, and it is recorded.

## Bringing a stateful service back

**Do not restart a stateful service.** A restart discards everything it has
not replicated, and there is no procedure that recovers it. Use:

1. `ops drain <service>`
2. `ops failover <service>` — promotes the replica and clears the lag
3. `ops undrain <service>`

`ops show <service>` reports whether a service is stateful. So does
`ops status`.

## Order

A service cannot come back before everything it depends on is serving.
`ops deps <service>` reports both directions. `ops verify` names the first
service in dependency order that is not serving yet.

## What is counted

Refusals and flaps accrue a backlog. The cluster is judged on how much of it
is serving at the end and on how much backlog it took to get there.
