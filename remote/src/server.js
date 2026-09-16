// Loopback HTTP server: authenticated SSE stream out, JSON commands in.
//
// Transport is SSE + POST rather than WebSocket. Node 22 ships a WebSocket
// client but no server, so the alternatives were a dependency or a hand-rolled
// RFC 6455 implementation. For a security-sensitive remote-control path a small
// audit surface is worth two code paths, and SSE's Last-Event-ID resume mirrors
// Pi's own `get_entries { since }` cursor — the same idiom at both layers.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalRegistry } from "./approvals.js";
import { ALLOWED_COMMANDS } from "./rpc-bridge.js";
import { listSessions, isInsideSessions } from "./sessions.js";

const clientRoot = fileURLToPath(new URL("../client/", import.meta.url));

// An explicit allowlist rather than path resolution. There is no traversal to
// defend against if no request-supplied path ever reaches the filesystem.
const STATIC_FILES = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
    ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
    ["/manifest.webmanifest", { file: "manifest.webmanifest", type: "application/manifest+json" }],
    ["/sw.js", { file: "sw.js", type: "text/javascript; charset=utf-8" }],
    ["/icon.svg", { file: "icon.svg", type: "image/svg+xml" }],
]);

// Generous enough for a prompt carrying a few downscaled phone photos as
// base64, which the 1 MB text limit could never hold.
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const EVENT_HISTORY_LIMIT = 500;
const SSE_KEEPALIVE_MS = 25000;

const SECURITY_HEADERS = {
    // The client renders model and tool output as text. The CSP is the backstop
    // that keeps a mistake from becoming script execution.
    "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
};

export class RemoteServer {
    constructor({ bridge, auth, host = "127.0.0.1", port = 8787, logger = console }) {
        this.bridge = bridge;
        this.auth = auth;
        this.host = host;
        this.port = port;
        this.logger = logger;
        this.connections = new Map();
        this.history = [];
        this.nextEventId = 1;
        this.approvals = new ApprovalRegistry({
            bridge,
            broadcast: (payload) => this.broadcast(payload),
        });
        this.server = createServer((request, response) => {
            this.route(request, response).catch((error) => {
                this.logger.error(`Request failed: ${error.message}`);
                sendJson(response, 500, { error: "Internal error" });
            });
        });
        this.wireBridge();
    }

    wireBridge() {
        this.bridge.on("event", (event) => this.broadcast({ type: "agent", event }));
        this.bridge.on("uiRequest", (request) => {
            this.approvals.handleRequest(request, this.activeConnectionId());
        });
        this.bridge.on("protocolError", (error) => {
            this.logger.error(`RPC framing: ${error.message}`);
            this.broadcast({ type: "protocolError", message: error.message });
        });
        this.bridge.on("closed", (reason) => {
            this.approvals.cancelAll("agent-exited");
            this.broadcast({ type: "agentClosed", reason });
        });
        this.bridge.on("stderr", (chunk) => this.logger.error(`pi: ${chunk.trimEnd()}`));
    }

    // Approvals are handed to the newest connection. A phone that reconnects
    // gets a new id, so dialogs owned by the old one are cancelled rather than
    // silently inherited.
    activeConnectionId() {
        let active = null;
        for (const id of this.connections.keys()) {
            active = id;
        }

        return active;
    }

