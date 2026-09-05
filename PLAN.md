# Plan: Browser application testing and development validation

## Status and objective

**Status: implemented and locally verified on `feat/browser-application-testing`; PR delivery in progress.** The original planning-only task was superseded by the user's explicit implementation, branch, and review-PR request. Requirements below retain their original scope.

Expand SpecPi from rendered inspection to bounded application testing using its existing isolated Playwright runtime. Make rendered-site checks reproducible and add genuine, scoped TypeScript checking. Investigate semantic code navigation afterward, without assuming that a new agent tool is necessary.

Implementation/branch/PR authority comes from the user's subsequent request, not from this plan. This plan is not a capability-verification receipt or permission to change installed resources. If work is selected from the wishlist, use an exact human `/harness-improvement` selection and the `specpi-improve` workflow for that item; this roadmap neither creates that selection nor retires any gap.

## Verified starting point

| Area | Repository evidence | Implication |
| --- | --- | --- |
| Browser tools | `extensions/browser/index.ts` registers open, viewport, snapshot, click, fill, screenshot, baseline, comparison, and close tools. | No agent-facing diagnostics, keyboard, native selection, or condition-wait tool exists. |
| Browser execution | The extension already serializes operations, supports abort-driven shutdown, rejects stale snapshot references, and creates an isolated context. | Preserve these mechanisms; extend rather than replace the browser stack. |
| Browser runtime | `browser-runtime/package.json` pins Playwright `1.62.1`; `extensions/browser/core.mjs` loads the managed runtime. | Reuse the reviewed runtime and lockfile; no second automation framework is needed. |
| Existing browser tests | `extensions/browser/smoke.mjs` checks rendering and exact/changed PNG comparisons; `tests/specpi.test.mjs` covers browser helpers and installer behavior. | These do not establish end-to-end behavior of the proposed agent tools or rendered public site. |
| Site coverage | `tests/site.test.mjs` checks policy examples, routes/assets/fragments, ARIA references, and research-chart provenance. | Retain these fast tests and add real rendered checks, not replacements. |
| Type validation | `scripts/check-syntax.mjs` strips TypeScript types before Node syntax validation. TypeScript `6.0.3` is already a development dependency. | Add a separate no-emit type gate; do not relabel syntax validation as type checking. |
| CI and Pi | `.github/workflows/ci.yml` runs `check` and `check:pi-package`. `scripts/check-pi-package.mjs` installs pinned Pi in temporary state and rejects skipped coverage in its selected extension suites. | Preserve this gate. Missing local access is an environment blocker, not a missing Pi-test mechanism. |
| Pages | `.github/workflows/pages.yml` deploys checked-in site files without a rendered-test prerequisite. | A separate successful CI run does not itself prevent an untested Pages deployment. |

No runtime or test results are claimed by this source-based inventory.

## Requirements and acceptance map

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| R1 | High | Expose JavaScript exceptions, console errors, failed requests, and HTTP error responses. | Local fixtures trigger all four categories, including a visually correct page with broken logic; registered tool results identify each category. |
| R2 | High | Bound and sanitize diagnostics and their lifecycle. | Flood, secret-canary, control-character, truncation, navigation, clear, close/reopen, and abort tests pass; neither text nor structured details bypass limits. |
| R3 | High for web development | Add keyboard input, native dropdown selection, and bounded waits for page conditions. | Registered tools exercise keyboard navigation, single/multiple selection, delayed states, timeout, cancellation, and stale references in Chromium. |
| R4 | Medium infrastructure | Commit a repeatable rendered-site test command and run it in CI. | All public pages pass at desktop, tablet, and mobile sizes under a project subpath; intentional runtime, interaction, and layout faults fail the command. |
| R5 | Medium infrastructure | Add actual scoped TypeScript checking. | A no-emit compiler invocation checks a documented file set against real dependency types, passes valid code, and rejects an intentionally introduced type error. |
| R6 | Medium investigation | Assess semantic definitions, references, and language diagnostics. | A bounded assessment compares project-native/compiler tooling with a possible read-only adapter and records a go/no-go decision with evidence. |
| R7 | Cross-cutting | Preserve isolation, compatibility, package validation, and evidence integrity. | Existing regressions pass, new tools load through pinned Pi, required CI checks execute without skips, and documentation states limits accurately. |

