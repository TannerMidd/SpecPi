# Quality tooling evaluation results

The September 13, 2026 screen found **no defect-detection or behavioral-acceptance advantage** for the review skill or anchored editing over their controls. Keep review explicitly invoked and leave anchored editing uninstalled. The production additions focus on observed check evidence, freshness and selected editor context; this experiment does not measure their effect on overall coding accuracy.

## Scope and reproducibility

Two frozen comparisons each ran eight synthetic tasks three times in two conditions: 96 completed runs, 48 per comparison. A separate two-run review pilot is excluded. The model was `gpt-6-astra`, medium reasoning, through Codex CLI 0.153.1 using the user's ChatGPT subscription. The native editing backend was Pi 0.84.4's actual multiple-replacement edit implementation. Both comparisons completed without model-call failures, recovery responses, native Codex tool events or human interventions.

The [protocol](quality-evaluation.md) defines the tasks, independent oracles, ordering and limits. The [sanitized result archive](../evals/quality/results/2026-09-13.json) contains all 96 per-run records, token counts, timings, prompt/source/fixture hashes, review findings and all 18 distinct final fixture variants. It excludes host paths and private state. The original requests and seed files are in [tasks.mjs](../evals/quality/tasks.mjs). Source hashes were checked against both frozen manifests before export. Baseline repository revision: `6f63ef8fdfff7f5409fdf71f6e5f1362a61aedd6`.

All reported assessment of findings and diffs below is **agent inspection**, not a completed blinded human maintainability review. Human review remains part of the PR.

## Review: optional skill versus a short concrete-review prompt

| Measure | Baseline | `specpi-review` |
| --- | ---: | ---: |
| Seeded issue cases identified | 21 / 21 | 21 / 21 |
| Intentional-interface controls left unflagged | 3 / 3 | 3 / 3 |
| Unsupported findings identified in agent inspection | 0 | 0 |
| Responses explicitly describing review limitations | 3 / 24 | 24 / 24 |
| Findings returned | 26 | 24 |
| Median model-response time | 10.81 s | 12.24 s |
| Reported input tokens, total | 399,700 | 408,626 |
| Reported cached input tokens, total | 117,760 | 153,088 |
| Reported output tokens, total | 3,161 | 4,186 |
| Reported reasoning output tokens, total | 544 | 649 |

Both conditions identified the pagination, zero-default, caller-migration, containment, stale-receipt, browser-persistence and shared-label issues on every repetition. Both also found the browser's separate whitespace/blank-input defect. The baseline split one coordinated caller migration into three findings; that accounts for its larger finding count, not additional defect coverage. All six stale-receipt reviews disclosed the deliberately unrelated baseline failure.

The skill consistently stated what was inspected and that runtime evidence was absent. This is useful reporting behavior, with extra response length and latency. The screen does not establish that it repairs more defects or reduces a maintainer's review effort. Ship it as a human-selected review aid, with no automatic review loop or automatic rewriting.

## Editing: native multiple replacements versus snapshot anchors

| Measure | Pi native | Anchored candidate |
| --- | ---: | ---: |
| Independent behavioral acceptance | 24 / 24 | 24 / 24 |
| Rejected edit calls | 0 | 0 |
| Recovery responses | 0 | 0 |
| Negative-control fixtures left byte-for-byte unchanged | 3 / 3 | 3 / 3 |
| Unrelated baseline-test files preserved | 3 / 3 | 3 / 3 |
| Unexpected file targets | 0 | 0 |
| Median model-response time | 9.64 s | 10.80 s |
| Reported input tokens, total | 391,584 | 407,925 |
| Reported cached input tokens, total | 35,328 | 59,520 |
| Reported output tokens, total | 3,644 | 4,976 |
| Reported reasoning output tokens, total | 584 | 708 |

