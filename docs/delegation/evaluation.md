# Delegation evaluation and implementation gates

This is an experiment specification, not a report of comparative outcomes. The
[experimental implementation](README.md) uses Pi AgentSession workers under the
[bounded session protocol](protocol.md). Runtime, broker, lifecycle and synthetic-provider
fixtures require a fresh run against this SDK integration before they support a passing
contract claim. Tests do not establish better task quality, cost or latency, or parity
with every live provider. No comparative outcome experiment is reported here. The numeric criteria
below remain proposed hypotheses, not research-derived constants or achieved results.

The [archived architecture](design.md) and [target protocol](design-protocol.md) retain
stronger proof obligations. In particular, full parent request-pipeline parity,
midstream/raw-transport bounds, admission of every underlying provider attempt and
monetary admission remain unmet by the native `bounded-pi-sessions-v1` contract.

## 1. Decide what improvement means before a run

Choose one primary objective for each cohort: quality, cost, or time. Set the quality
floor, resource envelope, allowed model routes, acceptance rubric and stop rules before
looking at outcomes. A route must not claim success by changing its objective afterward.

Acceptance is task-specific and independently adjudicated. For code, use hidden or
held-out behavior checks, appropriate regression tests, and human review of the diff.
For research, use verified factual coverage, source quality, citations, and material
omissions. For review, use confirmed defects, false positives and reviewer-induced
regressions. A worker's `complete` declaration or a host receipt is never the target metric.

Use versioned public or sanitized fixtures. Keep evaluation data separate from private
Pi sessions and user repositories unless a human explicitly provides those materials
for this purpose. No automatic collection from ordinary conversations.

## 2. Baselines and comparisons

| Arm                                                     | Purpose                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A: capable single agent with current workflow           | Establish the useful baseline                                                   |
| B: the same agent with the same total additional budget | Distinguish delegation from simply buying more reasoning or another review pass |
| C: structured serial workflow, same execution context   | Test workflow structure without separate identities                             |
| D: selective one- or two-worker delegation              | Test the experimental implementation                                            |
| E: always-delegate policy                               | Measure routing value and unnecessary overhead; evaluation only                 |
| F: approved sequential model routing                    | Separate model-selection benefit from child-context benefit                     |

Do not run all six arms on every case before establishing which question matters.
For stage 1, A/B/D on frozen reviews is sufficient. Add C/E for investigation and F
only when alternative models are authorized. Use the same exact provider/model version
and tools where the comparison calls for it. A mixed-model arm must disclose composition.

Start with the implemented `review` and `scout` purposes, not all archived profiles.
Compare frozen review against both normal parent review and an additional parent pass
under the same total envelope. Include clean changes so false positives carry a cost.
For scouts, compare parent-only and structured serial analysis before attributing gains
to fresh context or parallelism. Evaluate one versus two workers only when independent
source partitions justify that question.

Record the parent's and child's effective thinking settings and model clamping. The
child uses a fresh standard Pi ModelRuntime; parent hooks and ephemeral settings are
not inherited. Control these differences when isolating architecture, or disclose them
as part of an end-to-end workflow comparison. Same model IDs alone do not establish
equal inference configuration.

Use total task spending, not only worker spending. Include preparation, parent reasoning,
worker requests, tools, retries, synthesis and validation. When actual dollar cost is
unavailable, label the cohort as call/token/latency constrained and do not describe it
as dollar-matched. Give the parent sufficient remaining budget to consume and check a
result; a worker that spends the whole allowance before integration has not succeeded.

Match maximum resource envelopes and report actual use in both arms. Equal ceilings
do not imply equal spending. Run latency comparisons separately from quality/cost
comparisons because provider load and concurrency can change latency.

## 3. Task strata

Use at least these separately reported classes:

- Small understood edits and short lookups, where delegation should usually be rejected.
- Coupled changes with unsettled interfaces, where one writer should retain ownership.
- Independent repository investigations, including contradictory hypotheses.
- Large source collections with verifiable coverage requirements and repeated evidence.
- Frozen reviews with naturally occurring defects, seeded defects, and clean changes.
- Difficult decisions with sufficient context, plus missing-context cases that require abstention.
- Cancellation, stale source, prompt injection, bad decomposition and provider failure cases.

A pilot of 30–50 cases is for debugging the protocol and estimating variance, not
declaring a universal routing winner. Freeze policy after the pilot. Size a separate
holdout using the minimum useful effect, expected paired disagreement and cluster
variation. A target of 200 or more holdout cases can be a planning starting point;
it is not a power guarantee. Use repeated runs where stochastic variation is material.

Partition by repository or source family when possible so close variants do not leak
between tuning and evaluation. Randomize arm order, record service conditions, define
cold/warm cache handling, and use repeated time blocks to reduce infrastructure bias.
Cluster uncertainty by task/repository as appropriate. Include all admitted trials,
timeouts and failed attempts; do not condition the headline metric on successful jobs.