    async route(request, response) {
        const url = new URL(request.url, `http://${this.host}`);
        const auth = this.auth.authenticate(request, url);
        if (!auth.ok) {
            // Identical response for every unauthenticated path, so a probe
            // cannot map the surface or confirm the daemon's identity.
            response.writeHead(401, { ...SECURITY_HEADERS, "content-type": "text/plain" });
            response.end("Unauthorized\n");

            return;
        }

        if (request.method === "GET" && auth.source === "query" && STATIC_FILES.has(url.pathname)) {
            // Move the pairing token out of the URL immediately: it would
            // otherwise sit in history and in the Referer of any later request.
            response.writeHead(302, {
                ...SECURITY_HEADERS,
                "set-cookie": this.auth.cookieHeader(),
                location: url.pathname,
            });
            response.end();

            return;
        }

        if (request.method === "GET" && url.pathname === "/sessions") {
            await this.handleSessions(response);

            return;
        }

        if (request.method === "GET" && url.pathname === "/events") {
            this.openStream(request, response);

            return;
        }

        if (request.method === "POST" && url.pathname === "/command") {
            await this.handleCommand(request, response);

            return;
        }

        if (request.method === "POST" && url.pathname === "/approval") {
            await this.handleApproval(request, response);

            return;
        }

        if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
            await this.serveStatic(url.pathname, response);

            return;
        }

