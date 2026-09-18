# note-011 — Telemetry: outer sweeper

Id: note-011
Status: active

The outer sweeper path emits `outer_sweeper_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
