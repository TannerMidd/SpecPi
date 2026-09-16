// Synthetic RPC peer. Loads no Pi, reads no user configuration, contacts no
// provider. Modelled on tests/fixtures/vscode-fake-pi.mjs at the repository
// root, extended with the dialog behaviours Remote needs to exercise.
//
// Test scripts steer it through the prompt text:
//   DIALOG:select        emit an untimed select dialog
//   DIALOG:confirm       emit an untimed confirm dialog
//   DIALOG:timed:<ms>    emit a select dialog carrying that timeout
//   DIALOG:huge          emit a dialog past any sane display budget
//   DIALOG:notify        emit a fire-and-forget notify request
//   SPLIT                reply in a record containing U+2028 and U+2029
//   NOREPLY              accept the command and never respond

import { randomUUID } from "node:crypto";

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built at runtime so
// the literal characters never sit in this source file and cannot be quietly
// re-escaped into an inert string by tooling.
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const SEPARATOR_TEXT = `line${LINE_SEPARATOR}still${PARAGRAPH_SEPARATOR}same`;

let buffer = "";
const answered = [];

function output(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(command, data, success = true) {
    output({ type: "response", command: command.type, id: command.id, success, data });
}

const state = {
    model: { id: "synthetic-model", name: "Synthetic model", contextWindow: 200000 },
    thinkingLevel: "medium",
    messages: [],
};

function emitDialog(message) {
    const id = randomUUID();
    if (message.includes("DIALOG:confirm")) {
        output({
            type: "extension_ui_request",
            id,
            method: "confirm",
            title: "Allow this command?",
            message: "rm -rf build",
        });

        return id;
    }

    if (message.includes("DIALOG:huge")) {
        output({
            type: "extension_ui_request",
            id,
            method: "select",
            title: "Allow this command?",
            message: "x".repeat(200000),
            options: ["Allow", "Block"],
        });

        return id;
    }

    if (message.includes("DIALOG:notify")) {
        output({ type: "extension_ui_request", id, method: "notify", message: "Just so you know" });

        return id;
    }

    const timed = message.match(/DIALOG:timed:(\d+)/u);
    output({
        type: "extension_ui_request",
        id,
        method: "select",
        title: "Allow dangerous command?",
        options: ["Allow", "Block"],
        ...(timed ? { timeout: Number.parseInt(timed[1], 10) } : {}),
    });

    return id;
}

function handlePrompt(command) {
    const message = String(command.message ?? "");
    if (message.includes("NOREPLY")) {
        return;
    }

    respond(command, { accepted: true });
    output({ type: "agent_start" });
    if (message.includes("DIALOG:")) {
        emitDialog(message);

        return;
    }

    if (message.includes("SPLIT")) {
        // U+2028/U+2029 inside a JSON string. A readline-based client would
        // split here and corrupt the record; a compliant one must not.
        output({ type: "message_end", message: { role: "assistant", content: SEPARATOR_TEXT } });
        output({ type: "agent_settled" });

        return;
    }

    output({ type: "message_end", message: { role: "assistant", content: "Synthetic reply." } });
    output({ type: "agent_settled" });
}

function handle(command) {
    switch (command.type) {
        case "prompt":
            handlePrompt(command);

            return;
        case "steer":
        case "follow_up":
            respond(command, { queued: true });

            return;
        case "abort":
            respond(command, { aborted: true });
            output({ type: "agent_settled" });

            return;
        case "clear_queue":
            respond(command, { cleared: true });

            return;
        case "get_state":
            respond(command, { model: state.model, thinkingLevel: state.thinkingLevel });

            return;
        case "get_messages":
            respond(command, { messages: state.messages });

            return;
        case "get_entries":
            if (typeof command.since === "string" && command.since !== "known-entry") {
                respond(command, null, false);

                return;
            }

            respond(command, { entries: [], leafId: "known-entry" });

            return;
        case "get_available_models":
            respond(command, { models: [state.model, { id: "other-model", name: "Other model" }] });

            return;
        case "set_model":
            state.model = { ...state.model, id: command.modelId };
            respond(command, { model: state.model });

            return;
        case "set_thinking_level":
            state.thinkingLevel = command.level;
            respond(command, { thinkingLevel: state.thinkingLevel });

            return;
        case "get_session_stats":
            respond(command, {
                cost: 0.42,
                tokens: { total: 1000 },
                contextUsage: { tokens: 1000, contextWindow: 200000, percent: 1 },
            });

            return;
        case "new_session":
        case "switch_session":
            respond(command, { sessionId: randomUUID() });

            return;
        default:
            respond(command, { error: `Unknown command: ${command.type}` }, false);
    }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) {
            break;
        }

        const line = buffer.slice(0, index).replace(/\r$/u, "");
        buffer = buffer.slice(index + 1);
        if (!line) {
            continue;
        }

        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }

        if (record.type === "extension_ui_response") {
            answered.push(record);
            // Echo so tests can assert exactly what the daemon sent back.
            output({ type: "dialog_answered", answer: record });
            continue;
        }

        handle(record);
    }
});

process.stdin.on("end", () => {
    process.exit(0);
});
