# SpecPi Chat

Use [Pi](https://github.com/earendil-works/pi) from a chat beside your code in VS Code. Ask a question, attach a file or screenshot, and follow along as Pi reads, edits, and runs commands in your project.

Chat uses the models, provider accounts, and extensions you've already set up in Pi. It works with Pi alone. [SpecPi](https://github.com/TannerMidd/SpecPi) adds `/scope`, the harness improvement loop, and seven pinned packages. SpecPi Chat **0.14.0** supports that base.

## Get started

1. **Set up Pi.** Install [Pi](https://github.com/earendil-works/pi) and confirm it runs in a terminal. You can sign in to a provider there with `/login`, or let Chat open that terminal for you in step 3.
2. **Open your project.** Download the [SpecPi Chat 0.14.0 VSIX](https://github.com/TannerMidd/SpecPi/releases/download/v0.29.0/specpi-chat-0.14.0.vsix), run **Extensions: Install from VSIX…** in VS Code, then open and trust your project folder.
3. **Start chatting.** Click **SpecPi** in the Activity Bar and choose **Connect Pi**. If Pi has no provider yet, Chat says so and offers **Sign in to a provider**, which opens Pi in a terminal for `/login` and reloads Pi when you close it. Pick a model and send your first message.

Requires VS Code **1.96+**, Node.js **22.19+**, and Pi **0.84.4** for the reviewed default base. For SSH, WSL, or containers, Pi and the extension need to be installed on the workspace host. Browser-only VS Code isn't supported.

## In the chat

- **Add context:** the active editor selection appears above the composer and attaches with your next message, or attach selected code or files, type `@` to find a workspace file or folder, press **Alt+K** to insert an `@file#Lx-Ly` mention, or paste a screenshot. Folder attachments send a bounded listing of their contents. Images need a model that supports them.
- **Follow the work:** see replies and tool output as they arrive. Use **Stop** to interrupt a response.
- **Follow agents:** with [specpi-delegation](https://www.npmjs.com/package/specpi-delegation) installed in Pi, expand the agent panel above the composer for live worker activity, and stop a worker from there. Tool results show each delegated report.
- **Keep a few conversations going:** switch chats while Pi continues working in the background. Find older chats in **Chat History**.
- **Try another direction:** branch a conversation or edit an earlier prompt to start a new branch.
- **Keep your model across chats:** with a chat connected, use the pin button next to the model picker to save the current model as Pi's startup model, or the current thinking level as the global startup level. You can also pin the thinking level to this model alone, which Pi then applies whenever that model is selected, in every chat. Saving confirms first and edits only those keys in Pi's global settings, with a backup. Restart Pi (or reconnect) to pick the change up.
- **Edit permissions:** the Permissions button opens global/project settings with YOLO, logging, runtime controls, and JSON editors for all permission rules and advanced fields. Save with explicit confirmation, then restart Pi to reload this chat. Existing files are backed up; upstream remains the policy enforcer. **Show effective policy** reports the runtime settings, and reported YOLO mode stays visible.
- **Review changes:** open file references and Git diffs in your editor.
- **Sign in to a provider:** when Pi reports no usable provider, or a message fails because a provider has no credential, Chat shows what is missing and offers **Sign in to a provider**. That opens your configured Pi in a VS Code terminal so you can run Pi's own `/login` (or `/logout`), and reloads Pi afterwards so its new models appear. **SpecPi: Sign In to a Provider** does the same from the Command Palette.
- **Reload Pi:** use **Restart Pi** in the Chat title bar to reconnect the current conversation and reload its Pi extensions. Other chats keep running.

Press **Enter** to send, **Shift+Enter** for a new line, or type `/` to see available commands.

See [package support](GUIDE.md#default-package-support) for the seven packages, including commands, delegated agent activity, usage, and terminal-only settings.

## A few things to know

Provider sign-in runs in Pi's own terminal; Chat starts that terminal and reloads Pi afterwards, but never reads, stores, or sends your credentials. Chat doesn't install Pi or SpecPi, and its history only includes conversations started in Chat.

Pi can change files and run commands in your project. Chat has no automatic file undo; branching a conversation doesn't roll back code. Restart interrupts the current response and clears queued messages and pending approvals.

Chat adds no telemetry. Your messages and attachments go through Pi to your selected provider, and conversations are saved locally in VS Code's workspace storage.

**Can't connect?** Open **SpecPi: Chat Settings** and set **Pi Path** to your Pi executable. After changing your provider setup in Pi, use **Restart Pi** in Chat.

[User guide & troubleshooting](https://github.com/TannerMidd/SpecPi/blob/main/vscode/GUIDE.md) · [Report a bug](https://github.com/TannerMidd/SpecPi/issues) · [Release notes](https://github.com/TannerMidd/SpecPi/blob/main/vscode/CHANGELOG.md) · [Development](https://github.com/TannerMidd/SpecPi/blob/main/vscode/DEVELOPMENT.md)
