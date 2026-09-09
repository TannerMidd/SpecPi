# SpecPi Chat

Use [Pi](https://github.com/earendil-works/pi) from a chat beside your code in VS Code. Ask a question, attach a file or screenshot, and follow along as Pi reads, edits, and runs commands in your project.

Chat uses the models, provider accounts, and extensions you've already set up in Pi. It works with Pi alone. [SpecPi](https://github.com/TannerMidd/SpecPi) is optional and adds Command Guard and workflow commands.

![SpecPi Chat open beside a JavaScript file in VS Code](https://raw.githubusercontent.com/TannerMidd/SpecPi/main/site/media/specpi-chat.png)

## Get started

1. **Set up Pi.** Install [Pi](https://github.com/earendil-works/pi), run it in a terminal, and use `/login` to connect your provider. Confirm you can send a message there first.
2. **Open your project.** Install SpecPi Chat in VS Code, then open and trust your project folder.
3. **Start chatting.** Click **SpecPi** in the Activity Bar and choose **Connect Pi**. Pick a model and send your first message.

Requires VS Code **1.96+**, Node.js **22.19+**, and Pi **0.84.4+**. For SSH, WSL, or containers, Pi and the extension need to be installed on the workspace host. Browser-only VS Code isn't supported.

## In the chat

- **Add context:** the active editor selection appears above the composer and attaches with your next message, or attach selected code or files, type `@` to find a workspace file or folder, press **Alt+K** to insert an `@file#Lx-Ly` mention, or paste a screenshot. Folder attachments send a bounded listing of their contents. Images need a model that supports them.
- **Follow the work:** see replies and tool output as they arrive. Use **Stop** to interrupt a response.
- **Keep a few conversations going:** switch chats while Pi continues working in the background. Find older chats in **Chat History**.
- **Try another direction:** branch a conversation or edit an earlier prompt to start a new branch.
- **Review changes:** open file references and Git diffs in your editor.
- **Reload Pi:** use **Restart Pi** in the Chat title bar to reconnect the current conversation and reload its Pi extensions. Other chats keep running.

Press **Enter** to send, **Shift+Enter** for a new line, or type `/` to see available commands.

## A few things to know

Provider sign-in happens in Pi's terminal. Chat doesn't install Pi or SpecPi, and its history only includes conversations started in Chat.

Pi can change files and run commands in your project. Chat has no automatic file undo; branching a conversation doesn't roll back code. Restart interrupts the current response and clears queued messages and pending approvals.

Chat adds no telemetry. Your messages and attachments go through Pi to your selected provider, and conversations are saved locally in VS Code's workspace storage.

**Can't connect?** Open **SpecPi: Chat Settings** and set **Pi Path** to your Pi executable. After changing your provider setup in Pi, use **Restart Pi** in Chat.

[User guide & troubleshooting](https://github.com/TannerMidd/SpecPi/blob/main/vscode/GUIDE.md) · [Report a bug](https://github.com/TannerMidd/SpecPi/issues) · [Release notes](https://github.com/TannerMidd/SpecPi/blob/main/vscode/CHANGELOG.md) · [Development](https://github.com/TannerMidd/SpecPi/blob/main/vscode/DEVELOPMENT.md)
