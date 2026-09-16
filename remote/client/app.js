// SpecPi Remote phone client.
//
// Every value that originates with the model, a tool, or an extension is placed
// with textContent. Nothing on this page uses innerHTML, and the daemon's CSP
// forbids inline script as the backstop.

const MAX_TOOL_OUTPUT_CHARS = 16000;

const state = {
    connectionId: null,
    running: false,
    blocks: new Map(),
    tools: new Map(),
    approvals: new Map(),
    lastEntryId: null,
};

const ui = {
    transcript: document.getElementById("transcript"),
    approvals: document.getElementById("approvals"),
    queue: document.getElementById("queue"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    stop: document.getElementById("stop"),
    model: document.getElementById("model"),
    thinking: document.getElementById("thinking"),
    stateDot: document.getElementById("state-dot"),
    stateLabel: document.getElementById("state-label"),
    context: document.getElementById("stat-context"),
    cost: document.getElementById("stat-cost"),
    hint: document.getElementById("hint"),
};

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

function atBottom() {
    const slack = 80;

    return ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < slack;
}

function append(node) {
    const stick = atBottom();
    ui.transcript.append(node);
    if (stick) {
        ui.transcript.scrollTop = ui.transcript.scrollHeight;
    }

    return node;
}

function addEntry(role, className, text) {
    const entry = element("div", `entry ${className}`);
    entry.append(element("span", "role", role));
    const body = element("span", null, text ?? "");
    entry.append(body);
    append(entry);

    return body;
}

function setRunning(running) {
    state.running = running;
    ui.stop.disabled = !running;
    ui.stateDot.dataset.state = running ? "running" : "idle";
    ui.stateLabel.textContent = running ? "Running" : "Idle";
    ui.send.textContent = running ? "Steer" : "Send";
    ui.hint.textContent = running
        ? "Send steers the current turn."
        : "While Pi is running, Send steers the current turn.";
}

async function command(body) {
    const response = await fetch("/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        addEntry("error", "error", payload.error || `Command failed (${response.status})`);

        return null;
    }

    if (payload.success === false) {
        addEntry("error", "error", payload.error || `${body.type} was refused by Pi`);

        return null;
    }

    return payload.data ?? payload;
}

// --- Streaming assembly -----------------------------------------------------
// message_update carries deltas only; contentIndex identifies the block. The
// docs are explicit that message_end.message is the authoritative version, so
// partial blocks are dropped there rather than merged.

function blockFor(index, kind) {
    const existing = state.blocks.get(index);
    if (existing) {
        return existing;
    }

    const role = kind === "thinking" ? "thinking" : "assistant";
    const body = addEntry(role, kind === "thinking" ? "thinking" : "assistant", "");
    const block = { body, text: "" };
    state.blocks.set(index, block);

    return block;
}

function applyDelta(event) {
    const delta = event.assistantMessageEvent;
    if (!delta) {
        return;
    }

    if (delta.type === "text_delta" || delta.type === "thinking_delta") {
        const kind = delta.type === "thinking_delta" ? "thinking" : "text";
        const block = blockFor(delta.contentIndex, kind);
        block.text += delta.delta ?? "";
        block.body.textContent = block.text;
        if (atBottom()) {
            ui.transcript.scrollTop = ui.transcript.scrollHeight;
        }

        return;
    }

    if (delta.type === "toolcall_start") {
        startTool(delta.id, delta.toolName, null);
    }
}

function startTool(toolCallId, toolName, args) {
    if (!toolCallId || state.tools.has(toolCallId)) {
        return state.tools.get(toolCallId);
    }

    const card = element("div", "entry tool");
    card.append(element("span", "role", toolName || "tool"));
    const summary = element("div", null, args ? summarise(args) : "starting…");
    const output = element("pre", null, "");
    card.append(summary, output);
    append(card);
    const record = { card, summary, output };
    state.tools.set(toolCallId, record);

    return record;
}

function summarise(args) {
    if (!args || typeof args !== "object") {
        return "";
    }

    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        parts.push(`${key}: ${text}`);
    }

    return clamp(parts.join("\n"), 2000).text;
}

// Bounded rendering. Long tool output is cut with a visible marker rather than
// quietly dropped, so what is on screen is never mistaken for the whole thing.
function clamp(text, limit) {
    if (typeof text !== "string") {
        return { text: "", truncated: false };
    }

    if (text.length <= limit) {
        return { text, truncated: false };
    }

    return { text: text.slice(0, limit), truncated: true };
}

