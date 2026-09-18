# note-015 — Telemetry: outer warden

Id: note-015
Status: active

The outer warden path emits `outer_warden_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
