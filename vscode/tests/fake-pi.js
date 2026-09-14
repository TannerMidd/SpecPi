"use strict";

// Deterministic RPC peer for isolated tests. It never loads Pi, contacts a
// provider, executes tools, or reads any installed configuration.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");

const testDirectory = process.env.SPECPI_VSCODE_TEST_DIRECTORY;
if (!testDirectory || !process.env.PI_CODING_AGENT_DIR) {
    throw new Error("The fake Pi fixture may run only in an isolated test environment");
}

const agentDirectory = path.resolve(process.env.PI_CODING_AGENT_DIR);
if (path.dirname(agentDirectory) !== path.resolve(testDirectory)) {
    throw new Error("The fake Pi fixture requires an isolated agent directory");
}

const sessionArgument = process.argv.indexOf("--session-dir");
const sessionDirectory = process.argv[sessionArgument + 1];
const relativeSessionDirectory = sessionDirectory
    ? path.relative(path.resolve(testDirectory), path.resolve(sessionDirectory))
    : undefined;
if (
    sessionArgument < 0 ||
    !sessionDirectory ||
    !relativeSessionDirectory ||
    relativeSessionDirectory === ".." ||
    relativeSessionDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSessionDirectory)
) {
    throw new Error("The fake Pi fixture requires isolated session storage");
}

const visionModel = {
    id: "fixture-model",
    name: "Fixture Model",
    provider: "fixture",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const textModel = { ...visionModel, id: "fixture-text-model", name: "Fixture Text Model", input: ["text"] };
const models = [visionModel, textModel];
let model = visionModel;
let sessionId = randomUUID();
let sessionFile;
let sessionName = "";
let messages = [];
let thinkingLevel = "off";
let active = false;
let activeTimer;
let steering = [];
let followUp = [];
let dialogId;
let dialogResponse;

function emit(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, data = {}) {
    emit({ type: "response", id: command.id, command: command.type, success: true, data });
}

function persist() {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    sessionFile ||= path.join(sessionDirectory, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({ sessionId, sessionName, messages }));
}

function loadSession(filename) {
    if (path.relative(path.resolve(sessionDirectory), path.dirname(path.resolve(filename))) !== "") {
        throw new Error("Fixture session path must remain in extension-owned test storage");
    }

    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    sessionFile = filename;
    sessionId = saved.sessionId;
    sessionName = saved.sessionName;
    messages = saved.messages;
}

const resumeArgument = process.argv.indexOf("--session");
if (resumeArgument >= 0) {
    loadSession(process.argv[resumeArgument + 1]);
}

function finish(aborted = false) {
    clearTimeout(activeTimer);
    if (!active) {
        return;
    }

    const answer = {
        role: "assistant",
        content: [
            {
                type: "text",
                text: aborted
                    ? "Fixture response stopped."
                    : "Fixture response complete. Your editor context arrived safely.",
            },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: aborted ? "aborted" : "stop",
        timestamp: Date.now(),
    };
    messages.push(answer);
    emit({ type: "message_end", message: answer });
    active = false;
    sessionName ||= "Fixture conversation";
    persist();
    emit({ type: "agent_end", messages: [answer], willRetry: false });
    emit({ type: "agent_settled" });
}

function prompt(command) {
    if (command.images?.length && !model.input.includes("image")) {
        emit({
            type: "response",
            id: command.id,
            command: command.type,
            success: false,
            error: "Fixture text model cannot accept images.",
        });

        return;
    }

    if (active) {
        (command.streamingBehavior === "steer" ? steering : followUp).push(command.message);
        respond(command);
        emit({ type: "queue_update", steering, followUp });

        return;
    }

    const images = (command.images || []).map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
    const user = { role: "user", content: [{ type: "text", text: command.message }, ...images], timestamp: Date.now() };
    messages.push(user);
    active = true;
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: user });
    emit({ type: "message_end", message: user });
    const partial = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
    };
    emit({ type: "message_start", message: partial });
    emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Fixture response " },
    });
    const toolCallId = randomUUID();
    const toolContent = [{ type: "text", text: "Fixture tool output" }, ...images];
    emit({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "example.js" } });
    emit({
        type: "tool_execution_update",
        toolCallId,
        toolName: "read",
        partialResult: { content: [{ type: "text", text: "Fixture tool output" }] },
    });
    emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "read",
        result: { content: toolContent },
        isError: false,
    });
    messages.push({
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: toolContent,
        isError: false,
        timestamp: Date.now(),
    });
    respond(command);
    activeTimer = setTimeout(() => finish(), command.message.includes("hold response") ? 30000 : 120);
}

function handle(command) {
    switch (command.type) {
        case "get_state":
            respond(command, {
                model,
                thinkingLevel,
                isStreaming: active,
                isCompacting: false,
                sessionId,
                sessionFile,
                sessionName,
                pendingMessageCount: steering.length + followUp.length,
                messageCount: messages.length,
            });
            break;
        case "get_available_models":
            respond(command, { models });
            break;
        case "get_available_thinking_levels":
            respond(command, { levels: ["off", "low", "medium", "high", "max"] });
            break;
        case "get_commands":
            respond(command, {
                commands: [{ name: "fixture", description: "Test-only fixture command", source: "extension" }],
            });
            break;
        case "get_messages":
            respond(command, { messages });
            break;
        case "get_session_stats":
            respond(command, {
                sessionId,
                sessionFile,
                tokens: { input: 12, output: 24, cacheRead: 0, cacheWrite: 0, total: 36 },
                cost: 0,
            });
            break;
        case "fixture_request_dialog":
            dialogId = randomUUID();
            dialogResponse = undefined;
            respond(command, { id: dialogId });
            emit({
                type: "extension_ui_request",
                id: dialogId,
                method: "input",
                title: "Synthetic background request",
                message: "This fixture request belongs only to its original conversation.",
            });
            break;
        case "fixture_dialog_response":
            respond(command, { response: dialogResponse });
            break;
        case "set_model":
            model =
                models.find(
                    (candidate) => candidate.id === command.modelId && candidate.provider === command.provider,
                ) || model;
            respond(command, model);
            break;
        case "set_thinking_level":
            thinkingLevel = command.level;
            respond(command);
            break;
        case "prompt":
            prompt(command);
            break;
        case "clear_queue":
            respond(command, { steering, followUp });
            steering = [];
            followUp = [];
            break;
        case "abort":
            finish(true);
            respond(command);
            break;
        case "new_session":
            sessionId = randomUUID();
            sessionFile = undefined;
            sessionName = "";
            messages = [];
            respond(command, { cancelled: false });
            break;
        case "switch_session":
            loadSession(command.sessionPath);
            respond(command, { cancelled: false });
            break;
        case "set_session_name":
            sessionName = command.name;
            persist();
            respond(command);
            break;
        case "compact":
            respond(command, { summary: "Fixture summary", tokensBefore: 36 });
            break;
        case "extension_ui_response":
            if (command.id === dialogId) {
                dialogResponse = {
                    id: command.id,
                    ...(typeof command.value === "string" ? { value: command.value } : {}),
                    ...(command.cancelled === true ? { cancelled: true } : {}),
                };
            }

            break;
        default:
            emit({
                type: "response",
                id: command.id,
                command: command.type,
                success: false,
                error: `Unsupported fixture command: ${command.type}`,
            });
    }
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
    try {
        handle(JSON.parse(line));
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        input.close();
    }
});
input.on("close", () => {
    clearTimeout(activeTimer);
});
