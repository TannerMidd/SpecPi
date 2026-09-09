# SpecPi Chat changelog

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
