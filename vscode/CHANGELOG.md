# SpecPi Chat changelog

## 0.13.0

- Read a schema 1 file's command-guard preference, which the panel was taking from schema 2 alone. The advisor's 1-to-2 migration preserves the whole file and only its 2-to-3 step folds the old `guard` pair into `systems`, so both older schemas arrive carrying it &mdash; and a schema 1 file with the guard enabled therefore rendered with the box unticked, so the first save would have written the user's own choice away. The panel migrates it from either, and a test loads the same bytes through the panel and the advisor and compares.
- Track the command guard as the layer's eighth system. The panel lists it beside the other seven with a budget of its own, rather than as the two extra switches a separate package needed.
- Say where the Jev layer's API key comes from. The panel held no credential and said nothing about where one is configured, so "there is no interface for the API key" was an accurate description of it &mdash; and a person whose key was sitting in Pi's own `auth.json` had no way to learn the layer was ignoring it. The panel now lists every source the layer consults, in order, and marks the one in force. It reports presence and never a value: the host checks whether each source holds a key and the webview receives booleans, so adding or changing one stays with `/login openrouter` in Pi. No source is singled out for the command guard: it is one of the layer's systems now rather than a separate package, so the one key in force serves all eight.
- Refuse to save a layer that is on with every system off. The form fills the systems in, but the full-configuration textarea never went through it, so the state this panel exists to prevent was still one hand-edit from disk.
- Look for the key in the same place before and after a save. The post-save report resolved the agent directory differently from the load, so with a workspace-relative `PI_CODING_AGENT_DIR` pressing Save turned a correct "key in use" into "No key anywhere" &mdash; a false report caused only by saving. The report also named Pi's credential store on the direct TypeSafe API, which keeps no entry there.
- Replace the Jev layer's two switches with one. "Jev layer enabled (this session)" and "Enable the Jev layer on startup" were independent checkboxes for a pair the advisor only honours together, so ticking the first alone saved a file describing a layer that is on and never runs. The panel shows the effective state and writes both.
- Switch on the systems with the layer. Every system ships off, so enabling the layer in the panel produced a layer that runs and does nothing, with nothing saying that eight more boxes were load-bearing. Ticking the layer now ticks them, in the form and before you save, so they are visible and can be turned back off &mdash; a save that silently rewrote eight settings nobody touched would buy the same behaviour at the cost of trusting the panel. The command guard is among them and is the only one that can refuse a tool call, which the panel prose says rather than leaving to be found out.

## 0.12.0

- Make the Jev layer panel reachable. It shipped complete &mdash; fields, validation, a guarded write &mdash; and unopenable: the dialog only honours a target belonging to a package the session reports, the Jev layer was never registered as one, and the select never offered it, so every attempt was refused as a package that is not installed and the file could only be edited by hand. The panel is now registered against the advisor's own `/jev` command, which is what makes it detectable, and the target list hides packages this session does not have rather than offering a control that always errors.
- Show what the Jev layer has spent. The panel lists the call count against each budget, the total and one row per system, with how many of those calls changed anything &mdash; because "asked six times, changed nothing" is the finding a bare call count hides, and it is the finding this layer turned out to have. The numbers come from the advisor's own `usage.json`, which holds counts and nothing else: no session state, no questions, no answers. Chat reads it and never writes it, a file it cannot read leaves the panel working without it, and a layer that has never been switched on shows no calls because the advisor does not write the file until then. The counts belong to the agent directory rather than to one chat, in the same way the settings above them do, so the panel dates them and says whether that session is still running instead of implying they are this conversation's.
- Add a Jev layer panel to package settings. The master switch, the advisor's systems, the per-session call budgets and the command guard are toggles that write `<agent-dir>/specpi/jev/settings.json`, the same file the extension reads, through the same guarded transaction as every other settings target: bounded read with link and identity checks, lock, revision check, backup, atomic replace, verification, and rollback on failure.
- Track the advisor's schema 2: per-system call budgets under a session total, the three new systems, and the switch that decides whether a stuck verdict may talk to the model or only to you. A schema 1 file is migrated in the panel exactly as the advisor migrates it, and a test loads the same bytes through both and compares &mdash; a panel that showed defaults where the advisor migrates would have replaced a ceiling you chose with the one we ship, the first time you pressed save.
- Present the layer flat even though it nests on disk. The systems live under `systems`, the budgets under `budgets` and the guard under `guard`, and a nested object renders as a JSON textarea, which is the opposite of a toggle. The panel holds a flat shape and the host translates in both directions; a refused draft never reaches disk, and an unknown key is reported rather than carried, because the advisor reads an unrecognised shape as all-off and a stray key would turn the layer off later without anything having said so.
- Hold the panel to the advisor's own schema. A test asserts the switches offered are exactly the advisor's systems and that the panel's default equals the advisor's default, so the two cannot drift into a panel that saves successfully and changes nothing.
- Follow the base to eight pinned packages. The Chat docs still said six in one place and seven in another.

