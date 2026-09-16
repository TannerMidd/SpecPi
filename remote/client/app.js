// SpecPi Remote phone client.
//
// Every value that originates with the model, a tool, an extension, or a stored
// session is placed with textContent. Nothing on this page uses innerHTML, and
// the daemon's CSP forbids inline script as the backstop.

const MAX_TOOL_OUTPUT_CHARS = 16000;

// Phone cameras produce images far larger than any model needs. Downscaling in
// the browser keeps the request small and the upload quick.
const MAX_IMAGE_EDGE = 1568;
const IMAGE_QUALITY = 0.82;
const MAX_IMAGES = 6;

const state = {
    connectionId: null,
    running: false,
    blocks: new Map(),
    tools: new Map(),
    approvals: new Map(),
    // Keyed by statusKey / widgetKey, exactly as the extension addressed them,
    // so a later update replaces the entry instead of stacking another copy.
    status: new Map(),
    widgets: new Map(),
    sessions: [],
    sessionPath: null,
    images: [],
    modelAcceptsImages: false,
};

const ui = {};
for (const id of [
    "transcript",
    "approvals",
    "queue",
    "extensions",
    "input",
    "send",
    "stop",
    "model",
    "thinking",
    "state-dot",
    "state-label",
    "session-title",
    "stat-context",
    "hint",
    "attach",
    "attachments",
    "file-input",
    "open-sessions",
    "close-sessions",
    "new-session",
    "sessions-panel",
    "sessions-list",
    "session-filter",
    "open-usage",
    "close-usage",
    "usage-panel",
    "usage-body",
    "scrim",
]) {
    ui[id.replace(/-([a-z])/gu, (_, c) => c.toUpperCase())] = document.getElementById(id);
}

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
    if (typeof content === "string") {
        return content;
    }

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
        case "message_end":
            state.blocks.clear();
            break;
        case "message_update":
            applyDelta(event);
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

// --- Extension UI (fire-and-forget) -----------------------------------------
//
// Only `notify` is a message for the user. `setStatus`, `setWidget`, and
// `setTitle` are chrome that extensions update on almost every turn, so they
// belong in their own strip rather than in the transcript. Each carries its own
// field names; reading `message` off all of them produced a stream of empty
// rows the first time around.

function applyExtensionUi(request) {
    if (!request || typeof request.method !== "string") {
        return;
    }

    switch (request.method) {
        case "notify": {
            const text = typeof request.message === "string" ? request.message.trim() : "";
            if (!text) {
                return;
            }

            const severe = request.notifyType === "error" || request.notifyType === "warning";
            addEntry(request.notifyType || "info", severe ? "error" : "notice", text);

            return;
        }

        case "setStatus":
            setKeyed(state.status, request.statusKey, request.statusText);

            return;
        case "setWidget":
            setKeyed(
                state.widgets,
                request.widgetKey,
                Array.isArray(request.widgetLines) ? request.widgetLines.join("\n") : undefined,
            );

            return;
        case "setTitle":
            if (typeof request.title === "string" && request.title.length > 0) {
                document.title = request.title;
            }

            return;
        case "set_editor_text":
            if (typeof request.text === "string") {
                ui.input.value = request.text;
            }

            return;
        default:
            return;
    }
}

function setKeyed(map, key, value) {
    const name = typeof key === "string" && key.length > 0 ? key : "default";
    if (typeof value !== "string" || value.trim().length === 0) {
        map.delete(name);
    } else {
        map.set(name, value);
    }

    renderExtensions();
}