## Delivery sequence

Use small, independently reviewable changes. R1 and R3 are the highest-value product work. Start with a minimal test/type foundation, but do not let repository-wide typing or semantic tooling delay browser improvements.

### Phase 1 — Establish a scoped type and browser-test foundation (R5, R7)

- Add `tsconfig.browser.json` and an `npm run check:types` command using the existing pinned compiler with `noEmit` and strict checking. Start with `extensions/browser/index.ts` and its necessary local type boundary; publish the exact checked file list.
- Resolve Pi, TypeBox, Node, and Playwright declarations from reviewed, pinned development/test dependencies, not the user's global Pi installation. Choose the smallest isolated dependency arrangement compatible with the repository's optional-peer and package-isolation contracts before implementation.
- Replace browser state and registration-boundary `any` types with real Playwright/Pi types. Type local `.mjs` exports through checked JSDoc or narrow declarations; test runtime correspondence rather than hiding the boundary behind ambient `any` modules.
- Preserve lazy loading of the managed browser runtime. Type-only imports must not make ordinary extension loading require an installed browser runtime.
- Do not suppress first-party errors using blanket `@ts-ignore`, broad exclusions, or an all-`any` shim. If dependency declaration checking must be skipped, document that boundary explicitly.
- Add a compiler regression test using temporary positive/negative fixtures. Prove it rejects an invalid tool parameter or incompatible browser API assignment and emits no JavaScript. Keep `check:syntax` intact.
- Establish a local HTTP fixture server and an extension harness that invokes registered tool definitions, with fresh temporary agent state and deterministic cleanup. Reuse the existing Pi harness where appropriate.

**Exit:** scoped type checking works from documented clean setup, the negative fixture fails for the expected diagnostic, and a registered existing browser tool runs against the local fixture. Missing prerequisites fail explicitly in required checks.

### Phase 2 — Browser diagnostics (R1, R2, R7)

**Proposed tool:** `browser_diagnostics`, with bounded `maxEntries`/`maxChars`, optional category filtering, a sequence cursor, and explicit clear behavior. Finalize the schema and defaults before coding.

- Attach listeners before the first navigation for `pageerror`, error-level `console`, `requestfailed`, and `response` with status `>= 400`. HTTP errors and transport failures must remain distinct categories.
- Scope initial support to the active managed page and its observed requests. Document popup, worker, and other-context limitations; do not imply browser-wide coverage.
- Store only sanitized, compact records in memory: sequence, category, bounded message, sanitized location, and relevant method/status/resource type. Avoid retaining Playwright handles or full request/response objects.
- Proposed hard limits: 200 retained records, 2 KiB per record, 256 KiB total retained serialized data; return at most 100 records and 30,000 characters per call. Validate limits at runtime as well as in schemas. Report dropped records, truncated fields, and cursor gaps explicitly.
- Preserve events across navigation until explicitly cleared or the context is discarded; associate records with a navigation/context identity. Specify cursor behavior across clear and reopen so old cursors never silently imply complete coverage.
- Clear must have documented atomic read-and-clear semantics. Closing, session shutdown, and cancellation-driven shutdown discard records and detach listeners. Repeated navigation/reopen must not multiply listeners.
- Do not collect headers, cookies, bodies, storage, console object expansions, or raw stack dumps. Strip URL credentials, query strings, and fragments; bound and redact URLs embedded in messages, sensitive key/value patterns, and terminal control sequences before retention.
- Apply identical sanitation to returned text, structured details, and new-tool failure messages. Redaction is best-effort: arbitrary secrets in free-form messages or paths cannot be guaranteed detectable. Keep this limitation visible and require dedicated test data.
- No diagnostic files, trace capture, HAR output, telemetry, or automatic upload. Tool results still enter the agent conversation and may reach its model provider; in-memory capture does not make returned evidence private from that provider.
- Label records as untrusted application output, not instructions. Empty or incomplete diagnostics must not be described as proof that the application is healthy.

**Exit:** fixture assertions cover startup and post-interaction exceptions, console errors, an aborted request, 404/500 responses, benign traffic, duplicate prevention, flooding, redaction canaries, Unicode/control characters, cursor gaps, and lifecycle cleanup. A fresh read-only review examines privacy and retention behavior before merge.

