# Migrating ledger-central-38

Apply all of the following to every file under `config/` in this package, and
to no other package. Keep every key not mentioned here exactly as it is, keep
the file valid JSON with two-space indentation, and keep the trailing newline.

- Set `schemaVersion` to `2`.
- Add `"converted": true`.
- Clamp `retries` to at most 5; leave smaller values alone.

These rules are this package's own. Another package's `MIGRATION.md` says
something different, and applying one package's rules to another is a failed
migration, not a partial one.