function renderExtensions() {
    ui.extensions.replaceChildren();
    if (state.status.size === 0 && state.widgets.size === 0) {
        ui.extensions.hidden = true;

        return;
    }

    ui.extensions.hidden = false;
    for (const [, text] of state.status) {
        ui.extensions.append(element("div", "status-entry", text));
    }

    for (const [, text] of state.widgets) {
        ui.extensions.append(element("pre", "widget-entry", text));
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
        for (const option of Array.isArray(request.options) ? request.options : []) {
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
    state.approvals.set(request.id, { card, expiry, expiresAt });
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

// --- Conversations ----------------------------------------------------------

function openPanel(panel) {
    panel.hidden = false;
    ui.scrim.hidden = false;
}

function closePanels() {
    ui.sessionsPanel.hidden = true;
    ui.usagePanel.hidden = true;
    ui.scrim.hidden = true;
}

async function loadSessions() {
    const response = await fetch("/sessions");
    if (!response.ok) {
        ui.sessionsList.replaceChildren(element("div", "empty", "Could not read the sessions directory."));

        return;
    }

    const payload = await response.json();
    state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    renderSessions();
}

function renderSessions() {
    const filter = ui.sessionFilter.value.trim().toLowerCase();
    const matching = state.sessions.filter((session) => {
        if (!filter) {
            return true;
        }

        return `${session.project} ${session.preview}`.toLowerCase().includes(filter);
    });

    ui.sessionsList.replaceChildren();
    if (matching.length === 0) {
        ui.sessionsList.append(element("div", "empty", "No conversations match."));

        return;
    }

    let currentProject = null;
    for (const session of matching) {
        if (session.project !== currentProject) {
            currentProject = session.project;
            ui.sessionsList.append(element("div", "group", currentProject));
        }

        const row = element("button", "session");
        row.type = "button";
        if (session.path === state.sessionPath) {
            row.classList.add("active");
        }

        row.append(element("div", "session-preview", session.preview || "(no messages yet)"));
        const meta = `${formatWhen(session.modified)} · ${session.messages}${session.partial ? "+" : ""} messages`;
        row.append(element("div", "session-meta", meta));
        row.addEventListener("click", () => switchSession(session));
        ui.sessionsList.append(row);
    }
}

function formatWhen(iso) {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) {
        return "unknown";
    }

    const sameDay = when.toDateString() === new Date().toDateString();
    if (sameDay) {
        return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    return when.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function switchSession(session) {
    const result = await command({ type: "switch_session", sessionPath: session.path });
    if (!result) {
        return;
    }

    if (result.cancelled) {
        addEntry("notice", "notice", "An extension cancelled the session switch.");

        return;
    }

    state.sessionPath = session.path;
    ui.sessionTitle.textContent = session.preview ? session.preview.slice(0, 40) : "Conversation";
    closePanels();
    await afterSessionChange();
}

async function startNewSession() {
    const result = await command({ type: "new_session" });
    if (!result) {
        return;
    }

    state.sessionPath = null;
    ui.sessionTitle.textContent = "New conversation";
    closePanels();
    await afterSessionChange();
    loadSessions();
}

async function afterSessionChange() {
    state.blocks.clear();
    state.tools.clear();
    await loadTranscript();
    await refreshStats();
    await loadModels();
}

// --- Usage ------------------------------------------------------------------

function renderUsage(data) {
    ui.usageBody.replaceChildren();
    if (!data) {
        ui.usageBody.append(element("div", "empty", "No usage yet."));

        return;
    }

    const tokens = data.tokens || {};
    const context = data.contextUsage || {};
    const rows = [
        ["Cost", typeof data.cost === "number" ? `$${data.cost.toFixed(4)}` : "—"],
        ["Context", context.percent === null || context.percent === undefined ? "—" : `${context.percent}%`],
        [
            "Context tokens",
            context.tokens === null || context.tokens === undefined
                ? "—"
                : `${number(context.tokens)} / ${number(context.contextWindow)}`,
        ],
        ["Input tokens", number(tokens.input)],
        ["Output tokens", number(tokens.output)],
        ["Cache read", number(tokens.cacheRead)],
        ["Cache write", number(tokens.cacheWrite)],
        ["Total tokens", number(tokens.total)],
        ["Messages", number(data.totalMessages)],
        ["Tool calls", number(data.toolCalls)],
    ];

    for (const [label, value] of rows) {
        const row = element("div", "usage-row");
        row.append(element("span", "usage-label", label));
        row.append(element("span", "usage-value", value));
        ui.usageBody.append(row);
    }

    if (context.percent === null) {
        ui.usageBody.append(
            element("div", "usage-note", "Context is unknown right after compaction until the next response."),
        );
    }
}

function number(value) {
    return typeof value === "number" ? value.toLocaleString() : "—";
}

// --- Images -----------------------------------------------------------------

async function addImages(files) {
    for (const file of files) {
        if (state.images.length >= MAX_IMAGES) {
            addEntry("notice", "notice", `Only ${MAX_IMAGES} images can be attached at once.`);
            break;
        }

        try {
            state.images.push(await downscale(file));
        } catch {
            addEntry("error", "error", `Could not read ${file.name}.`);
        }
    }

    renderAttachments();
}

// Draws the photo into a bounded canvas and re-encodes it. A modern phone photo
// is several megabytes; this brings it to a few hundred kilobytes without the
// model losing anything it can use.
function downscale(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.width * scale));
            canvas.height = Math.max(1, Math.round(image.height * scale));
            canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
            resolve({
                type: "image",
                mimeType: "image/jpeg",
                data: dataUrl.slice(dataUrl.indexOf(",") + 1),
                preview: dataUrl,
                name: file.name,
            });
        };

        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("decode failed"));
        };

        image.src = url;
    });
}