### Phase 3 — Complete the requested interaction surface (R3, R7)

Proposed tools, deliberately narrower than arbitrary browser scripting:

| Tool | Proposed contract |
| --- | --- |
| `browser_press` | Press a bounded key/chord, optionally on a target; without a target, use the current page focus. Support Tab, Shift+Tab, Enter, Escape, arrow keys, and ordinary text-producing keys through Playwright's keyboard/locator APIs. |
| `browser_select_option` | Select native `<select>` options using an unambiguous value, label, or index selector, including bounded multiple selections. Reject contradictory selectors and incompatible targets. |
| `browser_wait_for` | Wait for one declared condition: locator attached/detached/visible/hidden, exact text on a target, or an exact normalized page URL. Use Playwright condition APIs; no caller-supplied JavaScript, arbitrary regex, or sleep-only mode. |

- Reuse CSS, exact `text=`, and current namespaced snapshot targets. Document single-target/ambiguity behavior consistently with existing tools.
- Proposed action/wait deadline: default 5 seconds, maximum 30 seconds, with positive finite values only. Bound key strings, option arrays, and condition text. Never interpret zero as an unlimited wait.
- Preserve sequential execution and `AbortSignal` handling. Invalidate accepted refs after mutating interactions; navigation must invalidate them even when initiated by application logic rather than `browser_open`.
- Preserve refs for nonmutating waits unless navigation or another invalidating transition occurred. Add explicit regression coverage for these lifecycle rules.
- Report bounded success observations or timeout conditions without reflecting entered secrets. Do not use `networkidle` as a universal application-readiness assertion or silently retry submissions.
- Demonstrate keyboard-produced input events, focus order, key-driven state changes, native single/multiple selects, delayed appearance/disappearance/text/URL transitions, invalid targets, stale refs, timeout, and abort recovery.
- Expand snapshot/help descriptions to identify the new ref-consuming tools. Do not claim support for every possible browser interaction.

**Exit:** real registered tool calls pass positive and negative fixture cases; a later call can create a clean context after cancellation. Existing click/fill/screenshot/baseline behavior remains covered.

### Phase 4 — Repeatable rendered-site checks (R4, R7)

- Add `npm run test:site:browser`, backed by a committed runner and `tests/site-browser.test.mjs`. Reuse the locked Playwright runtime and Node test tooling rather than introducing a second browser framework.
- Serve only `site/` on loopback using an ephemeral port, under `/SpecPi/`. Reject traversal outside the site root; terminate the server and browser on success, failure, timeout, and interruption.
- Test `/SpecPi/`, `/SpecPi/wiki/`, and `/SpecPi/single-agent/` at the existing preset dimensions: desktop 1440×900, tablet 834×1112, mobile 390×844. Include an additional narrow-width case if the initial run exposes a breakpoint edge.
- Assert rendered content, working local navigation/fragments, loaded images/fonts, no unintended horizontal document overflow, and visible/reachable controls. Exercise guard-mode tabs, cycle tabs, keyboard focus/ARIA state, disclosure content, and copy-feedback behavior where present. Test clipboard success/failure deterministically without using the host clipboard.
- Fail on unexpected JavaScript exceptions, console errors, failed local asset requests, and HTTP errors. Any intentional exception needs a narrow, documented expectation, not a blanket ignore list.
- Keep tests deterministic: local assets, explicit readiness conditions, no arbitrary sleeps or third-party network dependency. Use the same bounded diagnostics helpers where practical, but keep test assertions independent of tool success messages.
- Capture bounded failure diagnostics and screenshots from synthetic public-site data only. Do not create or replace visual baselines. Screenshots support human review; DOM assertions and screenshots are not pixel-regression proof.
- Add a required CI browser job with explicit locked runtime/Chromium setup. Missing browser binaries or system dependencies must fail with actionable setup errors, not skip coverage. Keep ordinary fast tests usable without downloading Chromium.
- Gate Pages deployment on the rendered check for the same checked-out revision, preferably by sharing the runner/setup. Include relevant tests, scripts, and runtime configuration in workflow triggers; do not rely on an unrelated CI job finishing first. This is future workflow work, not authorization to deploy now.
- Prove sensitivity with controlled temporary mutations: add a runtime exception, break a tab interaction, and cause horizontal overflow. Each must make the rendered command fail; do not commit the injected faults.