## 0.11.1

- Follow the default base off `pi-subagents`. The live agent panel, result cards and configuration UI for that package are removed; Chat's existing delegation support now covers the base package, `specpi-delegation`. The panel shows each worker's mode, task, elapsed time, model calls and tool calls, and its Stop button sends the package's own `/delegate cancel-worker` command — a per-worker control the fleet panel never had.
- Package settings cover web access alone. The Subagents extension-config and Pi-settings-block targets are gone, along with the "editing only the subagents block" scope note; the dialog opens only for packages the connected session actually reports.
- `/experiment` from `specpi-experiments` works through ordinary command discovery, including its editor, confirmation and notification dialogs. Experiment worktrees are opened in a separate Pi session, not inside Chat.
- Stop the provider sign-in panel from appearing while a chat is still connecting. An empty model catalogue was read as a missing credential from the moment Pi was spawned, so every startup showed "Pi has no provider credential" until the catalogue arrived and took it away again — for a connection Chat itself warns can take 90 seconds. The panel now waits for Pi to actually report its models, and a session that genuinely has no credential still raises it.

## 0.11.0

- Make provider sign-in reachable from Chat. A connected Pi that reports no usable provider, and a message that fails because the selected provider has no credential, now raise a sign-in panel naming what is missing instead of an empty model picker or Pi's raw `/login` guidance with its absolute documentation paths. **Sign in to a provider** starts the configured Pi executable in a VS Code terminal, in the chat's workspace folder and without RPC flags or a session, so Pi runs its own `/login` and `/logout`. **SpecPi: Sign In to a Provider** does the same from the Command Palette.
- Reload Pi after sign-in. Pi resolves its model catalogue once at startup and cannot see a credential stored afterwards, so closing the sign-in terminal restarts the connection and the new provider's models appear. **Reload Pi** does it on demand; a busy conversation is left running with a notice rather than restarted underneath a response.
- Keep credentials outside Chat. The extension does not read `auth.json`, run Pi's auth commands, prompt for API keys, send input to the sign-in terminal, or receive a credential over RPC. Detection uses only what Pi already reports: its available-model list and its own missing-credential error text.
- Give the Destructive guard a visible state. When the saved global configuration matches the preset's deny rules, the composer's Permissions button shows **Guard saved** with a dashed outline — **Guard saved · YOLO** if Pi also reports YOLO — instead of the plain **YOLO** label. The badge reads only the documented global config file, updates on connect and on confirmed settings changes, and its detail states that saved rules are not proof of active enforcement. YOLO continues to reflect only Pi's reported runtime status.
- Scale the footer's cache hit readout to the type around it. The percentage was two steps larger than the token, cost, and status text beside it, which made it the loudest element in the footer; the chip keeps its border and bold value but now matches the footer's own size.

## 0.10.0

- Configure installed Pi packages from Chat. A new package settings dialog edits `pi-subagents` and `pi-web-access` configuration with generated fields for the documented keys plus a full JSON editor for everything else. Targets appear only for packages the connected session reports. Each save confirms first, goes through the existing guarded transaction (lock, revision check, backup, atomic replace, verification, rollback), and refuses a draft whose file changed on disk meanwhile. Restart Pi afterwards so the package reloads.
- Subagents configuration covers both files the package reads: its own `extensions/subagent/config.json`, and the `subagents` block of the global or project Pi settings file. A settings write replaces only that block and preserves every unrelated Pi setting and its order; emptying the block removes the key. Keys this release does not recognise are kept as written rather than refused, so a configuration the package accepts can still be saved.
- Web access credentials are never shown, copied, or logged. The webview receives a placeholder and a description of how each key is supplied — stored in the file, read from an environment variable, or resolved by a local command — never a value. A credential you do not retype is written back from disk unchanged, a key you delete is removed, and a placeholder with nothing stored behind it is refused instead of being written as literal placeholder text. Saving rewrites that file, so its comments and key order are not preserved.
- Size the composer's model and thinking pickers to their labels instead of stretching the model box to a fixed width, and match their height to the icon buttons beside them. Long model names still shrink and ellipsize.