function contentText(content) {
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter((part) => part && part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}

function renderToolOutput(record, content) {
    const { text, truncated } = clamp(contentText(content), MAX_TOOL_OUTPUT_CHARS);
    record.output.textContent = text;
    if (!truncated) {
        return;
    }

    if (!record.truncationNote) {
        record.truncationNote = element("div", "truncation", "");
        record.card.append(record.truncationNote);
    }

    record.truncationNote.textContent = `Output truncated at ${MAX_TOOL_OUTPUT_CHARS} characters. Open this conversation on the desktop to read all of it.`;
}

// --- Agent events -----------------------------------------------------------

function onAgentEvent(event) {
    switch (event.type) {
        case "agent_start":
            setRunning(true);
            break;
        case "agent_settled":
            setRunning(false);
            refreshStats();
            break;
        case "message_start":
            state.blocks.clear();
            break;
        case "message_update":
            applyDelta(event);
            break;
        case "message_end":
            state.blocks.clear();
            break;
        case "tool_execution_start": {
            const record = startTool(event.toolCallId, event.toolName, event.args);
            if (record) {
                record.summary.textContent = summarise(event.args);
            }

            break;
        }

        case "tool_execution_update": {
            const record = state.tools.get(event.toolCallId);
            if (record) {
                renderToolOutput(record, event.partialResult?.content);
            }

            break;
        }

        case "tool_execution_end": {
            const record = state.tools.get(event.toolCallId);
            if (record) {
                renderToolOutput(record, event.result?.content);
                if (event.isError) {
                    record.card.classList.add("failed");
                }
            }

            break;
        }

        case "queue_update":
            renderQueue(event);
            break;
        case "compaction_start":
            addEntry("notice", "notice", "Compacting the conversation…");
            break;
        case "compaction_end":
            addEntry("notice", "notice", "Compaction finished.");
            break;
        case "auto_retry_start":
            addEntry("notice", "notice", "Transient error. Retrying…");
            break;
        case "auto_retry_end":
            addEntry("notice", "notice", event.success === false ? "Retry failed." : "Retry succeeded.");
            break;
        case "extension_error":
            addEntry("error", "error", `Extension error: ${event.error ?? "unknown"}`);
            break;
        default:
            break;
    }
}

function renderQueue(event) {
    const steering = Array.isArray(event.steering) ? event.steering : [];
    const followUp = Array.isArray(event.followUp) ? event.followUp : [];
    ui.queue.replaceChildren();
    if (steering.length === 0 && followUp.length === 0) {
        ui.queue.hidden = true;

        return;
    }

    ui.queue.hidden = false;
    for (const text of steering) {
        ui.queue.append(element("div", null, `Queued steer: ${text}`));
    }

    for (const text of followUp) {
        ui.queue.append(element("div", null, `Queued follow-up: ${text}`));
    }
}

// --- Approvals --------------------------------------------------------------

function renderApproval(request, expiresAt) {
    if (state.approvals.has(request.id)) {
        return;
    }

    const card = element("div", "approval");
    card.append(element("h2", null, request.title || "Pi needs a decision"));

    const bodyText = [request.message, request.detail, request.placeholder]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join("\n\n");
    if (bodyText) {
        card.append(element("div", "body", bodyText));
    }

    const actions = element("div", "actions");
    if (request.method === "confirm") {
        actions.append(button("Yes", "approve", () => answer(request.id, { confirmed: true })));
        actions.append(button("No", "", () => answer(request.id, { confirmed: false })));
    } else if (request.method === "select") {
        const options = Array.isArray(request.options) ? request.options : [];
        for (const option of options) {
            actions.append(button(option, "", () => answer(request.id, { value: option })));
        }
    } else if (request.method === "input" || request.method === "editor") {
        const field = element("textarea");
        field.rows = 3;
        card.append(field);
        actions.append(button("Submit", "approve", () => answer(request.id, { value: field.value })));
    }

    actions.append(button("Cancel", "danger", () => answer(request.id, { cancelled: true })));
    card.append(actions);

    const expiry = element("div", "expiry", "");
    card.append(expiry);

    ui.approvals.append(card);
    const record = { card, expiry, expiresAt };
    state.approvals.set(request.id, record);
    tickExpiry();
}

function button(label, className, onClick) {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", () => {
        for (const control of node.parentElement.querySelectorAll("button")) {
            control.disabled = true;
        }

        onClick();
    });

    return node;
}

