# SpecPi Chat guide

For a quick start, see the [overview](README.md). This guide covers the controls, limits, and troubleshooting in more detail. Build, test, and publishing instructions are in the [development guide](DEVELOPMENT.md).

## Set up

1. Install Node.js **22.19 or newer** and Pi **0.84.4 or newer** on the machine running your VS Code workspace. SpecPi is optional; install it to add Command Guard and its workflow commands. Follow the [SpecPi setup guide](https://github.com/TannerMidd/SpecPi#readme). Configure your provider through Pi in a terminal, and confirm Pi works in the intended folder.
2. Use VS Code **1.96 or newer**. Open and trust a filesystem workspace.
3. Install **SpecPi Chat** by **tannermidd** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tannermidd.specpi-chat), or run:

   ```sh
   code --install-extension tannermidd.specpi-chat
   ```

4. Open **SpecPi** in the Activity Bar, or press **Ctrl+Alt+S** (**Cmd+Alt+S** on macOS). Choose **Connect Pi**.

To install a package built from this repository instead, run:

```sh
npm --prefix vscode run package
code --install-extension .specpi-test/vscode/specpi-chat-0.4.1.vsix
```

You can also run **Extensions: Install from VSIX…** in VS Code and select that file.

If Pi cannot be found, open **SpecPi: Chat Settings** and set `specpi.chat.piPath` to its absolute executable or JavaScript CLI path. For JavaScript entry points, `specpi.chat.nodePath` can select your external Node.js executable. Empty settings discover Pi and Node on PATH. These are application settings; repository settings cannot choose an executable. Supply a path, with no additional command arguments.

On Windows, ordinary npm Pi launchers are resolved to their adjacent JavaScript entry point. Custom PowerShell launchers and arbitrary shell commands are unsupported. If automatic resolution fails, choose the installed Pi package's CLI JavaScript file explicitly.

For SSH, WSL, or containers, install the extension in the remote workspace and configure Pi and Node on that host. Browser-only VS Code and virtual filesystems are unsupported.

## Work in the sidebar

Use SpecPi 0.15.0 or the harness from this checkout to obtain its RPC startup and report-dialog fixes. Inspect `node scripts/specpi.mjs plan` from the repository root, then run the appropriate confirmed `install` or `update` command and reconnect the sidebar. Installing this VSIX alone does not update managed SpecPi files. With an older harness, connecting may take about 30 seconds while Guard's startup prompt expires. Chat 0.1.1 and newer wait for this fallback; startup dialogs are cancelled without approving an action or choosing a mode. After connecting, use `/guard` to choose a mode. Updating the harness removes the Guard startup delay and enables the RPC report controls.