## 0.9.0

- Stop the cache hit rate and usage details from flashing back to `—` while a response streams. Partial streaming usage (providers often report only the output count between full reports) now keeps the last reported input and cache token values instead of replacing them, and tool result usage no longer overwrites the assistant request usage display.
- Save Pi's startup defaults from Chat: a pin button next to the model picker stores the current model as `defaultProvider`/`defaultModel`, the current thinking level as the global `defaultThinkingLevel`, or a per-model level (`modelThinkingLevels`) that Pi applies whenever that model is selected — and removes an existing per-model override. Each save confirms first, edits only those documented keys in Pi's global `settings.json` (honoring `PI_CODING_AGENT_DIR`, including a workspace-relative one), keeps unrelated settings and their order, and backs up the file. Pi picks the defaults up after reconnecting.

## 0.8.3

- Add a global Destructive guard preset that replaces the complete global draft instead of merging with existing settings. Preview and edit the configuration, undo locally, then use the existing confirmed Save with backup. No project or agent-policy inspection and no upstream changes.
- Make cache hit and context usage easier to read in the footer.
- Add searchable model choices and descriptive thinking-level choices, with keyboard navigation and responsive layouts.

## 0.8.2

- Always show the reported cache hit rate in the chat footer, with `—` before input usage is available and a tooltip explaining the calculation.

## 0.8.1

- Align setup and package documentation with SpecPi 0.22.1 and its six default packages, without `pi-lens`. Chat does not install or remove packages; update SpecPi separately and restart each Pi connection to unload Lens. Independent or modified Lens entries survive managed updates.
- No UI or host behavior changes.

## 0.8.0

- Edit global or project permission settings from Chat, including YOLO, logging, rules, and advanced options. Saves require confirmation and keep a backup. Restart Pi to apply the changes to the current chat.
- Update the setup guide for SpecPi 0.22.0 and its seven default packages. Chat does not install or remove packages.

## 0.7.1

- Bump the VSIX version and update install examples for the SpecPi 0.21.0 base.
- Resolve custom Pi state directories with the same native path resolver used for attachments and navigation, preserving privacy checks through Windows drive aliases. Make temporary-path fixtures portable across Windows and macOS runners.

## 0.7.0

- Keep SpecPi Chat as the VS Code frontend for SpecPi 0.21.0 and its eight upstream packages. Preserve chat, attachments, history, model controls, and separate VSIX packaging.
- Replace the retired Command Guard mode picker with a read-only Permission System settings button. Show reported YOLO status and preserve complete multiline approval context; oversized requests are cancelled without approval.
- Render visible custom messages from all packages, including background-task and goal updates, while preserving hidden-message choices. Keep generic tools, images, widgets, commands, and usage reporting on Pi's RPC transport.

- Show pi-subagents in the live agent panel, including foreground and background agents, model, thinking level, elapsed time, token usage, and overflow counts. Clear activity when work ends or the connection changes.
- Show individual agent cards in streamed and saved `subagent` results, including parallel and chain progress, failed or stopped children, and background handoffs. Keep the original tool output below the cards.
- Preserve visible pi-subagents completion notices and slash-command text in live and restored conversations, respecting the package's hidden-message setting.
- Include a read-only adapter that registers no tools or commands and leaves Pi configuration unchanged. Live activity requires the `fleetStatus` v1 capability, reviewed against pi-subagents 0.67.0's published contract; older packages retain tool-result cards and text. The live list provides no per-agent controls.

## 0.6.0

- Show Command Guard's mode on a shield beside the composer and change it from a picker, without typing `/guard`. **SpecPi: Choose Command Guard Mode** opens the same picker from the Command Palette. A locked session offers **Unlock** instead of a mode.
- Keep Command Guard the authority: Chat asks Pi to run the `/guard` command, and the harness still confirms every change that weakens protection and names the critical rule before unlocking. The shield appears only while a connected session reports a mode.

## 0.5.1

- Name the provider beside each model in the composer's model selector, so the active provider is visible without hovering. The model name stays first, and the existing `provider / id` tooltip is unchanged.

## 0.5.0

