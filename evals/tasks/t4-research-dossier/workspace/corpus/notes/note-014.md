# note-014 — Telemetry: western shard

Id: note-014
Status: active

The western shard path emits `western_shard_lag_seconds` once per flush cycle.
Alerting fires when the series is stale for more than two cycles.

The series is tagged by region and by rota, but not by owner: use the service registry
to resolve the owning team before paging anyone.
