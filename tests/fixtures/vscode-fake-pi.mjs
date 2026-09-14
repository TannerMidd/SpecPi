// Synthetic RPC peer. This fixture never loads Pi or reads user configuration.
import { randomUUID } from "node:crypto";

let buffer = "";
let active = false;
let timer;
let sessionId = randomUUID();
let sessionName = "Synthetic chat";
let thinkingLevel = "medium";
let model = {
    id: "synthetic-model",
    name: "Synthetic model",
    provider: "synthetic",
    reasoning: true,
    contextWindow: 200000,
};
let messages = [];
const sessionFlag = process.argv.indexOf("--session-dir");
const sessionDirectory = sessionFlag < 0 ? "synthetic-sessions" : process.argv[sessionFlag + 1];

function output(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, data) {
    output({ type: "response", command: command.type, id: command.id, success: true, data });
}

function endTurn(text = "Synthetic reply from Pi.") {
    const assistant = {
        role: "assistant",
        content: [{ type: "text", text }],
        provider: model.provider,
        model: model.id,
        api: "synthetic",
        timestamp: Date.now(),
        usage: {
            input: 10,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 16,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
    };
    output({ type: "message_start", message: { ...assistant, content: [] } });
    output({
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: assistant },
    });
    output({ type: "message_end", message: assistant });
    messages.push(assistant);
    active = false;
    output({ type: "agent_end", messages: [assistant] });
    output({ type: "agent_settled" });
}

function handle(command) {
    switch (command.type) {
        case "echo":
            response(command, { value: command.value });
            break;
        case "hold":
            break;
        case "delayed":
            setTimeout(() => response(command, { value: command.value }), command.delay ?? 25);
            break;
        case "fail":
            output({
                type: "response",
                command: command.type,
                id: command.id,
                success: false,
                error: "Synthetic rejection",
            });
            break;
        case "stderr":
            process.stderr.write("TEST_SECRET_MUST_NOT_BE_RELAYED\n");
            response(command, { ok: true });
            break;
        case "malformed":
            process.stdout.write("TEST_PRIVATE_NON_PROTOCOL_OUTPUT\nnull\n[]\n");
            response(command, { ok: true });
            break;
        case "unicode": {
            const event = `${JSON.stringify({ type: "synthetic", value: "split 😀 text\u2028and\u2029separators" })}\r\n`;
            const bytes = Buffer.from(event);
            const emoji = bytes.indexOf(Buffer.from("😀"));
            process.stdout.write(bytes.subarray(0, emoji + 1));
            setTimeout(() => {
                process.stdout.write(bytes.subarray(emoji + 1));
                response(command, { ok: true });
            }, 5);
            break;
        }

        case "exit":
            process.exit(3);
            break;
        case "get_state":
            response(command, {
                sessionId,
                sessionName,
                sessionFile: `${sessionDirectory}/${sessionId}.jsonl`,
                model,
                thinkingLevel,
                isStreaming: active,
                isCompacting: false,
                autoCompactionEnabled: true,
                messageCount: messages.length,
                pendingMessageCount: 0,
                steeringMode: "all",
                followUpMode: "one-at-a-time",
            });
            break;
        case "get_available_models":
            response(command, {
                models: [model, { ...model, id: "synthetic-alternative", name: "Synthetic alternative" }],
            });
            break;
        case "get_available_thinking_levels":
            response(command, { levels: ["off", "minimal", "low", "medium", "high", "xhigh"] });
            break;
        case "get_messages":
            response(command, { messages });
            break;
        case "get_commands":
            response(command, {
                commands: [{ name: "synthetic", description: "Synthetic command", source: "extension" }],
            });
            break;
        case "get_session_stats":
            response(command, {
                sessionId,
                sessionFile: `${sessionDirectory}/${sessionId}.jsonl`,
                totalMessages: messages.length,
                userMessages: messages.filter((message) => message.role === "user").length,
                assistantMessages: messages.filter((message) => message.role === "assistant").length,
                toolCalls: 0,
                toolResults: 0,
                tokens: { input: 10, output: 6, cacheRead: 0, cacheWrite: 0, total: 16 },
                cost: 0,
            });
            break;
        case "get_context_usage":
            response(command, { tokens: 16, contextWindow: model.contextWindow, percent: 0.008 });
            break;
        case "prompt": {
            const user = { role: "user", content: [{ type: "text", text: command.message }], timestamp: Date.now() };
            messages.push(user);
            active = true;
            response(command);
            output({ type: "agent_start" });
            output({ type: "message_start", message: user });
            output({ type: "message_end", message: user });
            if (command.message === "synthetic-dialog") {
                output({
                    type: "extension_ui_request",
                    id: "synthetic-dialog",
                    method: "confirm",
                    title: "Synthetic approval",
                    message: "Allow the synthetic action?",
                });
            } else {
                timer = setTimeout(() => endTurn(), command.message === "synthetic-long" ? 60000 : 60);
            }

            break;
        }

        case "extension_ui_response":
            output({ type: "synthetic_ui_response", response: command });
            if (command.id === "synthetic-dialog") {
                endTurn(command.confirmed ? "Synthetic action approved." : "Synthetic action declined.");
            }

            break;
        case "abort":
            clearTimeout(timer);
            active = false;
            response(command);
            output({ type: "agent_end", messages: [] });
            output({ type: "agent_settled" });
            break;
        case "clear_queue":
            response(command, { steering: [], followUp: [] });
            break;
        case "new_session":
            clearTimeout(timer);
            active = false;
            messages = [];
            sessionId = randomUUID();
            response(command, { cancelled: false });
            break;
        case "set_session_name":
            sessionName = command.name;
            response(command);
            break;
        case "set_model":
            model = { ...model, id: command.modelId, provider: command.provider };
            response(command, model);
            break;
        case "set_thinking_level":
            thinkingLevel = command.level;
            response(command);
            break;
        case "compact":
            response(command, {
                summary: "Synthetic context summary",
                firstKeptEntryId: "synthetic",
                tokensBefore: 100,
            });
            break;
        case "steer":
        case "follow_up":
            response(command);
            break;
        default:
            output({
                type: "response",
                command: command.type,
                id: command.id,
                success: false,
                error: "Unknown synthetic command",
            });
    }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
            handle(JSON.parse(line));
        }
    }
});
process.stdin.on("end", () => {
    clearTimeout(timer);
    process.exit(0);
});