// The countdown is honest about what expiry means: the daemon cancels, it does
// not approve.
function tickExpiry() {
    for (const [, record] of state.approvals) {
        if (!record.expiresAt) {
            record.expiry.textContent = "";
            continue;
        }

        const seconds = Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000));
        record.expiry.textContent = `Cancels automatically in ${seconds}s if unanswered.`;
    }
}

async function answer(id, payload) {
    const response = await fetch("/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, connectionId: state.connectionId, ...payload }),
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        addEntry("error", "error", `Approval was not accepted: ${detail.error || response.status}`);
        removeApproval(id);
    }
}

function removeApproval(id) {
    const record = state.approvals.get(id);
    if (!record) {
        return;
    }

    record.card.remove();
    state.approvals.delete(id);
}

// --- Transcript backfill ----------------------------------------------------

async function loadTranscript() {
    const data = await command({ type: "get_messages" });
    if (!data || !Array.isArray(data.messages)) {
        return;
    }

    ui.transcript.replaceChildren();
    for (const message of data.messages) {
        const text = typeof message.content === "string" ? message.content : contentText(message.content);
        if (!text) {
            continue;
        }

        addEntry(message.role || "message", message.role === "user" ? "user" : "assistant", text);
    }
}

async function refreshStats() {
    const data = await command({ type: "get_session_stats" });
    if (!data) {
        return;
    }

    const percent = data.contextUsage?.percent;
    ui.context.textContent = typeof percent === "number" ? `ctx ${percent}%` : "ctx —";
    ui.cost.textContent = typeof data.cost === "number" ? `$${data.cost.toFixed(2)}` : "—";
}

async function loadModels() {
    const data = await command({ type: "get_available_models" });
    const models = data?.models;
    if (!Array.isArray(models)) {
        return;
    }

    ui.model.replaceChildren();
    for (const model of models) {
        const option = element("option", null, model.name || model.id);
        option.value = model.id;
        ui.model.append(option);
    }

    const current = await command({ type: "get_state" });
    if (current?.model?.id) {
        ui.model.value = current.model.id;
    }

    if (current?.thinkingLevel) {
        ui.thinking.value = current.thinkingLevel;
    }
}

// --- Wiring -----------------------------------------------------------------

function connect() {
    const stream = new EventSource("/events");

    stream.addEventListener("message", (message) => {
        let payload;
        try {
            payload = JSON.parse(message.data);
        } catch {
            return;
        }

        handle(payload);
    });

    stream.addEventListener("error", () => {
        ui.stateDot.dataset.state = "error";
        ui.stateLabel.textContent = "Reconnecting";
    });
}

function handle(payload) {
    switch (payload.type) {
        case "connected":
            state.connectionId = payload.connectionId;
            setRunning(false);
            loadModels();
            loadTranscript();
            refreshStats();
            break;
        case "agent":
            onAgentEvent(payload.event);
            break;
        case "approval":
            renderApproval(payload.request, payload.expiresAt);
            break;
        case "approvalResolved":
            removeApproval(payload.id);
            break;
        case "notice":
            addEntry("notice", "notice", payload.request?.message || payload.request?.title || "");
            break;
        case "protocolError":
            addEntry("error", "error", `Protocol error: ${payload.message}`);
            break;
        case "agentClosed":
            setRunning(false);
            ui.stateDot.dataset.state = "error";
            ui.stateLabel.textContent = "Agent stopped";
            addEntry("error", "error", payload.reason || "Pi stopped.");
            break;
        case "resumeGap":
            // More happened than the daemon buffered. Refetch rather than show
            // a transcript with an invisible hole in it.
            addEntry("notice", "notice", "Reconnected after a gap. Reloading the transcript.");
            loadTranscript();
            break;
        default:
            break;
    }
}

ui.send.addEventListener("click", async () => {
    const text = ui.input.value.trim();
    if (!text) {
        return;
    }

    ui.input.value = "";
    addEntry("you", "user", text);
    await command({ type: state.running ? "steer" : "prompt", message: text });
    if (!state.running) {
        setRunning(true);
    }
});

ui.stop.addEventListener("click", async () => {
    await command({ type: "abort" });
    setRunning(false);
});

ui.model.addEventListener("change", async () => {
    await command({ type: "set_model", modelId: ui.model.value });
});

ui.thinking.addEventListener("change", async () => {
    await command({ type: "set_thinking_level", level: ui.thinking.value });
});

setInterval(tickExpiry, 1000);
connect();

if ("serviceWorker" in navigator) {
    // Only available in a secure context. Over a raw tunnel IP this registration
    // simply never happens, and the page keeps working without it.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
}