## 4. Required measurements

| Measure                | Definition or interpretation                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Accepted-task rate     | Accepted tasks / all attempted tasks, under the frozen rubric                               |
| Cost per accepted task | Sum of all task costs / accepted tasks; undefined if none pass                              |
| Resource use           | Input/output/cache/tool categories, calls, retries, unknown accounting and model identities |
| Elapsed time           | End-to-end p50/p95 plus uncertainty; separate provider wait, work and integration           |
| Review precision       | Confirmed material findings / all material findings presented                               |
| Review recall          | Confirmed detected defects / adjudicated defects in the evaluated fixtures                  |
| Human correction       | Time and actions needed to resolve findings and repair final output                         |
| Coverage               | Required questions or requirements supported by applicable evidence                         |
| Context failures       | Missing or distorted information that changed a conclusion or prevented acceptance          |
| Coordination overhead  | Preparation, repeated source work, messages, synthesis, invalidated jobs and integration    |
| Recovery               | Verified recoveries by fault class, including abandoned work and additional cost            |
| Routing errors         | Unnecessary delegation, missed useful delegation and unsupported model/capability requests  |
| Policy violations      | Denied capabilities attempted, actual escaped capabilities and stale result publication     |

Do not count a speculative finding as a caught bug. Separate naturally occurring and
seeded defects. Do not reward verbose output, agreement among agents, smaller packets,
clean merges, model confidence, or absence of exceptions as substitutes for acceptance.

## 5. Promotion rules

The user should choose the minimum useful change before a confirmatory run. Suggested
initial rules for discussion and pre-registration are:

| Objective | Candidate rule                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost      | At least 20% lower total cost per accepted task, with the lower one-sided 95% bound for the quality difference above a predeclared −2 percentage-point margin |
| Time      | At least 25% lower median end-to-end latency under the same resource ceiling and quality margin, without unacceptable p95 regression                          |
| Quality   | Positive paired improvement whose confidence interval excludes zero, under the fixed budget; no unacceptable increase in false positives or correction time   |

Report confidence intervals on the primary effect, not only on each arm's mean.
Use paired task-level analyses and clustered resampling where the sampling design
requires it. A low-powered non-significant difference is not evidence of equivalence.
If the holdout cannot resolve the chosen margin, keep the route experimental rather
than moving the threshold after the result. Correct for multiple confirmatory route
comparisons or specify one primary comparison and treat the rest as exploratory.

Any actual capability escape, credential exposure, invalid acceptance across a task
revision, or concealed cost accounting blocks promotion regardless of mean quality.
Zero observed escapes in fixtures does not prove universal containment; record the
enforced interface and residual trust assumptions.

Promote one task class and model route at a time. Pin the accepted policy version and
retain a parent-only fallback. A later model/provider/harness change invalidates an
assumption and requires appropriate reevaluation, not automatic inheritance of gains.

## 6. Targeted ablations

Run only the ablations needed to resolve a material decision:

1. Same-context self-review versus fresh-context review with identical requirements.
2. Same-model worker versus an authorized alternative, keeping context and tools fixed.
3. One versus two workers on genuinely independent source partitions.
4. Selected original context versus compressed context with original-source retrieval.
5. Explicit incomplete results versus forced answers under missing evidence.
6. One diagnosed retry versus blind replay on transient and semantic failures.
7. Parent verification versus unchecked worker summaries, inside test fixtures only.
8. Warm versus cold cache and single-provider versus allowed model switching.

This separates the value of context isolation, model capability, concurrency,
compression and validation. A gain from one must not be attributed to another.
Alternative models, compression, automatic retries and live-web research are not
implemented routes. Ablations requiring them need separate authorized fixtures or a
reviewed implementation; they are not options in the shipped model-facing tool.

## 7. Runtime compatibility and security fixtures

The implementation includes deterministic fake-provider and broker fixtures. Run the
relevant suites and record their actual results before live inference; this checklist
is not itself a passing receipt. The supported calls/time contract requires coverage for:

- Native Pi package discovery and actual SDK AgentSession creation on each allowed
  version, Pi 0.84.4 and 0.85.0, with in-memory sessions and rejection of other versions
  and unsupported routes. An allowlist entry or CLI version check is not suite completion.
- Explicit parent model/thinking with Pi clamping; fresh standard ModelRuntime
  configuration; configured global transport/thinking budgets without project settings;
  rejection of runtime-only authentication, selected extension-provider overrides,
  model-specific headers, startup proxy configuration and safe descriptor mismatches.
  Parent hooks, ephemeral runtime settings
  and session affinity are not implicitly inherited.
- No ambient child extensions, skills, AGENTS files or parent session history; the SDK
  owns the agent/tool loop, with only selected-source tools exposed.
- Review/scout mode and benefit compatibility, required evidence, assigned requirement
  subsets, duplicate-question rejection and parentWork required only for parallel claims.