- Offer the active editor selection above the composer as a toggleable context chip. The exact selected characters are read and attached when you send, and clicking the chip hides it from the next message. Each conversation remembers whether the chip is included. Selection-validation failures restore the draft, and changed documents or connections cannot send stale selection context.
- Insert `@file#Lx-Ly` mentions from the editor with **Alt+K** (or the editor context menu), including folder mentions that keep the trailing slash.
- Respect `files.exclude`, `search.exclude`, and the workspace-root `.gitignore` in `@` file suggestions and shortened chat-link search. Explicit attachment of an ignored file or folder remains available.
- Attach folders from `@` suggestions, mentions, or the Explorer context menu as a bounded directory-listing snapshot (200 entries / 16 KiB, scanning at most 1,000 entries including hidden entries, with an explicit truncation note) instead of reading every file. Sensitive paths are never listed, and Pi still reads folder files through its own tools.
- Validate and bound ignore-file reads, reject linked or special files, and use non-backtracking glob matching with an explicit work limit. Preserve valid rules when a character class is malformed, respect Git ancestor-negation semantics, and treat false VS Code exclusions as same-key overrides only.

## 0.4.4

- Use VS Code's targeted file search for shortened chat links, removing the workspace traversal limit that prevented navigation in large projects. Preserve exact-path priority, unique matching, source positions, and file safety checks.
- Keep the selected file's full `@path` in the composer after accepting a file mention.
- Update the conversation price as Pi reports response usage, without counting repeated usage snapshots twice or waiting for the full agent run to finish.

## 0.4.3

- Refresh extension documentation.

## 0.4.2

- Resolve shortened chat file links such as `utils/helper.ts` to a unique nested workspace file while preserving line and column positions. Exact paths take priority; ambiguous matches and misspelled filenames produce actionable errors. Search is bounded and excludes private directories and symlinks, with existing file safety checks retained.

## 0.4.1

- Open workspace PNG, JPEG, GIF and WebP links in the image viewer instead of trying to open them as text. Normal Markdown links and inline file references use the same validated preview path as Markdown images; remote links still open externally.

- Replace the persistent Delegates panel with a compact activity strip that appears only while workers run or settle. Expand it for tasks and Stop controls; finished workers leave the strip and their reports stay in the conversation. Hide totals and boilerplate from the default view, preserve drafts and keyboard focus, and respect reduced motion.

## 0.4.0

- With the updated SpecPi harness, new Chat sessions start with Command Guard off. Use `/guard guard` or `/guard strict` to enable it for that session.

- Add a live Delegates panel with expandable tasks, states, model/tool counters, elapsed time and attempt-bound Stop controls. Keep stopping distinct from settlement, show advisory completion summaries, and render delegate reports readably rather than as raw JSON. Live metadata requires the updated SpecPi harness; no provider polling or child-history store is added.

- Keep sent workspace file and selection attachments, including `@` mentions, in compact transcript tags instead of displaying their full source text. Preserve the context sent to Pi and reconstruct tags when reopening conversations.

## 0.3.7

- Keep runtime/status panels in the composer's bounded column on wide sidebars, and center the transcript independently of its scrollbar. Preserve drafts and open status details while resizing.
- Remove unused standalone view, history and conversation-branching paths; retain the coordinator-owned conversation lifecycle without intended user-facing behavior changes.
- Exercise cancellation, source/target error ownership, image restoration and stale responses through the supported coordinator in regression tests.

## 0.3.6

- Rewrite the Marketplace overview with a quick start, screenshot, and plain-language feature descriptions. Move detailed help and development instructions to separate guides, and clarify that SpecPi is optional.

## 0.3.5

- Add Restart Pi to the Chat title bar and Command Palette to reconnect the selected conversation and reload its Pi extensions while other chats keep running.

## 0.3.4

- Include the SpecPi logo as a 256×256 PNG and declare it in the extension and VSIX manifests so Marketplace and VS Code display the logo.

## 0.3.3

- Set the VSIX public-listing flag for Marketplace publication, add installation instructions, and document manual publication of the validated VSIX.

## 0.3.2

- Expand tool calls by default so progress, results, and images are visible without an extra click. Preserve manual collapse/expand choices during streaming and completion.

## 0.3.1

