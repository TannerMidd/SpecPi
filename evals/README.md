# Eval suite

Compare harnesses on the same tasks, model, and price list: context usage,
price per task, success rate, and tool calls.

## Quick start (offline, $0)

```sh
node scripts/eval-run.mjs --list
node scripts/eval-run.mjs --dry-run --harness=fake,failing-fake --tier=1
node scripts/eval-run.mjs --harness=fake,failing-fake --tier=1 --attempts=1 --out=.specpi-test/eval-demo
```

The default run uses two built-in harnesses:

- `fake` runs each task's reference solution (`solve.mjs`). It should pass
  everything. If it does not, the checker is broken, not the harness.
- `failing-fake` does nothing. It should fail everything. If it passes, the
  checker is too lax.

No network, no API key, no live Pi directory. Every attempt gets a
disposable home and workspace under the OS temp dir.

The same two harnesses are how a new task is proved: `fake` must score 1.0 on
it and `failing-fake` must score near zero. The whole ultimate tier runs both
ways offline in about fifteen seconds:

```sh
node scripts/eval-run.mjs --harness=fake,failing-fake --tier=4 --out=.specpi-test/eval-t4
```

## Suggested models (via OpenCode)

Tier 2 is priced and mapped for two models, both runnable right now through
the installed OpenCode credential (`opencode-go` provider):

- `deepseek-v4.1-flash` — DeepSeek V4.1 Flash. The cheap workhorse:
  about $0.15 / $0.60 per MTok in/out. Start here.
- `muse-spark-1.3-contributor` — Muse Spark 1.3 contributor tier.
  About $0.10 / $0.20 per MTok in/out.
- `muse-spark-1.3` — the full Muse Spark 1.3 ($1.25 / $4.25 per MTok).
  Needs extra credentials (see below); the runner accepts it as soon as
  its provider-qualified id is reachable.

```sh
# Cheap first pass: DeepSeek V4.1 Flash on the full Tier 2 suite
node scripts/eval-run.mjs --harness=opencode --tier=2 --model=deepseek-v4.1-flash --attempts=3 --out=evals/runs/deepseek-v4.1-flash

# Second opinion: Muse Spark 1.3 contributor tier, same tasks
node scripts/eval-run.mjs --harness=opencode --tier=2 --model=muse-spark-1.3-contributor --attempts=3 --out=evals/runs/spark-1.3-contributor
```

Expect roughly $0.001–0.002 per attempt on these models, so a full
Tier-2 cell (8 tasks x 3 attempts) lands under $0.05.

### Charting runs

```sh
node scripts/eval-chart.mjs --out=evals/runs/compare-2026-09-18 \
  evals/runs/deepseek-v4.1-flash/report.json \
  evals/runs/spark-1.3-contributor/report.json
```

This writes `SUMMARY.md` (cross-model table plus the per-run detail)
and three charts into the output directory:

- `chart-solve.svg` — solve rate by task category and overall
- `chart-cost.svg` — mean frozen cost per attempt, failures included
- `chart-context.svg` — mean first-step input tokens (proxy harnesses
  are estimated at chars ÷ 4 and labelled as estimates)

Counts stay on every bar so a headline never hides its denominator.

### The Jev row on its own

The advisor changes often enough that re-running seven harnesses to see what one
of them did is waste. `specpi-jev` runs alone on the protocol the published
matrix used — two attempts per cell on tiers 1 to 3 with each task's own budget,
one attempt on tiers 4 and 5 with the caps below:

```sh
for tier in 1 2 3; do
  node scripts/eval-run.mjs --env-file=evals/.env --harness=specpi-jev --tier=$tier \
    --model=deepseek-v4.1-flash --attempts=2 --out=evals/runs/jev-calibrated-tier$tier
done
node scripts/eval-run.mjs --env-file=evals/.env --harness=specpi-jev --tier=4 \
  --model=deepseek-v4.1-flash --attempts=1 --timeout=600 --out=evals/runs/jev-calibrated-tier4
node scripts/eval-run.mjs --env-file=evals/.env --harness=specpi-jev --tier=5 \
  --model=deepseek-v4.1-flash --attempts=1 --timeout=900 --out=evals/runs/jev-calibrated-tier5
```

Then compare, against the plain-SpecPi row from the published matrix and,
optionally, against an earlier set of Jev runs:

```sh
node scripts/jev-effect.mjs \
  --jev=evals/runs/jev-calibrated-tier1/report.json,evals/runs/jev-calibrated-tier2/report.json,evals/runs/jev-calibrated-tier3/report.json,evals/runs/jev-calibrated-tier4/report.json,evals/runs/jev-calibrated-tier5/report.json \
  --baseline=evals/runs/full-tier1/report.json,evals/runs/full-tier2/report.json,evals/runs/full-tier3/report.json,evals/runs/full-tier4/report.json,evals/runs/full-tier5/report.json
```

It prints the comparison from the same aggregates the evaluations page is built
from, so the two cannot disagree, plus the advisor's own ledger: per system, how
many calls were made, how many changed anything, and why the rest did not.

Read the control honestly. Running one harness alone means its column and the
plain-SpecPi column come from different sittings, so anything that moved between
them — the model's own drift most of all — lands on the layer. The published
matrix is one sitting precisely because that is not true of it; a single-harness
re-run is evidence about the layer's own behaviour, and weaker evidence about
the difference it makes.

### One image with everything

```sh
node scripts/eval-dashboard.mjs --out=evals/runs/all-results.svg \
  evals/runs/all-tier1-deepseek/report.json \
  evals/runs/tier2-*/report.json evals/runs/tier3-*/report.json
```

A single self-contained SVG: combined series table plus every tier's
solve, cost, and context charts. Opens in any browser; no build step.

### Credentials: one key for every harness

All harnesses run on the same OpenCode Go subscription with DeepSeek V4.1
Flash. OpenCode uses its own auth and needs nothing. The Pi family reaches
the same subscription through the logging proxy, which forwards to the
OpenCode Go endpoint with your key. Codex CLI reaches it the same way, but
its proxy leg is the Responses API; set `EVAL_FORWARD_RESPONSES_URL` only
when the provider's responses endpoint is not `EVAL_FORWARD_URL` with
`chat/completions` swapped for `responses`:

## Real-model runs (other harnesses)

```sh
# One-time setup: copy the template and paste your OpenCode Go API key.
cp evals/.env.example evals/.env

# Pi stock vs SpecPi default vs OpenCode, all on DeepSeek V4.1 Flash.
node scripts/eval-run.mjs --env-file=evals/.env --harness=pi,specpi-default,opencode --tier=2 --model=deepseek-v4.1-flash --attempts=3 --out=evals/runs/all-harnesses

# Add the installed Codex CLI to the same comparison.
node scripts/eval-run.mjs --env-file=evals/.env --harness=pi,specpi-default,opencode,codex --tier=2 --model=deepseek-v4.1-flash --attempts=3 --out=evals/runs/all-harnesses
```

`evals/.env` is git-ignored; keys never leave the machine. The key travels
process-local only: read at forward time, never written to the request log
or `report.json`. `EVAL_FORWARD_MODEL` rewrites the proxied model id to the
provider's own naming while the frozen list keeps the short logical id for
pricing. A provider-qualified `--model` (anything containing a `/`) is
passed through untouched.

Note: `--model` is a logical id priced from `evals/prices.json`. The Pi
family sends it to the logging proxy (forwarded when `EVAL_FORWARD_URL`
is set); OpenCode maps it to its provider-qualified id.

Live harnesses:

- `pi`, `specpi-default`: pinned Pi CLI in `node_modules`. `specpi-default`
  installs the seven pinned packages into a per-batch cache, copied per
  attempt. Approval dialogs cannot be answered headless, so SpecPi runs set
  the permission package's explicit `yoloMode` opt-in inside the disposable
  home (disclosed in every report's method string); dialog counts stay
  visible in `rpcEvents`.
- `omp`: set `--omp=<path to cli.js>` or `SPECPI_OMP_CLI`.
- `opencode`: the installed binary (found via `SPECPI_OPENCODE_CLI` or PATH). Runs `opencode run` with ambient credentials, which OpenCode reads itself.
- `codex`: the installed Codex CLI (found via `SPECPI_CODEX_CLI` or PATH),
  run inside a disposable `CODEX_HOME` so the machine's own Codex config,
  sessions and credentials are untouched. Current Codex reads only the
  Responses API from a custom provider, so the proxy accepts that path and
  forwards it to the provider's responses endpoint
  (`EVAL_FORWARD_RESPONSES_URL`, defaulting to `EVAL_FORWARD_URL` with
  `chat/completions` swapped for `responses`). Codex's own sandbox rejects
  every command on Windows, so Codex runs use its full-access sandbox mode
  inside the attempt's disposable workspace; the method string discloses it,
  as it does for the SpecPi permission opt-in. Model ids are sent through
  unchanged, except that an `opencode-go/<id>` qualifier is reduced to the
  provider's own id.
- `claude-code`: the installed Claude Code CLI (found via `SPECPI_CLAUDE_CLI`
  or PATH), run headless with `--print --output-format stream-json` inside a
  disposable `CLAUDE_CONFIG_DIR`. It is the only harness that speaks the
  Anthropic Messages API, so the proxy accepts `/v1/messages` and translates
  it: the request becomes a chat-completions request *before* anything is
  recorded, and the provider's reply is converted back on the way out. Every
  accounting path therefore reads the one shape it has always read
  (`scripts/eval-anthropic.mjs`, covered by `tests/eval-anthropic.test.mjs`).
  Approval prompts cannot be answered headless, so runs pass
  `--dangerously-skip-permissions`, disclosed the same way as the SpecPi
  `yoloMode` opt-in.

  **No Anthropic credential is read or spent.** The disposable config
  directory holds no stored login to fall back on, `ANTHROPIC_BASE_URL` points
  at the proxy, and the proxy discards the client's token and sends
  `EVAL_FORWARD_KEY` upstream. Runs bill the same OpenCode Go subscription as
  every other harness.

  Claude Code exposes no context-window setting, so it cannot be held to a
  tier's declared window and tier 6 reads its attempts as unwindowed, the way
  it did for Codex and OpenCode before those learned to read one.
- `dsh`: set `SPECPI_DSH_CLI` to the installed bin. Routes through the
  logging proxy via a home-level patch layer, like the other proxy harnesses.

See `scripts/measure-context.mjs` for the isolation each foreign harness
needs (XDG redirects, `DSH_HOME`, title-call suppression). The eval proxy
plays the same role as that script's synthetic provider, plus usage logging
when `EVAL_FORWARD_URL` is set.

## Tiers

- **Tier 1** (4 tasks): synthetic smoke tests. Fast, deterministic, offline.
- **Tier 2** (8 tasks): the real-model mini-suite across terminal, repair,
  scoped and multi-step categories. Small enough to run on every change.
- **Tier 3** (1 task): the long-horizon repair chain. 30-minute budget,
  600-turn cap.
- **Tier 4** (5 tasks): the ultimate tier. 45-minute budget, 900-turn cap,
  one injected fault each. Described below.
- **Tier 5** (6 tasks): harness-stress experiments covering output windows,
  untrusted instructions, scoped dirty-state edits, checkpoint recovery,
  ambiguous commits, and resource-limited scheduling. 30-minute budget and a
  documentary 600-turn target. See [Tier 5 tasks and analysis plan](TIER5.md)
  for exact scoring, extractable data, controls, and instrumentation limits.
- **Tier 6** (long sessions): tasks that declare a `contextWindow` so a
  harness must compact to finish. Pi-family harnesses get compaction settings
  that fit the window (`windowedCompaction` in `scripts/eval-harnesses.mjs`):
  Pi's defaults compact at 7,616 tokens of a 24,000 window and try to keep
  20,000, so earlier tier 6 runs compacted almost every turn. Runs recorded
  before this setting are not comparable with later ones.

Three earlier attempts at a hard tier all saturated, and their tasks are kept
in `evals/archive/` rather than deleted, because why they saturated is the
design brief for what replaced them. Every one of them was finishable: the
work fitted in a single pass, so a harness either did it or did not, and the
solve column collapsed to 100%. Across 168 attempts spanning four tiers the
suite produced **two** failures.

Report the subgroup split, not just the aggregate: a harness can lead on
terminal work and trail on repository repair, and the mixture decides the
headline.

### Tier 4 — the ultimate tier

The organising rule is that **no task can be finished**. Each offers more
verifiable work than its budget holds, and each is scored on how much of that
work landed. That makes the headline figure a rate — work per dollar, work per
turn, work per thousand tokens — which is a harness property and cannot
saturate the way a boolean does.

- `t4-browser-triage` (multi) — fifty widgets across ten routes in a real web
  application, forty of them defective, driven through `webqa`: a hermetic
  browser with a real DOM, real event dispatch and real page scripts, with the
  clock, the timers and the network made deterministic. Every widget carries
  its own acceptance criterion in the page, so a defect is a fact rather than
  an opinion. Credit is 40% for naming a defect and 60% for quoting what the
  browser printed, and reporting one of the ten correct widgets costs a whole
  defect. Listing all fifty scores 0.15.
- `t4-research-dossier` (terminal) — 1,675 documents, about 2 MB, and a bank
  of 45 questions that each need two to four of them. Policy documents name
  services only by codename and the registry is what maps one to the other, so
  nothing is a single lookup. Superseded policies stay in the corpus and are
  repeated in archived drafts, so ranked search usually hands back the stale
  value first. Answers score 0.75, citations the other 0.25, and a citation
  only counts when the answer is right.
- `t4-cost-ladder` (repair) — a query engine that is correct and slow. The
  only cost counted is `table.row()` calls, which is a property of the
  algorithm rather than of the machine, so the figure is identical in CI and
  on a laptop. Each of six query kinds is scored on its own log-scaled ladder
  from the shipped cost down to one pass over the data, so fixing one kind is
  worth about a sixth whichever kind it is. Scored on a dataset the engine has
  never seen, so an engine that remembers answers scores nothing.
- `t4-scope-monorepo` (scoped) — eighty packages, 976 config files, and no
  single file that says which are ours: ownership is a join across `OWNERS`,
  the registry, a transfer log that contradicts `OWNERS` in both directions,
  and a freeze log naming packages that are ours and must still not be
  touched. Each owned package carries its own `MIGRATION.md` with its own
  target schema version, so a global rewrite is wrong everywhere at once.
  Completeness and restraint multiply: a sweep scores zero.
- `t4-incident-loop` (multi) — a 24-service cluster mid-incident, driven
  through `ops`, a state machine where actions are refused unless the service
  is drained and refusals are recorded. Recovery runs in dependency order,
  three services fail on an expired certificate rather than an exhausted pool,
  and two are stateful: restarting one destroys it permanently, and the
  runbook says so. Scored on what is serving at the end, scaled by how much
  backlog it took to get there.

Four design rules hold across all five, and each closes a shortcut that
saturated an earlier tier:

1. **Evidence, not inference.** Where a task can be reasoned about from
   source, the larger share of the credit is for output the fixture actually
   produced. Reading names the defect; running proves it.
2. **A cost for being wrong.** Every task has decoys — correct widgets,
   upstream packages, stale-but-real documents, a service that must not be
   restarted — and reporting or touching one costs more than leaving it out.
   Shotgunning scores worse than a short careful list.
3. **Graded, not boolean.** Scores are continuous and every breakdown reports
   its denominator, so twelve of forty is a number rather than a failure.
4. **Answers derived, never asserted.** Every answer key is produced by
   running the fixture, not by writing down what it ought to do. The browser
   generator builds a second, entirely correct copy of the application and
   fails if any "defect" behaves identically to its own fixed version — which
   caught a tax bug that rounded to the same cent as the correct formula, a
   defect that was not one.

Every tier 4 task also injects a transient fault into the command it depends
on. The fault clears on its own, so a harness that retries finishes and one
that gives up does not, and `faults` in the report says what each one actually
met rather than what was intended.

### Tier 4 budgets

45 minutes and a 900-turn cap per attempt, so a full sweep is expensive: five
tasks across six harnesses at three attempts is 90 attempts and up to 67 hours
of wall clock if every one runs to its limit. Run one task across harnesses
before running the tier, and use `--timeout` to shorten a scouting pass.

`turnCap` is documentary. The runner enforces `timeoutMs`; nothing reads
`turnCap`, and the figure records the intended shape of the task rather than a
limit the harness meets.

## Adding a task

Create `evals/tasks/<id>/` with:

- `task.json`: `{ id, tier: 1|2|3|4|5, category, title, timeoutMs, turnCap, writable }`
  where `writable` lists the paths a correct solution may change, plus an
  optional `faults` list naming commands to make transiently unreliable, and an
  optional `effort` block (see **Reading score and scope**). Leave `effort` out
  until a real harness has passed the task, because its reference is a
  demonstrated floor rather than an estimate
- `prompt.md`: the exact prompt the harness receives
- `workspace/`: starting files (may be empty)
- `check.mjs`: `export default async (workspaceDir) => ({ pass, score, notes })`
  where `score` is optional and between 0 and 1
- `solve.mjs`: reference solution for the fake harness and checker validation

Checkers use Node builtins only, so they run on Windows, macOS, and Linux.
Keep Tier 1 and 2 tasks under 2 minutes and 50 turns. Tier 3 gets 30 minutes,
Tier 4 gets 45, and Tier 5 defaults to 30. Tier 5 pilots should start with
`--timeout=300` before committing to a full matrix. All turn caps are documentary;
only the time budget is currently enforced.

A Tier 4 task also needs a `generate.mjs` that writes the fixture and derives
the key by running it, and the generator should fail loudly when the fixture
stops measuring what it claims to: a defect that behaves like its own fix, two
packages with identical rules, a ladder with no room on it. Those checks have
each already caught a real bug in this suite.

Two rules the suite enforces for you, in `tests/eval-tasks.test.mjs`:

- the reference solution must pass its own checker, and the checker must
  fail on the untouched workspace — otherwise the task measures nothing
- a Tier 3 checker must reject edits to the files it judges against, which
  it does by comparing a hash with line endings normalized

If a checker spawns `node --test`, strip `NODE_TEST_CONTEXT` from the child's
environment. Inherited, it makes the nested runner report to the outer one and
exit 0 with failing cases, which silently passes a broken workspace.

## Reading costs

Each attempt carries three cost fields, and the split is the point:

- `modelCost` — the harness's own model spend. **This is the comparable
  figure**, and the one the tables and charts call cost per attempt.
- `mintCost` — eval plumbing. Forwarded proxy traffic needs a live
  OpenCode session id, so each proxy attempt mints one with a throwaway
  OpenCode turn. That turn carries OpenCode's own system prompt and tool
  schema, and only proxy harnesses need it, so charging it to the harness
  bills the Pi family for OpenCode's context.
- `cost` — their sum, kept so the real spend is auditable.

Alongside those:

- mean cost per attempt (total ÷ attempts)
- cost per success (total ÷ successes)
- success-conditioned cost is included but flagged as flattering
- unknown models are lower bounds (`costComplete: false`, rendered `≥ $x`),
  as are cache writes on a model whose entry declares no `cacheWritePerMTok`

Costs come from logged usage × `evals/prices.json`. They never come from
harness self-reports. `scripts/eval-prices.mjs` owns every rule about which
tokens cost what:

- proxy `prompt_tokens` arrive inclusive of cache rereads, so only the
  fresh portion carries the input price
- reasoning tokens bill at the output rate, and harnesses that report them
  apart (OpenCode) exclude them from `outputTokens`; OpenAI-style
  `completion_tokens` already include them, so the proxy path adds nothing

The renderers reprice stored attempts through that same function, so an
archived `report.json` is read under the current rules and a pricing fix
never requires rewriting a run artifact.

## Reading score and scope

Solve rate saturates. Across 168 attempts spanning four tiers the suite
produced **two** failures, both on one Tier 1 task, so the boolean verdict
carried almost no information about the harnesses. Two measurements sit
beside it, and both are harness properties rather than model ones.

**Score** is how much of a task landed. Checkers may return
`{ pass, score, breakdown, notes }` with `score` between 0 and 1; a checker
that reports no score falls back to its own verdict, so every task stays
valid. Partial credit is what gives resolution once everything passes.

**Effort** is what the harness spent to get there, and on tiers 1 to 3 it is
part of the score. Those tasks are small enough that correctness is honestly
binary -- across 182 recorded attempts every score was exactly 0 or 1, and 9 of
the 14 failures were one harness with disclosed platform problems, so thirteen
tasks produced roughly one bit between them. Partial credit cannot rescue a
two-line deliverable. What did vary, at identical results on identical tasks,
was the work taken: 2 tool calls against 9 on `t1-fix-script`, 3 against 12 on
`t2-multi-rename`. That is a harness property, and it was being discarded.

So a task may declare an effort reference in `task.json`:

```json
"effort": { "referenceCalls": 2, "weight": 0.5, "demonstratedBy": "opencode, pi" }
```

and the runner scores the attempt as
`correctness x (1 - weight + weight x min(1, referenceCalls / toolCalls))`.
Four rules keep that honest:

- correctness **multiplies**, so a wrong answer scores zero however cheap it
  was. Being fast and wrong is not partial credit.
- the reference is the fewest tool calls a real harness actually used on a
  **passing** attempt, named in `demonstratedBy`. It is not derived from
  `solve.mjs`: reference solutions hardcode their answers, so `t2-repair-json`
  writes the repaired file without reading it, and a floor derived from that
  would punish every agent that honestly inspects its input.
- beating the reference caps at 1.0, so a better harness arriving later never
  retroactively lowers anyone else's recorded score.
- a harness that reports no tool calls is **unmeasured**, not perfect. It falls
  back to bare correctness and the breakdown says why.

Because the reference is the best result in this field rather than a theoretical
minimum, the effort term measures distance from the best demonstrated here. A
harness that set many of the floors will sit near 1.0 partly by construction;
read it as relative, and report `demonstratedBy` alongside any ranking.

The checker never sees tool calls, so it still returns correctness alone and the
`fake` = 1.0 / `failing-fake` = 0.0 contract is untouched. The composite is
formed by the runner and recomputed from stored attempts by `attemptScore`, the
same way `priceAttempt` reprices stored usage -- so a scoring change never
requires rewriting a run artifact, and an archived report is read under current
rules.


Scope was `clean` on all 182 recorded tier 1-3 attempts, which said nothing
about restraint: most of those workspaces held only the file being worked on,
so there was nothing to overreach into. Every tier 1 and 2 task now ships a
decoy -- a neighbour carrying the same class of defect as the in-scope file:
`multiply.js` divides beside an `add.js` that subtracts, `data.backup.json`
repeats the corruption in `data.json`, `test.js` still calls the name the task
asks you to rename away. The prompts are unchanged and **do not mention them**.

That is deliberate. `t1-no-touch` and `t2-scoped-edit` name their forbidden file
in the prompt, which tests instruction-following; the decoys test whether a
harness confines itself to the task it was given when something adjacent looks
broken, which is the property scope control actually claims. Reference solutions
ignore them, and `tests/eval-tasks.test.mjs` asserts that every task declares a
scope its own reference solution respects.

Scope results recorded before this change predate the decoys and are not
comparable with later ones: every one of those attempts faced an empty
neighbourhood.

**Scope** is whether the harness changed only what it was allowed to change.
Every `task.json` declares `writable`: the paths a correct solution touches.
The runner fingerprints the workspace by content hash before and after, and
reports each create, modify or delete outside that list. Content hashes, not
names and sizes — a harness that rewrites a file it was told to leave alone
usually leaves the size identical.

Scope is scored on every task, not only the ones about restraint, and it is
independent of correctness: an attempt can solve the task and still be out of
scope. That matters because restraint is the only dimension that has ever
separated these harnesses — the two failures above were a _scoped_ task, and
the harness that failed them makes about 40% more tool calls than the
cheapest one for identical results.

Allowlists are derived from what each reference solution actually touches,
never guessed, and `tests/eval-tasks.test.mjs` asserts that every task
declares a scope its own reference solution respects. Otherwise the metric
would punish correct work.

Runs recorded before these fields existed report scope as `—`.

## Reading tool counts

Calls and offers are different measurements and are reported separately:

- **tool calls** are what the model invoked, read from the response
- **tools offered** are what each request's schema carried — prompt weight
  paid every turn whether the model reaches for the tool or not

A harness offering ten tools on every request shows ten large offer counts
and, usually, far fewer calls. Runs recorded before invoked-tool logging
existed report their calls as `not measured` rather than reprinting the
offer counts under the wrong label.

## Publishing to the site

The GitHub Pages site carries an [evaluations page](../site/evaluations/). It
no longer publishes this suite. The tiers below could not separate the
harnesses they were built to separate -- nearly everything passed -- so the
page carries [Terminal-Bench 2.0](https://www.tbench.ai/) instead, and this
suite stays here as the local instrument it always was:

```bash
node scripts/tb2-metrics.mjs          # reads the Terminal-Bench runs
node scripts/tb2-site.mjs             # redraws the page and the root README
```

One command writes `site/evaluations/terminal-bench-2.json` and redraws every
figure on the page, so a chart cannot disagree with the table beside it. The
page's prose reads its own quoted numbers back out of that JSON at load time,
which means a regenerated run updates the sentences too rather than leaving
them asserting figures no bar supports.

After a new run, regenerate and then run `npm run check:site`, which fails if
a chart slot is empty, a quoted figure went unfilled, or the page overflows at
phone width. The Terminal-Bench runs themselves are deliberately not in this
repository, because the task content carries canary strings; only aggregates
and public task names cross into the data file.

Two harness properties are deliberately absent for native harnesses such as
OpenCode: tool-schema characters and offered-tool counts. Those are read from
the proxy, which a native harness never crosses. They are drawn as gaps rather
than zeros.
