# Evidence behind the delegation design

Reviewed through 5 September 2026. This ledger distinguishes published studies,
preprints, production accounts and API contracts. Design implications are our
inferences. None of these sources benchmarks SpecPi's experimental implementation.
The [implemented guide](README.md) and [calls/time protocol](protocol.md) describe its
current behavior. The [archived design](design.md) preserves the broader proposal;
publication of supporting research does not establish that either design improves
SpecPi outcomes. Deterministic fixture tests and empirical evaluation are separate.

## Existing seven-study foundation

The [architecture article](../../site/single-agent/index.html) and its
[reviewed chart data](../../site/charts/research-data.json) contain the detailed
comparisons. The relevant implications for this design are:

| Primary source                                                                                                                                        | Evidence relevant to the decision                                                                                  | Consequence for the protocol                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [Kim et al., Nature Machine Intelligence, 24 July 2026](https://www.nature.com/articles/s42256-026-01268-y)                                           | Coordination helps some task classes and degrades others under matched system ceilings; software samples are small | Keep a parent-only route and evaluate by task class; no universal capability cutoff                |
| [Tran and Kiela, preprint v2, 11 April 2026](https://arxiv.org/html/2604.02460v2)                                                                     | Requested reasoning budget changes the single-versus-multi-agent ranking; actual accounting is imperfect           | Give the single agent the same additional resources before attributing gains to delegation         |
| [Wunderlich et al., ACL SRW, July 2026](https://aclanthology.org/2026.acl-srw.1/)                                                                     | Configured ensembles can improve static-question accuracy at comparable modeled compute                            | Allow measured exceptions; distinguish ensembles from tool-using repository work                   |
| [SwarmBench, preprint v1, 31 August 2026](https://arxiv.org/html/2608.30661v1)                                                                        | Swarm gains on several context-intensive tasks; only four task types have cost-matched comparisons                 | Prioritize bounded independent research; preserve metrics, model composition and cost denominators |
| [Anthropic research system, 13 June 2025](https://www.anthropic.com/engineering/multi-agent-research-system)                                          | Parallel research can improve coverage, with substantially greater token use                                       | Budget source collection and synthesis together; no automatic assumption of cheaper outcomes       |
| [OneFlow, preprint v1, 18 January 2026](https://arxiv.org/html/2601.12307v1)                                                                          | Useful workflow structure can survive single-conversation execution; latency changes depend on workflow            | Test serial structured execution as an alternative; track caching and latency independently        |
| [MAST, NeurIPS 2025](https://papers.nips.cc/paper_files/paper/2025/hash/b1041e52d3be19f0a9bc491657488e4a-Abstract-Datasets_and_Benchmarks_Track.html) | Taxonomy covers design, coordination and verification failures; no matched single-agent control                    | Require explicit coverage, provenance, incomplete states and parent acceptance                     |

## Additional empirical evidence

### CooperBench: communication does not solve integration

[CooperBench, v2, 26 January 2026](https://arxiv.org/html/2601.13295v2), Sections 2,
4–5 and Appendix C/Table 5, evaluates 652 paired-feature tasks across 12 repositories
and four languages. Tasks deliberately involve overlapping or interdependent code;
agents work in separate containers. Communication reduced merge conflicts for four
models without a significant cooperation-success gain for any model. GPT-5's
successful-task counts were 315 solo versus 183 cooperative. Communication could consume
up to 20% of execution steps.

**Inference:** file separation, successful messaging and a clean merge are weak
acceptance criteria. Keep one integration owner and specify behavior and interfaces,
not only paths. A writing-worker proposal needs its own end-to-end evidence.

**Limits:** the 100-action ceiling is per agent, not a demonstrated match of total
spending. Conflict-heavy coding tasks do not characterize independent research scouts.
Observed associations between early planning and fewer conflicts are not a causal
evaluation of a planning protocol.

### MTRouter: routing is a capability with a training cost

[MTRouter, ACL final proceedings, July 2026](https://aclanthology.org/2026.acl-long.2045.pdf),
Sections 3–4, Table 3 and Appendix A.2, studies sequential selection among six models.
On 359 in-distribution HLE questions, GPT-5 achieved 25.1±1.6% accuracy at $61.8, versus
26.0±2.3% at $35.0 for MTRouter. Values are mean±SD over three runs, and costs aggregate
evaluated episodes. Both use a $2 episode ceiling and a 30-turn limit. Training-data
collection used 29,693 trajectories at approximately $1,620.

**Inference:** evaluate model routing separately from delegation. Use observed
task-state evidence and account for training and switching costs; an untrained
confidence heuristic is not the studied router.

**Limits:** HLE and ScienceWorld are not repository coding; the small accuracy
difference does not establish superiority. Exact switch probabilities differ between
Figure 4 and its prose, so they are not used here. Cache-related explanations are not
isolated causal measurements.

### Paritok-4B: a smaller packet is not automatically a better packet

[Paritok-4B, v1, 25 August 2026](https://arxiv.org/html/2608.24188v1), Section 6.2,
Table 9 and Section 7, tests all 300 SWE-bench Lite instances. Its line-numbered
compression configuration retained 27.8% of context tokens by per-instance
macro-average. Uncompressed context solved 122/300 tasks (40.7%); compressed context
solved 109/300 (36.3%). Patch-application failures were five versus sixteen. The paired
solve difference had exact McNemar p=0.079.

**Inference:** preserve retrieval of original source inside the grant. Count omissions
and downstream accepted results, not just reduction in packet size. Select relevant
material before adding another model to compress it.

**Limits:** this is one tool-free Sonnet 4.5 request with oracle file context and
diff re-anchoring, not a running coding agent. Non-significance does not demonstrate
equivalence. Token reduction does not include compression, caching, latency or recovery
costs and must not be presented as end-to-end savings.

### OrchestraBench: recovery requires a useful change in state

[OrchestraBench, v1, 5 August 2026](https://arxiv.org/html/2608.05263v1), Sections
5.2–5.5, Table 8 and the trusted-state ablation, separates transient tool faults from
latent semantic corruption in controlled arithmetic chains. Blind retry reproduced
latent faults. In the N=180 trusted-state ablation, latent recovery fell from 0.67 to
0.08 when the trusted upstream value was removed. The paired comparison used 24 pairs.

**Inference:** a recovery request must identify the failed assumption and new evidence
or validated state. Preserve incomplete and uncertain outcomes. A replay of the same
instructions is not a recovery strategy.

**Limits:** these are small synthetic mechanism probes; some outcomes are deterministic
by construction. A simple TF-IDF comparator solved all ten adversarial routing cases.
The study does not justify a dedicated LLM router or production reliability claims.

## Additional production guidance

### Cognition: useful collaborators around a single writer

[Multi-Agents: What's Actually Working, 22 April 2026](https://cognition.com/blog/multi-agents-working)
updates Cognition's earlier skepticism. It describes useful fresh-context review and
capable-model consultation while retaining one writer. Its weaker-primary consultation
experiment improved cost and speed but hit a quality ceiling because the primary
struggled to recognize when and how to ask for help.

**Inference:** preserve a strong parent; keep review context free of implementation
rationalization; return concrete context requests when evidence is missing. Evaluate
different-model consultation against a same-model fresh context. Do not infer that
different context makes errors statistically independent.

**Limits:** this is a production account, not a controlled budget-matched comparison.
Full-history forking is one reported consultation technique, but SpecPi's privacy and
explicit-packet boundary means it is not adopted here. No reported product bug count
is used as a target for SpecPi.

### Anthropic: keep the standing harness small

[The new rules of context engineering, 24 July 2026](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
reports reducing Claude Code's system prompt by over 80% for newer models without a
measured loss on its coding evaluations. It emphasizes interface design, progressive
disclosure, and avoiding repeated instructions.

**Inference:** put constraints in the controller and broker; load short mode instructions
only when needed. Do not add a second planner, repeated role prompts, or several pages
of standing routing heuristics to every SpecPi session.

**Limits:** this is model- and harness-specific engineering guidance. It is not evidence
that deleting arbitrary safety checks, context, or instructions helps every model.

## Pi compatibility evidence

The ordinary installer supports Pi 0.84.4 or later; the experimental `specpi agent`
launcher supports SDK 0.84.4 exactly. The original investigation inspected public tagged
source and official documentation without calling a real provider or inspecting private
Pi state or credentials. The implemented launcher now supplies a host-owned pipeline
closure through the public SDK, with synthetic-provider compatibility fixtures. That
does not establish every production provider's behavior or the stronger transport and
cost guarantees retained in the target design.

| Contract                                     | Primary source                                                                                                                     | Design consequence                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Credential-blind completion facade           | [ModelRegistry at v0.84.4](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/model-registry.ts#L59) | Useful building block; does not expose the configured streaming pipeline                |
| Runtime auth and request preparation         | [ModelRuntime](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/model-runtime.ts#L541)             | Keep credential handling inside Pi; preserve composed provider behavior                 |
| Host request policy and thinking translation | [SDK](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/sdk.ts#L283)                                | A direct completion is not full host-request parity; require a supported bridge         |
| Tool interception                            | [AgentSession](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/agent-session.ts#L451)             | Built-in factories and `pi.exec()` do not automatically inherit Command Guard           |
| Resource discovery                           | [ResourceLoader](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/resource-loader.ts#L36)          | In-memory session storage alone does not create a sterile child                         |
| Tool scheduling                              | [Agent defaults](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/agent.ts#L205)                               | Explicitly select execution policy and enforce each limit before work                   |
| Error and usage semantics                    | [Message types](https://github.com/earendil-works/pi/blob/v0.84.4/packages/ai/src/types.ts#L332)                                   | Inspect terminal status; do not double-count reasoning output or assume errors are free |
| Session identity and navigation              | [Extension types](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/extensions/types.ts#L522)       | Invalidate actual navigation and task revisions, not every advancing leaf               |

[Latest SDK](https://pi.dev/docs/latest/sdk), [latest extensions](https://pi.dev/docs/latest/extensions)
and [latest provider documentation](https://pi.dev/docs/latest/custom-provider) were
cross-checked. These are moving references, not proof of compatibility with the pinned
version. Public `main` identified itself as 0.85.0 during investigation; this is not a
verified npm dist-tag and does not authorize a dependency upgrade.

## What remains unproven

The research does not establish an optimal default packet size, worker count, retry
count, or routing threshold for SpecPi. It does not demonstrate production reliability
for this implementation, a financial return, or a general advantage for parallel code
writers. The target design and experimental protocol turn these uncertainties into
testable choices. Runtime compatibility and measured user value remain distinct gates.
