# Security model

SpecPi provides scope monitoring and an explicit harness improvement loop, and installs eight upstream packages as its default base. Extensions run as trusted code with Pi's permissions. Scope is not an OS sandbox or a general command guard. Use OS isolation for hostile code.

## Scope monitoring

The human declares project-relative paths. Interactive `write` and `edit` calls outside those paths require a decision; headless calls are recorded as pending. Git snapshots detect changes from other tools after execution. Paths, snapshots, and displayed findings are bounded, and uncertainty remains visible until an explicit recheck. Ignored files, subprocess activity, timing races, and changes outside the observed project can escape snapshot coverage. A clean report does not prove that no other mutation occurred.

Scope records use Pi's current session branch. Restoring a branch does not create new authority or accept pending drift. An improvement contract can supply paths only through the human's `/scope task` command.

## Improvement authority and evidence

Collection is off by default. Enabling it permits sanitized gap observations, not implementation. Only an exact human `/harness-improvement` selection authorizes a wishlist-sourced change. The selected contract is bound to the gap, source checkout, session, and selection generation.

Retirement requires source registry integration, unchanged verification policy, a matching contract, bounded source snapshots, `npm run check`, and closed registered validators. Receipts distinguish machine-observed gates from model-reported acceptance evidence. Stale selections, changed source, missing evidence, and failed checks reject retirement. A validator proves only the behavior it exercises; the human remains responsible for accepting the result. The loop never commits, publishes, or installs a resulting change automatically.

Wishlist records remain local under `<agent-dir>/specpi/`. Sanitization and salted identifiers reduce exposure but do not guarantee anonymity. Evidence supplied by a model can still be sensitive. Reports, archives, outcomes, and issue drafts are local; external sharing requires explicit human action. Pi's own model requests and retention are governed by Pi and the chosen provider.

## Installer and migration

`plan` is read-only. Installation, updates, and removal require confirmation or `--yes`. SpecPi manages its two first-party extension families, improvement skill, manifest, AGENTS marker block, and the eight package entries listed in `templates/settings.json`. Normal install/update runs `pi install npm:<name>@<pin>` for every default package. Only package entries are merged; existing resource filters and unrelated settings are retained. `--skip-package-install` allows a core-only install or preserves an already configured base during update. No new shell profile integration is installed.

Managed configuration and files are locked and backed up before mutation; first-party writes are atomic and checksum-tracked. Failure restores the saved configuration and first-party files. Package acquisition runs upstream package-manager scripts and may leave downloads, dependency changes, or external script effects even after configuration rollback. Those effects are outside SpecPi's transaction. Updates require `--force` before replacing modified retained resources. Retired resources are backed up before deactivation; pre-install files are restored where ownership records identify them. Old runtime directories are moved into backups without inspecting their contents. Backups and private evidence remain after uninstall and can contain sensitive local material.

Legacy migration restores only recorded settings ownership, preserves differing user values, and removes only the SpecPi shell marker block before applying the new base. The installer does not enumerate or modify authentication, provider credential stores, trust, sessions, missions, history, or unrelated private evidence. Normal updates deliberately reapply the default package pins, retaining the original entry for removal. Uninstall restores only package entries that still match the last installed value; user edits are preserved. Downloaded packages and tools are not deleted. Resources that SpecPi never owned require separate human management.

## Upstream package boundary

The eight packages add their own extensions, tools, prompts, skills, network connections, filesystem operations, and subprocesses under their upstream defaults. They are not confined by the improvement loop's selection requirement. Permission System owns tool policies; SpecPi does not inject a duplicate guard or claim its coverage. Pi Lens can apply configured formatting/autofixes. Subagents and background tasks can start other processes. Web access and usage reporting can contact services and use credentials through their upstream implementations. SpecPi's local-only wishlist collection policy does not describe all activity of those packages.

Top-level versions are pinned; upstream transitive dependency ranges are not frozen by SpecPi. `doctor` reads configured pins and installed package metadata without invoking tools or validating provider access. `check:base` acquires the packages and checks combined resource loading with temporary home/configuration directories and no model prompt. Browser setup, authenticated services, OS isolation, and every upstream tool's behavior are outside that check. See [THIRD_PARTY.md](THIRD_PARTY.md) for sources and compatibility limits.

Manifests, source checkouts, Pi, dependencies, and the operating system are trusted inputs. Validation rejects unexpected managed resource paths and symlinked managed paths; it does not claim protection against another process changing files during an operation. Repository and release checks use isolated temporary Pi directories.
