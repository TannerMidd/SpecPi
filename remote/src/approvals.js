// Pending approval registry.
//
// Every dialog Pi opens is bound to the connection that is able to answer it
// and to the agent's own request id. Three rules drive the whole module:
//
//   1. A dialog with no live connection is cancelled immediately. An approval
//      nobody can see must never sit open waiting to be granted.
//   2. A dialog larger than the display budget is cancelled, not truncated.
//      Approving against context the phone could not render is worse than
//      making the user approve at the terminal.
//   3. Expiry is enforced here, by our own timer. Pi auto-resolves a timed
//      dialog agent-side — for `select`, with `undefined` — and docs/rpc.md
//      says the client need not track timeouts. We cannot rely on that default
//      meaning "deny", so we race it and cancel first.
//
// The residual race is real: if the agent's auto-resolve lands before our
// cancel, the agent's default wins. That is a property of the RPC surface, not
// something this daemon can close. It is documented in SECURITY.md.

import { DIALOG_METHODS, FIRE_AND_FORGET_METHODS } from "./rpc-bridge.js";

// Roughly the largest dialog a phone can render honestly. Chat applies the same
// idea to its webview; the number is deliberately conservative.
const DEFAULT_DISPLAY_BUDGET_BYTES = 64 * 1024;

// How far ahead of the agent's own auto-resolve we cancel.
const EXPIRY_MARGIN_MS = 1500;
const MIN_EXPIRY_MS = 250;

// Ceiling for a dialog that carries no timeout at all, so a forgotten approval
// cannot pin the agent forever.
const UNTIMED_CEILING_MS = 10 * 60 * 1000;

export class ApprovalRegistry {
    constructor({
        bridge,
        broadcast,
        // Approvals go only to the stream that owns them. Broadcasting one to
        // every open tab would render a card the other tabs cannot answer.
        emit = broadcast,
        displayBudgetBytes = DEFAULT_DISPLAY_BUDGET_BYTES,
        now = () => Date.now(),
    }) {
        this.bridge = bridge;
        this.broadcast = broadcast;
        this.emit = emit;
        this.displayBudgetBytes = displayBudgetBytes;
        this.now = now;
        this.pending = new Map();
    }

    // Returns a small record describing what was done, for tests and logging.
    handleRequest(request, connectionId) {
        if (FIRE_AND_FORGET_METHODS.has(request.method)) {
            // Not all of these are messages for the user. `notify` is; the rest
            // are status entries, widgets, and window titles that extensions
            // fire constantly. The client routes them by method, so it has to
            // see the method rather than a pre-flattened "notice".
            this.broadcast({ type: "extensionUi", request });

            return { outcome: "display" };
        }

        if (!DIALOG_METHODS.has(request.method)) {
            // An unknown method could be a new dialog kind we cannot render.
            // Cancelling is the only safe reading.
            this.cancel(request.id, "unsupported-dialog");

            return { outcome: "cancelled", reason: "unsupported-dialog" };
        }

        const size = Buffer.byteLength(JSON.stringify(request), "utf8");
        if (size > this.displayBudgetBytes) {
            this.cancel(request.id, "display-budget");

            return { outcome: "cancelled", reason: "display-budget" };
        }

        if (connectionId === null || connectionId === undefined) {
            this.cancel(request.id, "no-connection");

            return { outcome: "cancelled", reason: "no-connection" };
        }

        const expiresInMs = this.expiryFor(request);
        const entry = {
            request,
            connectionId,
            expiresAt: this.now() + expiresInMs,
            timer: setTimeout(() => this.cancel(request.id, "expired"), expiresInMs),
        };
        entry.timer.unref?.();
        this.pending.set(request.id, entry);
        this.emit(connectionId, { type: "approval", request, expiresAt: entry.expiresAt });

        return { outcome: "pending", expiresInMs };
    }

    expiryFor(request) {
        if (typeof request.timeout !== "number" || !Number.isFinite(request.timeout)) {
            return UNTIMED_CEILING_MS;
        }

        return Math.max(request.timeout - EXPIRY_MARGIN_MS, MIN_EXPIRY_MS);
    }

    // Answering requires the same connection that the dialog was handed to.
    // A second phone, or a reconnected one, cannot grant an approval it never
    // saw rendered.
    answer(id, connectionId, payload) {
        const entry = this.pending.get(id);
        if (!entry) {
            return { ok: false, reason: "unknown-request" };
        }

        if (entry.connectionId !== connectionId) {
            return { ok: false, reason: "wrong-connection" };
        }

        const response = buildResponse(entry.request, payload);
        if (!response) {
            return { ok: false, reason: "invalid-response" };
        }

        this.clear(id);
        this.send(response);
        this.broadcast({ type: "approvalResolved", id, resolution: response });

        return { ok: true };
    }

    cancel(id, reason) {
        this.clear(id);
        this.send({ type: "extension_ui_response", id, cancelled: true });
        this.broadcast({ type: "approvalResolved", id, resolution: { cancelled: true }, reason });
    }

    // Called when the answering connection goes away. Everything it owned is
    // cancelled; nothing is left pending for the next connection to inherit.
    cancelForConnection(connectionId, reason = "disconnected") {
        const ids = [];
        for (const [id, entry] of this.pending) {
            if (entry.connectionId === connectionId) {
                ids.push(id);
            }
        }

        for (const id of ids) {
            this.cancel(id, reason);
        }

        return ids;
    }

    cancelAll(reason = "shutdown") {
        for (const id of [...this.pending.keys()]) {
            this.cancel(id, reason);
        }
    }

    clear(id) {
        const entry = this.pending.get(id);
        if (!entry) {
            return;
        }

        clearTimeout(entry.timer);
        this.pending.delete(id);
    }

    send(response) {
        try {
            this.bridge.write(response);
        } catch {
            // Pi is already gone. The dialog died with it, so there is nothing
            // left to cancel and nothing the user can do about it.
        }
    }

    snapshot() {
        return [...this.pending.values()].map((entry) => ({
            request: entry.request,
            expiresAt: entry.expiresAt,
        }));
    }
}

// Maps a UI answer onto the response shape docs/rpc.md specifies for each
// dialog kind. An answer that does not fit its dialog is rejected rather than
// coerced — coercing a malformed confirm into `true` would grant permission.
export function buildResponse(request, payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    if (payload.cancelled === true) {
        return { type: "extension_ui_response", id: request.id, cancelled: true };
    }

    if (request.method === "confirm") {
        if (typeof payload.confirmed !== "boolean") {
            return null;
        }

        return { type: "extension_ui_response", id: request.id, confirmed: payload.confirmed };
    }

    if (typeof payload.value !== "string") {
        return null;
    }

    if (request.method === "select") {
        const options = Array.isArray(request.options) ? request.options : [];
        // Only an option the agent actually offered may be returned.
        if (!options.includes(payload.value)) {
            return null;
        }
    }

    return { type: "extension_ui_response", id: request.id, value: payload.value };
}

export { DEFAULT_DISPLAY_BUDGET_BYTES, EXPIRY_MARGIN_MS, UNTIMED_CEILING_MS };
