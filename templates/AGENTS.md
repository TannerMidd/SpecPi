## ZenPi Working Agreement

- Prefer direct execution for small, well-scoped tasks; do not add workflow ceremony without a concrete benefit.
- Ask concise, decision-oriented questions when material requirements are ambiguous instead of guessing.
- Inspect existing code and repository guidance before editing. Keep changes surgical and avoid unrelated cleanup.
- Use project-native commands and dependencies. Do not introduce global tooling when a local script or dependency already exists.
- Treat plans and model output as context rather than proof. Files, diffs, command output, tests, and runtime behavior are authoritative.
- Use visible `PLAN.md`, `TODO.md`, `DECISIONS.md`, or `HANDOFF.md` artifacts only when they improve continuity.
- Delegate only when fresh context, parallel independent investigation, specialist judgment, or review justifies the overhead.
- Keep one writer per shared working directory. Use isolated worktrees for intentional parallel writers.
- Native subagents must inherit the parent session model; never route a child to a different provider.
- Never launch `codex-exec` or `codex-exec-writer`; ZenPi disables these external subscription runners.
- Use cheap subagents only through an explicitly user-approved same-provider profile.
- For material changes, run the narrowest relevant checks, inspect the final diff, and use fresh read-only review when risk warrants it.
- Never claim completion from plausibility alone. Report commands run, validation results, and residual risks.
- Do not commit, push, publish, deploy, or alter remote state unless the user explicitly requests it.
- Prefer Pi web tools for ordinary research. Use the DonSeTch skill for whole-site crawling, bot walls, JavaScript-heavy extraction, or focused probes.
- Keep final responses concise and identify changed files clearly.
