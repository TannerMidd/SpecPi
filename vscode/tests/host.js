"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function until(predicate, description, timeout = 15000) {
    const start = Date.now();
    while (!(await predicate())) {
        if (Date.now() - start > timeout) {
            throw new Error(`Timed out waiting for ${description}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 30));
    }
}

async function run() {
    const directory = process.env.SPECPI_VSCODE_TEST_DIRECTORY;
    assert.ok(directory, "host tests run only in the isolated runner");
    assert.equal(path.dirname(process.env.PI_CODING_AGENT_DIR), directory);
    const checks = [];
    const result = { passed: false, checks };
    let controller;
    try {
        const extension = vscode.extensions.getExtension("tannermidd.specpi-chat");
        assert.ok(extension, "VS Code discovers the extension manifest");
        ({ controller } = await extension.activate());
        assert.ok(controller, "activation exposes the chat controller");
        let webviewReady = false;
        const handleMessage = controller.handleMessage.bind(controller);
        controller.handleMessage = async (message) => {
            if (message?.type === "ready") {
                webviewReady = true;
            }

            return handleMessage(message);
        };

        assert.equal(controller.state.status, "disconnected");
        assert.equal(controller.client, null, "activation does not launch an agent");
        assert.deepEqual(fs.readdirSync(process.env.PI_CODING_AGENT_DIR), []);
        checks.push("activation stays disconnected");

        const commands = await vscode.commands.getCommands(true);
        for (const contribution of extension.packageJSON.contributes.commands) {
            assert.ok(commands.includes(contribution.command), `${contribution.command} is registered`);
        }

        await vscode.commands.executeCommand("specpi.chat.open");
        await until(() => controller.view, "native sidebar view");
        assert.equal(controller.view.webview.options.enableScripts, true);
        assert.match(controller.view.webview.html, /Content-Security-Policy/);
        await until(() => webviewReady, "packaged webview JavaScript ready handshake");
        checks.push("native view, executable webview, and command registration");

        const workspace = vscode.workspace.workspaceFolders[0].uri;
        const file = vscode.Uri.joinPath(workspace, "example.js");
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 0, 0, 12);
        await vscode.commands.executeCommand("specpi.chat.attachSelection");
        assert.equal(controller.state.attachments.length, 1);
        await vscode.commands.executeCommand("specpi.chat.attachFile", file);
        assert.equal(controller.state.attachments.length, 2);
        assert.equal(controller.client, null, "attachments alone do not connect");
        checks.push("editor selection and Explorer file attachment");

        const targetFile = vscode.Uri.joinPath(workspace, "navigation target.js");
        fs.writeFileSync(targetFile.fsPath, "// Navigation fixture\nconst target = true;\n// End\n");
        await controller.handleMessage({ type: "openCode", reference: "navigation target.js:2:7" });
        assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, targetFile.fsPath);
        assert.equal(vscode.window.activeTextEditor.selection.start.line, 1);
        assert.equal(vscode.window.activeTextEditor.selection.start.character, 6);
        await controller.handleMessage({ type: "openCode", reference: "navigation target.js#L2-L3" });
        assert.equal(vscode.window.activeTextEditor.selection.start.line, 1);
        assert.equal(vscode.window.activeTextEditor.selection.end.line, 2);
        checks.push("workspace file references open exact editor lines and ranges");

        await vscode.commands.executeCommand("specpi.chat.connect");
        assert.equal(controller.state.status, "ready", controller.state.error);
        assert.equal(controller.state.model.id, "fixture-model");
        assert.equal(controller.state.models.length, 2);
        assert.deepEqual(controller.state.model.input, ["text", "image"]);
        assert.ok(controller.state.commands.some((command) => command.name === "fixture"));
        await controller.handleMessage({ type: "setThinking", level: "max" });
        assert.equal(controller.state.thinkingLevel, "max");
        await controller.handleMessage({ type: "setThinking", level: "medium" });
        assert.equal(controller.state.thinkingLevel, "medium");
        await controller.handleMessage({ type: "setModel", provider: "fixture", modelId: "fixture-model" });
        checks.push("RPC connection and model controls");

        await controller.handleMessage({ type: "send", text: "Explain this fixture.", mode: "prompt" });
        await until(
            () =>
                controller.state.status === "ready" &&
                controller.state.messages.some(
                    (message) => message.role === "assistant" && message.text.includes("Fixture response complete"),
                ),
            "streamed assistant reply",
        );
        assert.equal(controller.state.attachments.length, 0);
        const sentMessage = controller.state.messages.find((message) => message.role === "user");
        assert.equal(sentMessage.text, "Explain this fixture.");
        assert.equal(sentMessage.files.length, 2);
        assert.ok(sentMessage.files.every((file) => file.label.startsWith("example.js")));
        assert.ok(sentMessage.files.every((file) => !Object.hasOwn(file, "text")));
        const sentHistory = JSON.stringify(await controller.client.request("get_messages"));
        assert.ok(sentHistory.includes("User-selected file context 1:"));
        assert.ok(sentHistory.includes("export const greeting"), "Pi must still receive the attached source");
        assert.ok(controller.state.messages.some((message) => message.role === "tool"));
        await until(async () => (await controller.catalog.list()).length === 1, "owned session catalog");
        assert.deepEqual(
            fs.readdirSync(process.env.PI_CODING_AGENT_DIR),
            [],
            "the fixture leaves Pi global state untouched",
        );
        checks.push("streaming, tool activity, and owned-session retention");

        const previousClient = controller.client;
        const previousSessionId = controller.activeSessionId;
        await vscode.commands.executeCommand("specpi.chat.restart");
        assert.equal(controller.state.status, "ready", controller.state.error);
        assert.notEqual(controller.client, previousClient);
        assert.equal(controller.activeSessionId, previousSessionId);
        assert.ok(controller.state.messages.some((message) => message.text.includes("Fixture response complete")));
        checks.push("Restart Pi command reconnects and resumes the selected conversation");

        const imageFile = vscode.Uri.joinPath(workspace, "fixture image.png");
        fs.writeFileSync(imageFile.fsPath, Buffer.from(PNG_DATA, "base64"));
        await controller.attachImage(imageFile);
        assert.equal(controller.state.attachments.length, 1);
        assert.equal(controller.state.attachments[0].kind, "image");
        assert.equal(controller.state.attachments[0].width, 1);
        assert.equal(controller.state.attachments[0].height, 1);
        await controller.handleMessage({ type: "setModel", provider: "fixture", modelId: "fixture-text-model" });
        assert.deepEqual(controller.state.model.input, ["text"]);
        const beforeRejectedImage = await controller.client.request("get_messages");
        await controller.handleMessage({ type: "send", text: "Describe the attached image.", mode: "prompt" });
        assert.match(controller.state.error, /Choose a model that supports images/u);
        assert.equal(controller.state.attachments.length, 1, "unsupported-model sends retain their image");
        assert.deepEqual(await controller.client.request("get_messages"), beforeRejectedImage);
        await controller.handleMessage({ type: "setModel", provider: "fixture", modelId: "fixture-model" });
        await controller.handleMessage({ type: "send", text: "", mode: "prompt" });
        await until(() => controller.state.status === "ready", "image-only response");
        assert.equal(controller.state.attachments.length, 0);
        assert.ok(
            controller.state.messages.some(
                (message) => message.role === "user" && message.images?.[0]?.data === PNG_DATA,
            ),
        );
        assert.ok(
            controller.state.messages.some(
                (message) => message.role === "tool" && message.images?.[0]?.data === PNG_DATA,
            ),
        );
        const imageOnlyMessages = (await controller.client.request("get_messages")).messages;
        const imageOnlyUser = imageOnlyMessages.find(
            (message) => message.role === "user" && message.content.some((part) => part.type === "image"),
        );
        assert.deepEqual(
            imageOnlyUser.content.find((part) => part.type === "image"),
            { type: "image", mimeType: "image/png", data: PNG_DATA },
        );
        assert.equal(imageOnlyUser.content.find((part) => part.type === "text").text.trim(), "");
        checks.push("native image attachment, unsupported-model recovery, image-only RPC, and tool images");

        await controller.attachImage(imageFile);
        await controller.handleMessage({ type: "send", text: "Describe this fixture image.", mode: "prompt" });
        await until(() => controller.state.status === "ready", "mixed text and image response");
        const mixedMessages = (await controller.client.request("get_messages")).messages;
        const mixedUser = mixedMessages.find(
            (message) =>
                message.role === "user" &&
                message.content.some((part) => part.type === "text" && part.text === "Describe this fixture image."),
        );
        assert.deepEqual(
            mixedUser.content.find((part) => part.type === "image"),
            { type: "image", mimeType: "image/png", data: PNG_DATA },
        );
        assert.equal(controller.state.attachments.length, 0);
        const imageSessionId = controller.activeSessionId;
        assert.ok(imageSessionId);
        checks.push("mixed text and validated image data reach the native RPC peer");

        await controller.handleMessage({ type: "send", text: "hold response", mode: "prompt" });
        await until(() => controller.state.status === "busy", "busy response");
        await vscode.commands.executeCommand("specpi.chat.stop");
        await until(() => controller.state.status === "ready", "stopped response");
        assert.ok(controller.state.messages.some((message) => message.text?.includes("stopped")));
        checks.push("stop interrupts the active response");

        await controller.handleMessage({ type: "send", text: "hold response before reconnect", mode: "prompt" });
        await until(() => controller.state.status === "busy", "response before disconnect");
        await controller.disconnect();
        assert.ok(controller.state.messages.every((message) => !message.isRunning));
        await controller.connect();
        assert.equal(controller.state.status, "ready", "reconnect must not retain the interrupted run latch");
        await controller.handleMessage({ type: "send", text: "Continue after reconnect.", mode: "prompt" });
        await until(() => controller.state.status === "ready", "response after reconnect");
        checks.push("interrupted run reconnects and accepts a subsequent prompt");

        const imageConversation = controller.active;
        const imageConversationKey = controller.state.conversationKey;
        const imageClient = controller.client;
        const imageProcess = imageClient.child;
        assert.ok(imageConversationKey, "live conversations have stable routing keys");
        await controller.handleMessage({
            type: "saveDraft",
            conversationKey: imageConversationKey,
            text: "Draft for the image conversation",
            selectionStart: 9,
            selectionEnd: 12,
            sendMode: "followUp",
        });
        await controller.attachImage(imageFile);
        await vscode.commands.executeCommand("specpi.chat.history");
        await until(
            () => controller.state.conversations?.some((entry) => entry.id === imageConversationKey),
            "sidebar conversation history metadata",
        );
        assert.equal(controller.client, imageClient, "opening history retains the current RPC connection");
        assert.equal(imageProcess.exitCode, null);
        checks.push("sidebar history lists the selected live conversation without replacing Pi");

        await vscode.commands.executeCommand("specpi.chat.new");
        assert.equal(controller.state.messages.length, 0);
        assert.equal(controller.state.title, "New chat");
        assert.equal((await imageConversation.catalog.list()).length, 1, "new chat preserves prior owned history");
        assert.equal(controller.client, null, "new conversations launch Pi only when needed");
        assert.notEqual(controller.active, imageConversation);
        assert.equal(imageConversation.client, imageClient, "New Chat retains the previous process");
        assert.equal(imageProcess.exitCode, null);
        const secondConversationKey = controller.state.conversationKey;
        await controller.handleMessage({
            type: "send",
            text: "hold response in the second conversation",
            mode: "prompt",
        });
        await until(() => controller.state.status === "busy", "second conversation streaming");
        const secondConversation = controller.active;
        const secondClient = controller.client;
        assert.notEqual(secondClient.child.pid, imageProcess.pid, "conversations use separate live processes");
        await controller.handleMessage({ type: "selectConversation", id: imageConversationKey });
        assert.equal(controller.active, imageConversation);
        assert.equal(controller.client, imageClient, "switching back reuses the existing Pi connection");
        assert.equal(controller.client.child.pid, imageProcess.pid);
        assert.equal(secondConversation.client, secondClient);
        assert.equal((await secondClient.request("get_state")).isStreaming, true);
        assert.equal(controller.activeSessionId, imageSessionId);
        assert.equal(controller.state.status, "ready");
        assert.equal(controller.state.draft.text, "Draft for the image conversation");
        assert.equal(controller.state.draft.selectionStart, 9);
        assert.equal(controller.state.draft.selectionEnd, 12);
        assert.equal(controller.state.draft.sendMode, "followUp");
        assert.equal(controller.state.attachments.length, 1, "switching restores that conversation's draft image");
        assert.equal(
            controller.state.messages.filter(
                (message) => message.role === "user" && message.images?.[0]?.data === PNG_DATA,
            ).length,
            2,
        );
        assert.equal(
            controller.state.messages.filter(
                (message) => message.role === "tool" && message.images?.[0]?.data === PNG_DATA,
            ).length,
            2,
        );
        const resumedImages = (await controller.client.request("get_messages")).messages.filter(
            (message) => message.role === "user" && message.content.some((part) => part.type === "image"),
        );
        assert.equal(resumedImages.length, 2);
        assert.ok(
            resumedImages.every((message) => message.content.find((part) => part.type === "image").data === PNG_DATA),
        );
        checks.push("live switching retains processes, active runs, drafts, attachments, and user/tool images");

        const { id: backgroundDialogId } = await secondClient.request("fixture_request_dialog");
        await until(() => secondConversation.state.uiRequest?.id === backgroundDialogId, "background dialog");
        await until(
            () =>
                controller.state.conversations.some(
                    (entry) => entry.id === secondConversationKey && entry.status === "needs-input",
                ),
            "background conversation needs-input badge",
        );
        assert.equal(
            controller.state.uiRequest,
            undefined,
            "background dialogs do not replace the selected conversation",
        );
        await controller.handleMessage({
            type: "uiResponse",
            conversationKey: imageConversationKey,
            id: backgroundDialogId,
            value: "Wrong conversation",
        });
        assert.equal((await secondClient.request("fixture_dialog_response")).response, undefined);
        await controller.handleMessage({ type: "selectConversation", id: secondConversationKey });
        assert.equal(controller.client, secondClient);
        assert.equal(controller.state.uiRequest.id, backgroundDialogId);
        await controller.handleMessage({
            type: "uiResponse",
            conversationKey: secondConversationKey,
            id: backgroundDialogId,
            value: "Confirmed synthetic ownership",
        });
        await until(
            async () => Boolean((await secondClient.request("fixture_dialog_response")).response),
            "dialog response",
        );
        assert.deepEqual((await secondClient.request("fixture_dialog_response")).response, {
            id: backgroundDialogId,
            value: "Confirmed synthetic ownership",
        });
        await vscode.commands.executeCommand("specpi.chat.stop");
        await until(() => controller.state.status === "ready", "second conversation stopped explicitly");
        assert.equal(imageConversation.client, imageClient);
        assert.equal(imageProcess.exitCode, null, "stopping the selected run leaves the other Pi alive");
        checks.push("background dialogs stay isolated and return to their original live conversation");

        await controller.handleMessage({ type: "selectConversation", id: imageConversationKey });
        await controller.disconnect();
        assert.equal(imageProcess.exitCode !== null || imageProcess.signalCode !== null, true);
        await controller.connect();
        assert.equal(controller.activeSessionId, imageSessionId);
        assert.equal(controller.state.status, "ready");
        assert.equal(
            controller.state.messages.filter(
                (message) => message.role === "user" && message.images?.[0]?.data === PNG_DATA,
            ).length,
            2,
            "explicit reconnect reloads images from extension-owned history",
        );
        assert.equal(secondConversation.client, secondClient, "disconnecting one conversation preserves the other");
        checks.push("explicit reconnect reloads owned image history without disconnecting other conversations");

        await vscode.commands.executeCommand("specpi.chat.new");
        assert.equal(controller.state.messages.length, 0);
        await vscode.commands.executeCommand("specpi.chat.disconnect");
        assert.equal(controller.client, null);
        assert.equal(controller.state.status, "disconnected");
        checks.push("new chat and clean disconnect");
        result.passed = true;
    } catch (error) {
        result.error = error.stack || error.message;
        result.controllerError = controller?.state.error;
        throw error;
    } finally {
        if (controller?.disconnectAll) {
            await controller.disconnectAll();
        } else {
            await controller?.disconnect();
        }

        fs.writeFileSync(path.join(directory, "host-result.json"), JSON.stringify(result, null, 4));
    }
}

module.exports = { run };
