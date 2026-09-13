# Quality evaluation protocol

This screen evaluates optional review and editing mechanisms alongside SpecPi's runtime-evidence and editor-context changes. Its eight synthetic fixtures represent boundary fixes, caller migration, verification freshness, browser behavior, reuse and an intentional public interface. They are sanitized reproductions of failure classes, not historical repository tasks or private-session extracts. The baseline repository revision is `6f63ef8fdfff7f5409fdf71f6e5f1362a61aedd6`; fixture digests separately identify their exact contents.

The completed [September 13, 2026 results](quality-results.md) report both comparisons and the decision to keep anchored editing uninstalled.

## Frozen comparisons

| Comparison | Control | Candidate | Independent outcome |
| --- | --- | --- | --- |
| Review | Short request for concrete read-only findings | Explicit `specpi-review` skill, mode both | Supported defect detection, missed defects and unsupported findings, with a negative interface-preservation control |
| Editing | Pi 0.84.4's actual `createEditToolDefinition`, including multiple replacements | Experimental full-byte snapshot plus inclusive line ranges | Behavioral acceptance, unintended edits, recovery calls and latency |

The review screen presents each supplied file set as the proposed change. It does not measure an entire implement-review-repair workflow. The editing screen permits up to three responses only when an edit was rejected; the hidden acceptance oracle is not fed back to the model. Both conditions receive the same request, fixture and context. Order alternates by task and repetition. There are three repetitions of eight tasks in two conditions: 48 runs per comparison and model. Infrastructure failures halt the batch and are excluded from model success counts.

The user selected their Codex subscription. Runs use `codex exec --ephemeral --ignore-user-config --sandbox read-only` with `gpt-6-astra`, medium reasoning and structured JSON responses. Sign-in mode was checked through the CLI's supported status command; no authentication files are read or copied by this evaluator. API-key overrides are removed from the child environment. Codex's own subscription authentication remains the provider boundary.

This is a Codex response adapter, **not a full Pi agent benchmark**. The model is instructed to use only supplied context; any native tool event is recorded as a protocol deviation. Codex system context and service scheduling remain outside the fixture. Provider/model/CLI versions, input/output/reasoning/cache tokens where available, elapsed time, prompt and source digests, edit results and interventions are retained. Dollar cost is unavailable for subscription runs and is not inferred from API pricing. Results must not be pooled across models or represented as a general coding-accuracy percentage.

## Fixtures and independent checks

| Task | Seeded failure / control | Acceptance |
| --- | --- | --- |
| `page-boundary` | Exact final page advertises another page | Exact, partial, earlier, empty and past-end cases |
| `explicit-zero` | `||` replaces a valid zero retry budget | Zero, null, absent and positive cases |
| `caller-migration` | Currency API requires a coordinated migration | New signature plus cart and invoice callers |
| `path-boundary` | Prefix comparison includes siblings | Root, descendants, prefix siblings and filesystem root |
| `stale-check` | Equal Git HEAD ignores changed input bytes | Source/test/config changes, additions, removals, ordering; preserve unrelated failure |
| `browser-persistence` | Saved label loses the value on reload | Real Chromium reload, blank input and HTML-like text |
| `existing-reuse` | List duplicates the raw-code presentation | Consistent known/unknown labels; reviewer checks single mapping |
| `intentional-interface` | Negative control: valid public extension point | External plugin registration, duplicate and unknown errors |

`tests/quality-evaluation.test.mjs` checks that the functional oracles reject the seeded defects and accept independently authored reference repairs. The browser oracle is separately qualified against both states in real Chromium. The negative control starts passing. Reference repairs and oracles are outside model fixtures; a missing browser is a failure, never a skipped success.

## Maintainability rubric

A maintainer should review paired results with condition labels hidden, using the request, final diff, acceptance result and these questions. Record concrete findings, not a blended numerical score:

- Is the reported defect supported by a reproducible input or a clear code path?
- Were required callers, boundaries, intentional extension points and unrelated failures preserved?
- Does the change reuse an existing source of truth and avoid unnecessary configuration or abstractions?
- Are edits outside the intended behavior justified?
- Was an important defect missed, or was a coherent implementation flagged without a concrete cost?
- How much review or correction effort was required?

Agent analysis of results must be labeled as such. It cannot substitute for a completed blinded human maintainability review. The PR is the place for that independent review.

## Reproduction

Use a reviewed local checkout, Node 22.19+, installed development dependencies and the existing locked Chromium runtime (`npm run setup:browser` if needed). Set `SPECPI_EVAL_CODEX` to the intended Codex executable and verify `codex login status` reports ChatGPT subscription sign-in. These commands consume the selected account's subscription allowance:

```powershell
$env:SPECPI_EVAL_CODEX = (Get-Command codex).Source
node evals/quality/run.mjs review .specpi-test/quality-review-run
node evals/quality/run.mjs editing .specpi-test/quality-editing-run
```

Destinations must be new directories. An optional final run-count argument supports a pilot; pilot runs are not mixed into the 48-run result. Full manifests and per-run JSON stay under the ignored `.specpi-test` directory. Do not put user code, logs, auth or history into fixtures. Do not modify evaluator sources or the skill during a comparison.

## Anchored-edit decision rule

The candidate in `evals/quality/anchored-edit.mjs` is a pure buffer transformation, with no registered tool or production setting. Exact source-byte hashes reject stale snapshots; all line ranges resolve before writing; overlap or malformed ranges leave the source unchanged. Unit checks cover duplicate lines, BOM, CRLF, Unicode, multiple edits and repeated stale calls. The driver applies it only to its closed disposable fixture inventory.

Production promotion requires repeatable per-model quality gains or meaningful recovery/review-effort savings without unintended changes. Tied or uncertain screens leave it off. This experiment does not establish equivalence with native mutation interception or Command Guard. A production adapter would require those integration regressions before any rollout. No Oh My Pi executable dependency, Pi fork or new installed editing tool is introduced.
