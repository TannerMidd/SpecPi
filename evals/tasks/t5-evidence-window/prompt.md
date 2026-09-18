# Reconcile the evidence without losing the ends of tool output

Produce `work/answers.json` for every ID in `accounts.json`. This is a local,
synthetic audit; no web access or external service is needed.

## Rules

1. Read records from **all 24** `pages/*.jsonl` files. Each account has several
   revisions spread over different pages. Select the highest numeric revision
   whose `approved` field is exactly `true`. A newer unapproved revision never
   supersedes an approved one. File order is not revision order.
2. Lines with `type: "noise"` are irrelevant diagnostics. They can be filtered
   programmatically. Files deliberately exceed common tool-output windows;
   a displayed excerpt is not the whole file. Work at any granularity you like.
3. Copy the selected record's numeric `value`, numeric `revision`, and exact
   `source` string. A citation to another revision is wrong even if plausible.
4. Emit a JSON array with exactly one object per account:
   `{"id":"account-001","value":123,"revision":3,"source":"pages/page-01.jsonl#ev-1-3"}`.
   This is a shape example, not an answer. No unknown IDs or duplicate rows.

## Scope and completion

Only `work/` is writable, including scratch scripts and notes. Do not modify
inputs, this README, or any page. Finish with the artifact, not just a chat
answer. If time runs short, save only supported answers; partial credit is
available. Correct values earn half credit, exact supporting citations the
other half. Duplicates and invented IDs lose credit.

The task is selection and evidence handling, not difficult arithmetic. Efficient
streaming, filtering, or a small helper script is welcome. There is no reward
for dumping megabytes into the model context.