function renderAttachments() {
    ui.attachments.replaceChildren();
    if (state.images.length === 0) {
        ui.attachments.hidden = true;

        return;
    }

    ui.attachments.hidden = false;
    state.images.forEach((image, index) => {
        const chip = element("div", "chip");
        const thumb = document.createElement("img");
        thumb.src = image.preview;
        thumb.alt = image.name || "attachment";
        chip.append(thumb);
        const remove = element("button", "chip-remove", "✕");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${image.name || "image"}`);
        remove.addEventListener("click", () => {
            state.images.splice(index, 1);
            renderAttachments();
        });
        chip.append(remove);
        ui.attachments.append(chip);
    });
}

function updateImageSupport(model) {
    // Pi reports accepted input modalities on the model itself.
    state.modelAcceptsImages = Array.isArray(model?.input) && model.input.includes("image");
    ui.attach.hidden = !state.modelAcceptsImages;
    if (!state.modelAcceptsImages && state.images.length > 0) {
        state.images = [];
        renderAttachments();
        addEntry("notice", "notice", "Attachments cleared: this model does not accept images.");
    }
}

// --- Loading ----------------------------------------------------------------

async function loadTranscript() {
    const data = await command({ type: "get_messages" });
    if (!data || !Array.isArray(data.messages)) {
        return;
    }

    ui.transcript.replaceChildren();
    for (const message of data.messages) {
        const text = contentText(message.content);
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
    ui.statContext.textContent = typeof percent === "number" ? `${percent}%` : "—";
    renderUsage(data);
    if (typeof data.sessionFile === "string") {
        state.sessionPath = data.sessionFile;
    }
}

async function loadModels() {
    const data = await command({ type: "get_available_models" });
    const models = Array.isArray(data?.models) ? data.models : [];
    ui.model.replaceChildren();
    for (const model of models) {
        const option = element("option", null, model.name || model.id);
        option.value = model.id;
        ui.model.append(option);
    }

    const current = await command({ type: "get_state" });
    if (current?.model?.id) {
        ui.model.value = current.model.id;
        updateImageSupport(models.find((model) => model.id === current.model.id) || current.model);
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
            loadSessions();
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
        case "extensionUi":
            applyExtensionUi(payload.request);
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

async function send() {
    const text = ui.input.value.trim();
    const images = state.images;
    if (!text && images.length === 0) {
        return;
    }

    ui.input.value = "";
    state.images = [];
    renderAttachments();

    const entry = addEntry("you", "user", text);
    if (images.length > 0) {
        const strip = element("div", "sent-images");
        for (const image of images) {
            const thumb = document.createElement("img");
            thumb.src = image.preview;
            thumb.alt = image.name || "attachment";
            strip.append(thumb);
        }

        entry.parentElement.append(strip);
    }

    const payload = { type: state.running ? "steer" : "prompt", message: text };
    if (images.length > 0) {
        payload.images = images.map((image) => ({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
        }));
    }

    await command(payload);
    if (!state.running) {
        setRunning(true);
    }
}

ui.send.addEventListener("click", send);
ui.stop.addEventListener("click", async () => {
    await command({ type: "abort" });
    setRunning(false);
});
ui.model.addEventListener("change", async () => {
    const data = await command({ type: "set_model", modelId: ui.model.value });
    if (data?.model) {
        updateImageSupport(data.model);
    }
});
ui.thinking.addEventListener("change", () => command({ type: "set_thinking_level", level: ui.thinking.value }));

ui.attach.addEventListener("click", () => ui.fileInput.click());
ui.fileInput.addEventListener("change", async () => {
    await addImages([...ui.fileInput.files]);
    ui.fileInput.value = "";
});

ui.openSessions.addEventListener("click", () => {
    openPanel(ui.sessionsPanel);
    loadSessions();
});
ui.closeSessions.addEventListener("click", closePanels);
ui.newSession.addEventListener("click", startNewSession);
ui.sessionFilter.addEventListener("input", renderSessions);
ui.openUsage.addEventListener("click", () => {
    openPanel(ui.usagePanel);
    refreshStats();
});
ui.closeUsage.addEventListener("click", closePanels);
ui.scrim.addEventListener("click", closePanels);

setInterval(tickExpiry, 1000);
connect();

if ("serviceWorker" in navigator) {
    // Only available in a secure context. Over a raw tunnel IP this registration
    // simply never happens, and the page keeps working without it.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
}