        sendJson(response, 404, { error: "Not found" });
    }

    async serveStatic(pathname, response) {
        const entry = STATIC_FILES.get(pathname);
        const body = await readFile(path.join(clientRoot, entry.file));
        response.writeHead(200, { ...SECURITY_HEADERS, "content-type": entry.type });
        response.end(body);
    }

    openStream(request, response) {
        const id = randomUUID();
        response.writeHead(200, {
            ...SECURITY_HEADERS,
            "content-type": "text/event-stream",
            connection: "keep-alive",
            // Defeats proxy buffering, which would otherwise stall streaming.
            "x-accel-buffering": "no",
        });

        const previous = this.activeConnectionId();
        this.connections.set(id, response);
        if (previous) {
            // Only one phone drives the agent. The older stream is closed and
            // its pending approvals cancelled, never transferred.
            this.approvals.cancelForConnection(previous, "superseded");
            this.closeStream(previous);
        }

        const keepalive = setInterval(() => {
            response.write(": keepalive\n\n");
        }, SSE_KEEPALIVE_MS);
        keepalive.unref?.();

        // Listen on the response, not the request. A GET carries no body, so the
        // request stream can settle long before the connection actually drops;
        // the response is what stays open for the life of the stream. Getting
        // this wrong leaves approvals pending for seconds after the phone is
        // gone — exactly the window the binding exists to close.
        const disconnected = () => {
            clearInterval(keepalive);
            if (!this.connections.has(id)) {
                return;
            }

            this.connections.delete(id);
            this.approvals.cancelForConnection(id, "disconnected");
        };

        response.on("close", disconnected);
        request.on("aborted", disconnected);

        this.writeEvent(response, { type: "connected", connectionId: id }, this.nextEventId++);
        this.replay(request, response);
        for (const item of this.approvals.snapshot()) {
            this.writeEvent(response, { type: "approval", ...item }, this.nextEventId++);
        }
    }

    // SSE resume. The client's Last-Event-ID tells us how far it got; anything
    // newer is replayed. A gap wider than the buffer is reported rather than
    // papered over, so the UI can refetch the transcript instead of showing a
    // silently truncated one.
    replay(request, response) {
        const header = request.headers["last-event-id"];
        if (!header) {
            return;
        }

        const since = Number.parseInt(header, 10);
        if (!Number.isFinite(since)) {
            return;
        }

        const oldest = this.history.length > 0 ? this.history[0].id : this.nextEventId;
        if (since + 1 < oldest) {
            this.writeEvent(response, { type: "resumeGap", since, oldest }, this.nextEventId++);

            return;
        }

        for (const item of this.history) {
            if (item.id > since) {
                this.writeEvent(response, item.payload, item.id);
            }
        }
    }

    broadcast(payload) {
        const id = this.nextEventId++;
        this.history.push({ id, payload });
        if (this.history.length > EVENT_HISTORY_LIMIT) {
            this.history.shift();
        }

        for (const [, response] of this.connections) {
            this.writeEvent(response, payload, id);
        }
    }

    writeEvent(response, payload, id) {
        if (response.writableEnded) {
            return;
        }

        response.write(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
    }

    closeStream(id) {
        const response = this.connections.get(id);
        if (!response) {
            return;
        }

        this.connections.delete(id);
        response.end();
    }

    async handleSessions(response) {
        try {
            sendJson(response, 200, { sessions: await listSessions({ env: this.bridge.env }) });
        } catch (error) {
            sendJson(response, 500, { error: error.message });
        }
    }

    async handleCommand(request, response) {
        const body = await readJson(request);
        if (!body.ok) {
            this.rejectBody(request, response, body);

            return;
        }

        const command = body.value;
        if (!command || typeof command.type !== "string") {
            sendJson(response, 400, { error: "Missing command type" });

            return;
        }

        if (!ALLOWED_COMMANDS.has(command.type)) {
            sendJson(response, 403, { error: `Command not permitted over Remote: ${command.type}` });

            return;
        }

        // switch_session takes a filesystem path, so it is the one command that
        // could point the agent at a file outside its own session tree. Being
        // authenticated is not a reason to allow that.
        if (command.type === "switch_session" && !isInsideSessions(command.sessionPath, this.bridge.env)) {
            sendJson(response, 403, { error: "Session path is outside the agent's sessions directory" });

            return;
        }

        try {
            const result = await this.bridge.send(command);
            sendJson(response, 200, result);
        } catch (error) {
            sendJson(response, 502, { error: error.message });
        }
    }

    async handleApproval(request, response) {
        const body = await readJson(request);
        if (!body.ok) {
            this.rejectBody(request, response, body);

            return;
        }

        const { id, connectionId, ...payload } = body.value ?? {};
        if (typeof id !== "string" || typeof connectionId !== "string") {
            sendJson(response, 400, { error: "Missing approval id or connection id" });

            return;
        }

        const result = this.approvals.answer(id, connectionId, payload);
        if (!result.ok) {
            sendJson(response, 409, { error: result.reason });

            return;
        }

        sendJson(response, 200, { ok: true });
    }

    // A refused body still has to be drained. Leaving it unread stalls the
    // client mid-upload until a timeout, and destroying the socket outright
    // resets the connection before our reply lands. resume() discards the rest
    // without buffering it, so the client finishes writing and reads the 413.
    rejectBody(request, response, body) {
        sendJson(response, body.oversize ? 413 : 400, { error: body.error });
        if (body.oversize) {
            request.resume();
        }
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            // Binding 127.0.0.1 is the boundary. Reachability from a phone comes
            // from a tunnel, never from an exposed listener.
            this.server.listen(this.port, this.host, () => {
                this.server.removeListener("error", reject);
                resolve(this.server.address());
            });
        });
    }

    async close() {
        this.approvals.cancelAll("shutdown");
        for (const id of [...this.connections.keys()]) {
            this.closeStream(id);
        }

        // server.close() only stops new connections; it then waits for every
        // existing one to end. An idle keep-alive socket left over from a POST,
        // or an SSE stream whose client has gone quiet without closing, would
        // hold shutdown open indefinitely.
        this.server.closeAllConnections?.();
        await new Promise((resolve) => this.server.close(resolve));
    }
}

async function readJson(request) {
    // Reject on the declared length first, so an oversized body is refused
    // before it is transferred rather than after. Without this the socket stays
    // occupied for the whole upload just to be told no at the end.
    const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return { ok: false, error: "Request body too large", oversize: true };
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            // A chunked body can lie about its length, so the streaming guard
            // stays and tears the connection down when it trips.
            return { ok: false, error: "Request body too large", oversize: true };
        }

        chunks.push(chunk);
    }

    if (chunks.length === 0) {
        return { ok: true, value: {} };
    }

    try {
        return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
        return { ok: false, error: "Malformed JSON body" };
    }
}

function sendJson(response, status, payload) {
    if (response.writableEnded) {
        return;
    }

    response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json" });
    response.end(JSON.stringify(payload));
}

export { STATIC_FILES, MAX_BODY_BYTES, EVENT_HISTORY_LIMIT };