- Normal Pi ownership of resource discovery, trust, proxy policy and authentication,
  without a separate SDK host or bootstrap override.
- Native and legacy provider composition using synthetic credentials only; no secrets
  returned to the extension, logged, or copied into packets.
- Errors represented as resolved terminal messages, setup failure and missing usage.
- Abort before admission, during provider setup, during inference and immediately before
  a broker operation; non-cooperative provider settlement and late output rejection.
- Concurrent call-slot accounting, duplicate submissions, aggregate counters and
  non-resetting follow-up limits; cancelled requests keep slots until settlement.
- Admission before every SDK model invocation, including tool continuations; provider
  and session retries and automatic compaction disabled; requested output clamped to
  the model maximum. Follow-up does not reset allowances.
- Pi-owned authentication preflight before model-invocation accounting, without
  claiming that the inference counter bounds authentication/OAuth preparation.
- Oversized SDK-visible streaming responses, bounded reports/tool output and correct
  settlement state. Hold slots through stream/result and prompt settlement; do not infer
  physical remote termination or a raw-response/allocation guarantee from SDK events.
- Lost collection responses, cursor replay, idempotent follow-up and resolution,
  stale result revisions, conflicting idempotency payloads and cancelled-job revival.
- Asynchronous job leases surviving normal `run` return without retaining stale
  extension contexts, and revocation at the intended task/policy boundaries.
- Complete versus partial tool calls, repeated IDs, unknown tools and schema tampering.
- Path traversal, encoded paths, symlinks/reparse points, private files, source changes,
  invalid line ranges and oversized input/output.
- Actual branch navigation versus ordinary leaf advancement; model, task, scope and
  policy changes during queued and active work; controller and aggregate quotas
  retained across reloads, session switches and off/on within the Pi process.
- Fixed canonical working root, with a Pi restart required for a new root or runtime
  version rather than loading changed implementation code through `/reload`.
- Completed reports remain source-bound after the deadline; child sessions release at
  the deadline and subsequent follow-up fails.
- No worker writes, recursion, arbitrary process execution or copied parent-tool bypass.
- Normal parent-tool-result retention through Pi versus in-memory worker state, accurate
  privacy disclosure, bounded retained data, cleanup and no automatic resume.

### Stronger target gates: not met by the calls/time experiment

The following remain requirements before claiming the corresponding guarantees in
the [target protocol](design-protocol.md):

- Full parent inference-pipeline parity, including request hooks, ephemeral runtime
  settings and session affinity. Explicit model/thinking and standard child configuration
  do not supply that broader contract.
- Every underlying inference attempt, including transport fallback or an internal SDK
  retry, receives pre-dispatch admission; opaque attempts are rejected and initial
  dispatch is not double-debited.
- Raw text, reasoning, framing, compressed transport and tool arguments are bounded
  before parsing or allocation, including decompression and transport buffering.
- Monetary reservations account conservatively for provider pricing, uncertain dispatch,
  retries and settlement, with honest unknown-cost behavior.

The current runtime disables configurable retries, counts model invocations, enforces
logical deadlines, validates inputs before dispatch and checks complete responses only
after the returned Promise resolves. It reports cost as unavailable. These controls do
not pass the stronger gates: adapters may buffer the whole response or make transport
attempts before SpecPi observes completion. The narrower experiment must reject policies requiring unsupported
guarantees. Its fixture tests cannot be presented as transport, invoice or process-memory
proof. The unimplemented recovery/retry policy also needs separate fault-class tests.

For the later web adapter, add connection-time public-address checks, redirects,
rebinding defenses, credential/header stripping, oversized responses, malformed text,
page instruction injection and blocked private-network destinations. Test the actual
transport boundary; a validator unit test alone does not prove connection behavior.

All installer, package and Pi integration tests use fresh temporary state and skip
unnecessary external installation. A live provider smoke test is a separate explicit
authorization with a harmless prompt and a bounded cost envelope. Fake tests cannot
prove production provider parity or network behavior.

## 8. Shipping gate and rollback

Before release, inspect the complete diff, run focused tests and the full repository
check, exercise the packaged artifact, and obtain fresh independent review of provider,
permission, cancellation, retention and dependency changes. Update third-party and
security documentation to describe the contracts actually implemented. A host bridge
that does not exist cannot be replaced with a private-field workaround just to pass
the release gate.

Disabling the extension must stop new calls and revoke broker grants immediately while
reporting requests still settling. Uninstall must not require restoring provider
configuration or authentication files because the package never owns them. Explicit
user-exported evidence remains user data. Policy rollback returns routing to the last
validated version or parent-only operation; it never discards user changes or retries
abandoned work automatically.

An experimental implementation with passing fixtures establishes only its tested
contract. Promotion beyond experimental status requires repeatable value on a defined
task class and understandable operating boundaries. Unimplemented capabilities remain
absent, not represented as partially functioning options.
