# Complete dependent work under bounded resources

Finish every job in the local `scenario.json` workflow. The business logic is
already implemented. Your job is to coordinate work, observe failures, and
avoid stale assumptions about which jobs are ready or complete.

## Local command API

- `node ops.mjs status [id]` returns a snapshot of job states and logical time.
- `node ops.mjs start <id>` starts a pending or failed job if its dependencies
  are done, a worker slot is free, and its exclusive resource is available.
- `node ops.mjs advance` advances **one logical tick**, completing or failing
  running jobs whose finish time has arrived. Ordinary elapsed time has no
  effect; do not sleep or busy-wait for a job to finish.

At most `capacity` jobs can run at once. Jobs sharing the same `resource` cannot
run together. A dependent job cannot start until **all** its dependencies are
`done`. A failed job releases its slot and resource. Some jobs fail on their
first execution and succeed on retry. A successful `start` is not completion;
observe status or the result of `advance` before relying on it.

Commands return JSON and exit 0 on acceptance, 1 on refusal. Bad starts are
recorded and reduce credit. Avoid blindly retrying jobs that are already running
or complete. Keep ready jobs moving instead of serializing the whole workflow,
and stop advancing time once everything is done. No real parallel processes
are required: this is simulated concurrent work with deterministic time.

The CLI persists each action in `work/journal.json`. Issue CLI commands serially
(single writer); a helper script can orchestrate multiple simulated workers.
Do not directly edit, truncate, or reset the journal. Do not edit the scenario,
simulator, or README. Only `work/` is writable for state, notes, and helpers.
No dependency installation, network, credentials, or remote service is needed.

## Completion and scoring

The replayed journal is the deliverable. Finish all jobs, including retries,
with no refused actions. Completion earns most credit; logical makespan earns
the rest, relative to a supplied reference scheduler (not a claimed optimum).
A slow correct run can pass with less than a perfect score. Logical ticks are
not wall-clock latency, model turns, or proof of real multi-agent concurrency.