- **Send a message:** use Enter to send and Shift+Enter for a new line. Pick an available model and thinking level before sending.
- **Add context:** select code and use **SpecPi: Attach Selection to Chat**, choose a file through the attachment controls, type `@` to find a workspace file, or drop a workspace file reference into the composer. A file suggestion lists names; selecting one attaches its validated contents. Review or remove attachments before sending.
- **Add images:** choose PNG, JPEG, GIF, or WebP files with the image picker, paste a screenshot, or drop image files into the composer. The image picker can read explicitly selected images outside the workspace. Choose a model with image support, then send a normal message with or without text. Images stay attached when model validation fails. Pi slash commands reject image attachments because those commands do not consume them.
- **Follow work:** replies stream into the transcript. Thinking and tool blocks start expanded, including tool results and images. Manual collapse/expand choices are preserved during streaming and completion. Stop interrupts the current response. During a response, choose whether your next message should steer the current work or follow afterward.
- **Choose Guard mode:** with SpecPi 0.18.0 or newer, new Chat sessions start with Command Guard off. Use `/guard guard` or `/guard strict` to enable it, and `/guard status` to inspect it. The choice applies to that session; a new session starts off again. Update the harness and restart Pi to pick up this default.
- **Follow delegates:** in Chat 0.4.1 or newer, a compact **agent activity** strip appears above the composer only while workers are running or still settling. Expand it for live tasks, models, elapsed time, call counts and worker controls. It disappears when the last worker settles; completed or accepted workers do not stay above the composer. Live metadata requires SpecPi 0.18.0 or newer; use SpecPi 0.19.1 or newer for the cached-model and GitHub Copilot switching fixes. **Stop** beside a worker targets that exact attempt without sending or clearing your draft; **Stopping** retains its occupied slot until Pi reports settlement. This does not prove remote execution ended. Parent response Stop is separate and does not automatically stop independent workers. Results are advisory, not verified completion. Completion summaries stay in memory for the connection (up to 32 replayable notices); saved delegate tool reports remain readable on reopening, but live workers are not reconstructed from history. Update both the harness and Chat and restart Pi for the live panel; older harnesses retain generic status output.
- **Use Pi commands:** commands exposed by your installed Pi extensions appear in the command picker. `/help` shows local help without connecting, `/new` creates a conversation, and `/compact` asks Pi to compact the current context.
- **Manage conversations:** open Chat History to search conversations in the selected workspace, see which are running or waiting for input, and rename or archive a row directly. The Archived tab lets you restore conversations. Switching chats preserves their Pi processes, drafts, attachments, and scroll position; responses continue in the background. New Chat opens a blank draft and starts Pi when you connect or send.
- **Branch or edit a prompt:** **Branch Conversation** clones the current conversation. **Edit an Earlier Prompt** creates a branch before the selected user message and restores its exact text and images to the composer for review. Neither action sends the draft automatically or rolls back code files.
- **Find, copy, or export:** use **Ctrl+F** (**Cmd+F** on macOS) to search the displayed conversation. Copy Conversation copies its visible Markdown; Export Conversation opens an unsaved Markdown document in VS Code. Images appear as placeholders, and truncated earlier content is not reconstructed.
- **Inspect usage:** The footer shows Pi's reported conversation cost in USD beside context/token usage. It updates after completed turns and when switching conversations; hover for the detailed amount or click for Session Usage, including input/output and cache tokens. Missing costs remain hidden rather than displaying zero. Context usage remains unavailable when Pi has no fresh measurement after compaction.
- **Provider limits:** a compact **Limits** row appears above the composer when installed usage plugins report data. It supports `@llblab/pi-codex-usage` and `@sreetej510/pi-usage` (including Anthropic), with keyboard-expandable details and source labels. These are plugin-reported subscription/rate-limit budgets, not conversation cost. Codex's bar/remaining budget and pi-usage's used percentages keep their original meaning; reports are not combined or converted. Loading, errors, unavailable values, cached ages, and resets remain as reported by each plugin. With pi-usage installed, send `/usage` or `/usage --refresh` in the composer for its reports. The sidebar does not query providers, read authentication or usage-cache files, automatically consume banked resets, or reproduce terminal-only custom footers. Updates belong to their live conversation and are cleared on disconnect/reconnect. No plugin is installed by the VSIX, and the default SpecPi package list is unchanged.
- **Review edits:** Review Changes lists working-tree, staged, untracked, and conflicted files through VS Code's Git integration and opens the selected change in the native editor or diff view. It does not stage, commit, or restore files.
- **Open code references:** click a file reference such as `src/app.ts:12:3` or `src/app.ts#L12-L18` to reveal that location in the editor. Markdown links and inline code references work; plain file-and-line references are also detected. Targets must be regular, non-sensitive files inside the selected workspace. References inside fenced code examples remain copyable source text.
- **Switch folders:** use **SpecPi: Choose Chat Workspace** in a multi-folder workspace. Each folder has its own history; changing folders preserves the conversations already running elsewhere.
- **Disconnect:** use **SpecPi: Disconnect Pi** to stop the selected conversation's process. Other conversations keep running. Reconnect to continue; closing the VS Code extension host stops all its Pi processes.
- **Restart:** click **Restart Pi** in the Chat title bar or run **SpecPi: Restart Pi** from the Command Palette to stop and reconnect the selected chat's Pi process, reloading its extensions and resuming its saved conversation. This interrupts any active response and clears queued sends and pending approval dialogs. Unsent composer text and attachments stay in the chat; other conversations keep running.

Pi extensions can request confirmation, selection, or text input through the sidebar. Responses go back to the requesting conversation's Pi process. A background conversation appears as needing input in history; open it to respond. Switching away does not approve or cancel the request. A cancelled or timed-out dialog does not silently grant approval.

Stop clears queued work before aborting the active response. Pi returns only the text of cleared queue entries. Chat retains image snapshots for accepted queued prompts, with at most eight images / 20 MiB across pending and recovered drafts, and offers an explicit restore action when a returned entry matches exactly. It does not guess when text was transformed or a match is ambiguous; the sidebar explains when an image draft cannot be recovered. Restoring does not send it, and a later unrelated message does not inherit those images.

## Supported content and controls

| Capability | Support in this preview |
| --- | --- |
| Text, Markdown, code blocks, tables, HTTP(S) links | Yes; model output is rendered without executing HTML. |
| Text/code attachments and editor selections | UTF-8 text, 64 KiB per attachment, inside the selected workspace; up to eight attachments total, including images. |
| File, line, column, and line-range references | Yes; click to open the validated workspace file in VS Code. |
| Image attachments, pasted screenshots, and image drag-and-drop | PNG, JPEG, GIF, and WebP; image-only or mixed messages; an image-capable Pi model is required. |
| Inline images and Markdown image previews | Validated Pi image blocks render inline. Click a local image reference, ordinary Markdown link, or inline PNG/JPEG/GIF/WebP filename to preview a validated workspace image rather than open it as text. External image URLs open through the browser link action; Chat does not fetch them. |
| Models and thinking levels | Pi's available options, including `max` when supported by the selected model. |
| Streaming, tools, approvals, Stop, steering, and follow-ups | Yes, through the local Pi runtime. |
| Chat history, branching, and earlier-prompt editing | Searchable extension-owned conversations, rename, archive/restore, and independent live processes. Editing restores a draft on a new conversation branch and leaves code files as they are. |
| Search, copy, export, and usage | Search the visible transcript, copy/export visible Markdown, and see Pi's reported conversation cost beside context/token usage in the footer. Hover or click it for details; image bytes are omitted from exports. |
| Native diff review | Working-tree and staged Git changes, with explicit selection before opening a diff or file. |
| Inline completions and file checkpoints | Not implemented; there is no automatic file undo or checkpoint restore. |

