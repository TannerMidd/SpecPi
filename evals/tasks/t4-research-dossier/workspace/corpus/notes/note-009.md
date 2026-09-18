# note-009 — Telemetry: western relay

Id: note-009
Status: active

The western relay path emits `western_relay_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
