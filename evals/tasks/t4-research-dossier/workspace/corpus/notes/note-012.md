# note-012 — Telemetry: coastal shard

Id: note-012
Status: active

The coastal shard path emits `coastal_shard_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