**Exit:** the command is documented and repeatable locally and in CI, detects all three injected faults, and passes the complete viewport/page matrix. Perform browser-tool inspection and screenshots at desktop, tablet, and mobile before claiming rendered correctness.

### Phase 5 — Semantic navigation assessment (R6)

- Use a small representative TypeScript fixture/refactor to assess definitions, cross-file references, and language diagnostics with existing project/compiler tooling. Record correctness, command complexity, and any observed limitation; avoid speculative productivity claims.
- Compare a documented project-native workflow, a narrow TypeScript language-service adapter, and a broader LSP integration. Prefer the existing workflow if it adequately solves the task.
- Record a go/no-go decision and the smallest supported language/project scope. If a tool is justified, prepare a separate implementation proposal with bounded path/line/column results, project-root restrictions, cancellation, subprocess cleanup, and no automatic edits.
- Address unsaved versus on-disk buffers, symlinks/out-of-root references, generated/vendor directories, dependency declarations, and language-server trust before selecting an adapter. Do not automatically install servers or execute repository plugins/configuration merely to navigate code.

**Exit:** evidence-backed decision only. Multi-language LSP support and a semantic-navigation tool are not prerequisites for the browser work.

## Expected implementation paths

These are proposed paths, not an active scope contract. Add new files only when needed.

- Browser: `extensions/browser/index.ts`, `extensions/browser/core.mjs`, optional small diagnostics/types helpers, and `extensions/browser/smoke.mjs` only if its runtime-level contract changes.
- Tests: new `tests/browser-extension.test.mjs`, `tests/browser-diagnostics.test.mjs`, browser fixtures under `tests/fixtures/`, `tests/site-browser.test.mjs`, and `tests/type-check.test.mjs`; retain and narrowly extend existing tests as necessary.
- Validation: `tsconfig.browser.json`, optional `scripts/check-types.mjs`, a rendered-site runner under `scripts/`, `package.json`, `.github/workflows/ci.yml`, and `.github/workflows/pages.yml`.
- Compatibility: `scripts/check-pi-package.mjs` for new registered-tool coverage; `scripts/check-package.mjs` if packaged-file expectations change.
- Documentation: `README.md`, `site/wiki/index.html`, `templates/AGENTS.md` only for actionable tool guidance, `SECURITY_MODEL.md`, and `CHANGELOG.md`. Update `THIRD_PARTY.md` and dependency/security documentation if dependency contracts change.
- Capability claims: inspect `extensions/tool-wishlist/capabilities.json`, `registry.mjs`, and `validators.mjs`; add precise entries/closed validation only when implemented behavior warrants them. Do not let the existing broad browser capability imply these new features are already verified.
- Semantic assessment: a concise decision artifact only if it improves continuity; no language-server implementation in the initial browser delivery.

## Validation and completion gates

For each implementation slice:

1. Run its narrow unit/fixture suite first, including negative cases and actual tool registration where relevant.
2. Run the new scoped `npm run check:types` once available; integrate it into `npm run check` when clean setup is reproducible.
3. Run real Chromium fixture tests and `npm run test:site:browser` for applicable changes. Mock tests alone cannot prove browser behavior.
4. Run `npm run check` and `npm run check:pi-package` for material extension/package changes. Preserve pinned Pi's rejection of skipped required suites; add new Pi-facing suites to explicit coverage where appropriate.
5. For installer/runtime changes, exercise plan/install/update/doctor/uninstall in fresh temporary `PI_CODING_AGENT_DIR` state. Never use the live agent directory, personal profiles, credentials, sessions, or history. Skip unrelated external installation; isolate and explicitly provision any runtime needed for the test.
6. Inspect `git diff --check` and the final diff. Request fresh frozen read-only review for privacy, retention, dependency, or installer changes; the parent verifies and resolves findings and remains the sole writer.
7. Report commands, outcomes, skips/blockers, checked scope, and artifact paths. A missing runtime or inaccessible package prevents the relevant acceptance claim; it is not a successful test.

**Done means:** R1–R5 and R7 have direct passing evidence, R6 has an explicit assessment decision, all required CI coverage executes, and documentation matches the shipped limits. Source inspection, tool registration, a green syntax check, or a visually correct page alone is insufficient.

