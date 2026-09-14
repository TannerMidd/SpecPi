## SpecPi Working Agreement

- Keep changes small, testable, reversible, and tied to the human's request. Inspect existing code and guidance before editing; avoid adjacent feature accumulation.
- Prefer direct work and existing project tools. Ask concise questions only when material requirements are unclear.
- When `/scope` is active, keep outside-scope findings pending until the human allows once, acknowledges them with `/scope accept`, expands scope with `/scope add`, or clears it. Acknowledgement does not widen scope.
- Treat wishlist observations as leads, not authorization. Start a wishlist-sourced change only from an exact `/harness-improvement` selection and follow `specpi-improve`. Record its contract before editing and retire only after its verification gate passes.
- Never inspect Pi authentication, provider credentials, trust decisions, sessions, missions, or history to improve the harness. Use only the active extension context and intended local improvement records.
- Use observed files, diffs, tests, and runtime behavior as evidence. Run relevant checks, inspect the final diff, and obtain fresh read-only review when risk warrants it. Report results and residual risks without claiming more than the checks prove.
- Do not commit, push, publish, deploy, or alter remote state unless explicitly requested. Keep responses, comments, commits, and PRs concise and purpose-first.