Each image is limited to **5 MiB**, **16,384 pixels per side**, and **40 million pixels**. A message accepts at most **eight mixed attachments** and **20 MiB of image bytes**. The visible transcript retains at most **32 images / 20 MiB**; omitted images receive a display notice. These limits apply before base64 expansion. Pi and individual providers can impose narrower format or image-count limits.

The RPC connection accepts JSON records up to **64 MiB** and buffers at most **64 MiB** of pending writes. A very large image-bearing Pi history can exceed the response limit even when each original prompt was within the attachment limit. Recognized oversized history responses are drained without disconnecting Pi; the sidebar explains that older messages could not be loaded, and you can continue, compact, or start a new chat. Editing a prompt from an oversized history reports the limit without changing the conversation.

## Privacy and boundaries

The sidebar starts Pi as a child process over its local JSON-lines RPC interface. Pi owns provider authentication, provider requests, tools, and SpecPi enforcement. Chat messages and attached content are sent to Pi and may be sent by Pi to your configured provider. The extension does not store or inspect provider credentials.

Opening the view does not start Pi. Connecting or sending a message does. Trusted-workspace access is required because Pi can read and change files and execute tools in the selected workspace. The extension does not replace Pi's tool policies or Command Guard.

Only conversations created through this extension appear in Chat History. Pi writes those transcripts under VS Code's workspace storage, separate from its ordinary session directory. The extension keeps a bounded index of its own session references and retrieves conversation messages through Pi RPC. It does not enumerate or import your existing Pi terminal history. **Archive** hides a conversation from the main list without deleting its file or stopping its process; restore it from the Archived tab. VS Code can retain extension storage after uninstall.

Text/code attachments and file references are restricted to the selected workspace. Explicit image selection, pasted screenshots, and dropped image files may come from outside it; image file paths still undergo regular-file and sensitive-path checks. Image bytes are checked against supported formats, dimensions, and size limits. Attachments are snapshots for the user to review, not a content-based secret detector. Pi itself may read other files while completing your request.

Draft images and display media caches remain in memory. Sent images become part of Pi's extension-owned conversation files and may be sent to the configured provider. The webview receives media by identifier, renders validated data images under `img-src data:`, and does not fetch remote images, scripts, or styles. Model output never executes as HTML. There is no extension telemetry or transcript logging to an output channel. Copy and Export are explicit ways to move the visible conversation into the clipboard or a document.

## Current limits

- Pi must already be installed and configured. SpecPi is optional. The sidebar does not install packages, sign in to providers, or change Pi settings.
- Pi's RPC dialog methods are supported; custom terminal UIs, overlays, and TUI-only commands do not run inside VS Code.
- This preview does not provide inline ghost text, an apply-patch approval editor, file checkpoints or undo, or import of existing terminal conversations. Conversation branching changes chat history; it does not restore the worktree. Pi tools still perform workspace edits through the existing harness.
- Each connected conversation keeps its own Pi process until explicitly disconnected or the extension host closes. Conversations can run concurrently in the same workspace; their tools operate on that shared workspace. Unsent drafts remain in memory for the current extension-host lifetime.
- Model and reasoning choices depend on the connected Pi installation and provider. A successful local test does not establish that a provider is configured or reachable.
- Image format, animation, and vision behavior vary by provider. Passing local validation establishes the sidebar's transport boundary, not provider support for every accepted image.
- Remote workspace execution follows VS Code's extension-host model; the host and Pi must have access to the intended workspace filesystem.

## Connection troubleshooting

If Pi works in the terminal but Chat 0.1.0 reports **Pi did not respond to get_state in time**, install the latest VSIX from the setup steps above and reload VS Code when prompted. Older SpecPi Guard versions wait 30 seconds for a startup selection before Pi begins reading RPC requests, which conflicts with 0.1.0's 30-second request timeout. Chat now gives startup up to 90 seconds while keeping normal request timeouts at 30 seconds.

The sidebar explains the startup delay and allows cancellation. If startup still times out, update the harness from this checkout and check whether another installed Pi extension waits for a startup dialog. Pi 0.84.4 cannot read dialog responses until its startup handlers return; an extension that waits indefinitely must implement an RPC-compatible startup path. The sidebar does not bypass extension policies or grant startup approvals.

If a message was accepted but the subsequent status refresh failed, use **Refresh status**. This only retrieves the current conversation and does not send the message again. A dropped connection before Pi acknowledges a prompt leaves its outcome uncertain; inspect the resumed conversation before deciding whether to send it again.