## Implementation record

- R1–R3: four registered tools implemented with pre-navigation diagnostics, byte/count/output limits, clear/cursor/loss semantics, deadlines, ref invalidation, and real Chromium fixtures. `npm run test:browser` passes with zero skips; `tests/browser-diagnostics.test.mjs` covers sanitation, flood, Unicode, cursors, validation and listener cleanup.
- R4: committed loopback server, rendered matrix and fault-injection assertions. `npm run test:site:browser` passes 11 tests with zero skips. Visual inspection covers the changed wiki/browser guidance at desktop, tablet and mobile; local non-baseline PNGs are under `.specpi-test/visual-review/`. CI and Pages share `.github/workflows/browser-tests.yml`.
- R5: strict `tsconfig.browser.json` and `check:types` use pinned development declarations. Positive/negative compiler tests pass; `.mjs` helper declaration scope and `skipLibCheck` are explicitly disclosed. The new config is included in verification fingerprints.
- R6: the existing compiler resolves one cross-file definition, four alias-related references excluding shadowed names, and the expected type error after an on-disk mutation. `docs/browser-testing.md` records the decision not to add a semantic tool now; `tests/semantic-navigation.test.mjs` makes that assessment reproducible.
- R7: installer and package inventories include all three runtime helpers; production optional peers remain unchanged. The packed artifact lifecycle and pinned Pi 0.84.4 checks pass locally. Package size ceilings were adjusted to 340 KB compressed / 1.4 MB unpacked for the reviewed additional tools/docs, without broadening the exact file allow-list.
- The first rendered test run correctly exposed a test-driver mistake: a keyboard-only skip link was clicked while offscreen. The test now proves first-Tab focus and Enter activation rather than bypassing actionability. Intentional runtime, interaction and layout faults still fail their specific expected assertions.
- Independent browser review identified redaction-expansion truncation, queued deadlines, pre-aborted cleanup, bounded teardown, and failure-path ref invalidation gaps. Added direct unit/Chromium regressions and fixes. Teardown is bounded to one additional second, with an explicit possibly-remaining-process error and close-retry requirement rather than a false termination claim. Closing browser and context concurrently caused a real Chromium disposal race; teardown now closes the browser (and thus its contexts) once.
- The second frozen review identified late-launch disposal ownership, shutdown queued behind capture, percent-encoded URL truncation, open/viewport ref invalidation, and TODO-only runner acceptance. Findings were accepted before editing; fixes and focused regressions pass. Session shutdown now aborts active work and bounded disposal owns late launch results. Required browser gates reject missing, skipped, TODO, cancelled, or nonpassing coverage.
- Final local evidence: `npm run check` passes (335 passed, 3 explicitly opt-in Chromium tests skipped in the fast suite, zero failures), including the exact packed artifact lifecycle (86 files, 324,698 compressed bytes). `npm run test:browser` and `npm run test:site:browser` execute the Chromium coverage without skips; the latter passes 11 tests including fault injection. `npm run check:pi-package` passes through pinned Pi 0.84.4. `git diff --check` passes. The review PR will carry the live CI state and requirement-by-requirement evidence.
- Local test/runtime downloads remain ignored under `.specpi-test/`, not in shipped resources or live Pi state. Visual-review artifacts are screenshots only, not baselines; the temporary visual-QA server and browser were closed.

## Rollback and non-goals

- Keep foundation, diagnostics, interactions, rendered CI, and documentation changes separable. Revert each implementation slice with its tests, command registrations, workflow references, and capability claims; do not leave advertised tools or required CI commands dangling.
- New diagnostic state is ephemeral, so no persistent-state migration should be necessary. Preserve existing browser tools and explicit baseline/overwrite semantics.
- Any dependency change must remain pinned and reversible; do not edit `node_modules/` or installed SpecPi resources. Do not introduce global tooling.
- Out of scope: arbitrary page evaluation tools, request interception/modification, HAR/tracing, body/header capture, persistent authenticated profiles, personal cookies, downloads/uploads, popup orchestration, cross-browser matrices, automatic baseline updates, autonomous fixes, and repository-wide typing/LSP migration.
- No commit, push, publish, release, deployment, or remote-state change is authorized by this plan.
