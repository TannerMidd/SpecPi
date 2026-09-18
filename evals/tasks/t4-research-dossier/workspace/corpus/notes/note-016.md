# note-016 — Telemetry: inner sweeper

Id: note-016
Status: active

The inner sweeper path emits `inner_sweeper_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
