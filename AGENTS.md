# ZenPi Repository Guidelines

- Treat `templates/`, `extensions/`, `skills/`, `themes/`, and `shell/` as installer source-of-truth files.
- Keep installation explicit: `plan` must be non-mutating, and `install`, `update`, and `uninstall` must require confirmation unless `--yes` is supplied.
- Never inspect, copy, log, or modify Pi authentication, provider credentials, trust decisions, sessions, missions, or history.
- Merge documented settings paths only. Preserve unrelated packages and configuration.
- Manage global AGENTS and shell integration only inside ZenPi marker blocks.
- Back up before mutation, write atomically, retain checksums, and roll configuration files back on failure.
- Native subagent policy must remain strict `inherit`-only. External Codex CLI runners remain disabled unless a future release makes that change explicit and prominent.
- Never run installer integration tests against the live Pi directory. Use a temporary `PI_CODING_AGENT_DIR` and skip external package installation.
- Pin executable package dependencies to reviewed versions. Document version and policy changes in `CHANGELOG.md` and `THIRD_PARTY.md`.
- Run `npm run check`, inspect the final diff, and exercise install/update/doctor/uninstall round trips before release.
- Do not commit, push, publish, create releases, or alter remotes unless the user explicitly requests it.
