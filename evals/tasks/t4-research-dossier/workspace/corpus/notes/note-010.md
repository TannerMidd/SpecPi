# note-010 — Telemetry: lower digest

Id: note-010
Status: active

The lower digest path emits `lower_digest_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