| Task | Native acceptance | Anchored acceptance | Inspection of final changes |
| --- | ---: | ---: | --- |
| Page boundary | 3 / 3 | 3 / 3 | Same single comparison correction |
| Explicit zero | 3 / 3 | 3 / 3 | Same nullish-default correction |
| Caller migration | 3 / 3 | 3 / 3 | Same formatter and both caller updates |
| Path containment | 3 / 3 | 3 / 3 | Equivalent boundary predicates within the stated POSIX input contract |
| Receipt freshness | 3 / 3 | 3 / 3 | All detect declared-input changes; five repairs introduce general recursive comparison and one uses Node's deep equality |
| Browser persistence | 3 / 3 | 3 / 3 | All pass real Chromium reload, blank input and safe-text checks; storage-key and formatting differences |
| Existing reuse | 3 / 3 | 3 / 3 | Same reuse of the existing formatter; no duplicated mapping |
| Intentional interface | 3 / 3 | 3 / 3 | No changes |

Agent inspection found no unrelated file edits or broken intentional interfaces. The receipt-freshness repairs are broader than a comparison specialized to the declared string-map contract; the fixture prompt does not show a complete receipt schema, which may encourage general comparison. Treat that as a maintainability question and fixture limitation, not as evidence that passing checks establish optimal code quality. All six editing responses disclosed the unrelated failure and preserved its bytes.

The anchored candidate achieved no acceptance or recovery improvement and used more output tokens with higher median latency in this screen. It remains a pure, uninstalled experiment. Unit coverage for stale hashes, overlapping ranges, duplicate lines, BOM, CRLF and Unicode supports its buffer behavior only. Production Command Guard, scope interception, file-race handling and platform integration have not been established for an anchored tool; no production adapter or setting is enabled.

## Implementation decisions

| Recommendation | Result | Basis and remaining limit |
| --- | --- | --- |
| Reproducible evaluation before promotion | Implemented | Eight independent fixtures, control/candidate repeats and retained evidence; broader real tasks are needed before claiming general accuracy |
| Explicit correctness/simplicity review | Implemented and installed as a manual skill | Tied detection, more explicit limitations; human chooses when the cost is worthwhile |
| Finite checks with runtime receipts | Implemented as `verify_run` | Existing runner and Guard admission; bounded declared-input hashes, observed output/exit/cleanup, no model-created pass receipts |
| Human-selected required checks | Implemented as `/task checks` | Checks bind to original requirements and task digest; challenge submission and handoff revalidate current inputs; restored summaries remain historical |
| Selected editor diagnostics and symbol context | Implemented in VS Code | Existing providers and attachment transport; previews and stale-buffer rejection; cached diagnostics are not a typecheck result |
| Anchored editing | Experiment completed; not promoted | No observed quality or recovery advantage over native editing |

Runtime regression coverage includes nonzero exit, timeout, cancellation, cleanup uncertainty, stale/missing inputs, source/test/config changes, bounds, private paths and links, session/policy invalidation, receipt eviction, newer failure after an older pass, forged or ambiguous provenance, task selection and schema-1 compatibility. Installer fixtures use disposable Pi state; packaged resources are loaded by pinned Pi. Editor unit/controller tests and a real VS Code host exercise diagnostics, definitions, references, previews and stale-send rejection. CI also runs the runner and verification regressions on macOS and Windows, alongside the full Linux suite.

## Interpretation limits

These small, prompt-explicit tasks saturated both controls. Three repetitions per task do not establish equivalence or estimate real-repository accuracy. Requests largely describe the intended bug; supplied files represent a synthetic proposed change rather than realistic discovery through repository history. Review did not include an implement-review-repair cycle. The anchored screen did not force model recovery from injected concurrent edits; stale-buffer behavior is separately unit tested.

The Codex response adapter retains CLI system context and service scheduling. Its native tools were instructed off rather than disabled; none appeared in the recorded calls. Tokens include the CLI's context and should not be interpreted as fixture-only prompt size. Cached and reasoning token fields are reported separately as the CLI returned them, not added to totals. Subscription dollar cost is unavailable; API prices were not substituted. Timing is descriptive and cannot establish a causal speed difference.

Keep the existing native editor, collect evidence from real use, and require a fresh, frozen comparison plus production boundary tests before revisiting anchored-tool promotion. See [quality-evidence.md](quality-evidence.md) for using the implemented features and their trust boundaries.
