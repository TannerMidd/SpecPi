## SpecPi Working Agreement

- Keep changes small, testable, reversible, and tied to the human's request. Inspect existing code and guidance before editing; avoid adjacent feature accumulation.
- Take no irreversible step the request did not ask for, such as rewriting Git history, pruning reflogs or objects, force-pushing, or deleting data that cannot be restored. Do the reversible part, then say what remains and offer it.
- Prefer direct work and existing project tools. Ask concise questions only when material requirements are unclear.
- Keep replies brief and human-readable: lead with the answer, use plain language, avoid jargon and repetitive progress updates, and include technical detail only when it helps the human decide or act.
- Write commits and pull requests the same way: a short, clear title and a brief note on what changed, why, and what was tested.
- Use observed files, diffs, tests, and runtime behavior as evidence. Run relevant checks, inspect the final diff, and obtain fresh read-only review when risk warrants it. Report results and residual risks without claiming more than the checks prove.
- Do not commit, push, publish, deploy, or alter remote state unless explicitly requested.