- Increase chat/composer text to a 14px minimum, limits/code to 13px, and secondary labels to 12px. Respect larger host font sizes and let footer controls wrap rather than overlap in narrow sidebars.
- Add a compact, expandable provider Limits row for installed Codex Usage and pi-usage plugins (including Anthropic). Preserve plugin-reported semantics, strip terminal controls, isolate live conversation updates, and clear obsolete connection reports without adding provider queries or packages.
- Expand thinking blocks by default while preserving manual collapse/expand choices during streaming; tool blocks remain collapsed by default.
- Fix `/model` selection while retaining the composer send lock and rejecting overlapping prompts or stale picker results.
- Allow read-only usage details during active responses, retries, compaction, and queued sends, without querying a connection before readiness.
- Prevent failed Stop cleanup from reporting an obsolete error into a reconnected conversation.
- Allow ordinary source names such as `auth.ts`, `history.js`, and `sessions.py` in attachments, editor selections, code links, and file suggestions. Scope Pi-state names to Pi/Chat storage while retaining global credential/key filtering and canonical-path checks.
- Align the README, Pages guide, and VSIX installation examples with the release package; run the rendered Chat suite in CI.

## 0.3.0

- Replace the native history selection sequence with a searchable sidebar picker, date groups, conversation activity, inline rename, and reversible archive/restore.
- Preserve live Pi processes when switching conversations or workspace folders. Keep each conversation's responses, approvals, attachments, draft, usage, and scroll position separate. Stop and Disconnect target the selected conversation.
- Create conversation branches through separate Pi processes without changing the original conversation. New drafts and restored prompts require an explicit send.

## 0.2.1

- Display Pi's reported conversation cost beside context/token usage in the compact footer. Preserve zero and small positive amounts, update with session statistics, and show the detailed USD amount on hover or through Usage details.

## 0.2.0

- Attach validated PNG, JPEG, GIF, and WebP images through the native picker, screenshot paste, and file drop. Support image-only and mixed prompts, preserve failed drafts, require an image-capable model, and reject image-bearing slash commands that Pi would otherwise ignore.
- Render user and tool images, restore them from owned history, and preview clicked workspace Markdown images. Keep media caches in memory, reuse media identifiers during streaming, and forbid remote image requests in the webview.
- Bound images to eight mixed attachments, 5 MiB per image, 20 MiB per prompt, 16,384 pixels per side, and 40 million pixels. Bound visible transcript images to 32 / 20 MiB and JSONL records and buffered writes to 64 MiB.
- Recover exactly matched queued image drafts through an explicit restore action after Stop; explain unmatched or ambiguous recovery without automatically sending or reusing images.
- Add conversation branching, earlier-prompt editing that preserves text and images, visible Markdown copy/export, transcript search, workspace `@` file selection, and reported token/cache/cost/context usage.
- Open explicitly selected working-tree and staged changes through VS Code's native Git diff views. Conversation actions do not create file checkpoints or roll back workspace files.
- Extend isolated transport, controller, rendering, and native extension-host coverage for these workflows. Final 0.2.0 verification is recorded in the implementation plan after the release checks finish.

## 0.1.3

- Reset transient run state when a connection ends so an interrupted chat reconnects and accepts messages normally.
- Keep prompt acceptance separate from later refresh errors. Refresh status never restores or replays an accepted message, and stale refreshes cannot clear newer errors.
- Include Pi's supported `max` thinking level.
- Keep the composer toolbar stable during streaming; move timing and Stop controls into the existing footer.
- Open clicked workspace file references at their specified editor line, column, or line range. Validate local paths independently of rendered Markdown.
- Document supported attachments and the current lack of image upload, clipboard-image, and inline-image support.

## 0.1.2

- Compact the composer into a single-line input and one toolbar. The input grows with multiline text, shrinks when cleared or sent, and keeps a bounded scrolling height.
- Show follow-up timing and input-limit guidance only when relevant; preserve keyboard help and accessible control labels.

## 0.1.1

- Fix connection timeouts with older SpecPi Guard installations by waiting up to 90 seconds for Pi's RPC startup before sending normal chat requests. Subsequent requests keep their existing deadlines.
- Explain startup delays and cancel early dialogs without approval or an unverified mode selection. Use `/guard` after connecting to choose a mode.
- Show connection progress and a Cancel action. Cancelling startup restores the unsent draft and prevents it from being sent by a later reconnect.
- Exercise the installed Pi launch path and reproduce delayed startup with the real bundled Pi runtime in an isolated profile.

## 0.1.0

- Initial local VSIX preview with a native VS Code Activity Bar chat view.
- Connect an existing Pi installation, stream replies and tool activity, attach editor context, and manage extension-owned conversations.
- Integrate VS Code theme colors, keyboard navigation, workspace trust, and explicit connection controls.
- Package without runtime dependencies; no telemetry or Marketplace publishing.
