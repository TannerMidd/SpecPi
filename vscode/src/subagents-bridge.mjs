import { randomUUID } from "node:crypto";
import subagents from "./subagents.js";

const { SUBAGENT_WIDGET, projectFleet } = subagents;
const REQUEST = "subagents:rpc:v1:request";
const READY = "subagents:rpc:v1:ready";
const REPLY = "subagents:rpc:v1:reply:";

// A connection-local observer loaded only by Chat. It uses the package's public
// event bus, registers no tools/commands, and never reads Pi files or starts work.
export default function subagentsBridge(pi) {
    if (process.env.PI_SUBAGENT_CHILD === "1") {
        return;
    }

    let context;
    let generation = 0;
    let timer;
    let pending;
    let available = false;
    let lastWidget;

    function publish(fleet) {
        const widget = fleet ? JSON.stringify(fleet) : undefined;
        if (context && (widget !== lastWidget || fleet?.totalActive)) {
            lastWidget = widget;
            context.ui.setWidget(SUBAGENT_WIDGET, widget ? [widget] : undefined);
        }
    }

    function cancelPending() {
        if (pending) {
            clearTimeout(pending.timer);
            pending.unsubscribe?.();
            pending.resolve(null);
            pending = undefined;
        }
    }

    function request(method) {
        const requestId = randomUUID();

        return new Promise((resolve) => {
            const item = { resolve };
            pending = item;
            const finish = (value) => {
                if (pending !== item) {
                    return;
                }

                clearTimeout(item.timer);
                item.unsubscribe?.();
                pending = undefined;
                resolve(value);
            };

            item.unsubscribe = pi.events.on(`${REPLY}${requestId}`, (reply) => {
                if (reply?.version === 1 && reply.requestId === requestId) {
                    finish(reply.success === true ? reply.data : null);
                }
            });
            item.timer = setTimeout(() => finish(null), 2000);
            item.timer.unref?.();
            try {
                pi.events.emit(REQUEST, { version: 1, requestId, method });
            } catch {
                finish(null);
            }
        });
    }

    function schedule(delay) {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), delay);
        timer.unref?.();
    }

    async function refresh() {
        if (!context || pending) {
            return;
        }

        const epoch = generation;
        if (!available) {
            const ping = await request("ping");
            if (epoch !== generation) {
                return;
            }

            available = ping?.capabilities?.fleetStatus?.version === 1;
            if (!available) {
                publish(null);

                return;
            }
        }

        const response = await request("status");
        if (epoch !== generation) {
            return;
        }

        const fleet = projectFleet(response?.fleet);
        publish(fleet);
        schedule(fleet?.totalActive ? 1000 : 5000);
    }

    function reset() {
        generation += 1;
        clearTimeout(timer);
        cancelPending();
        publish(null);
        context = undefined;
        available = false;
        lastWidget = undefined;
    }

    const unsubscribeReady = pi.events.on(READY, () => {
        if (context) {
            schedule(0);
        }
    });
    pi.on("session_start", (_event, ctx) => {
        reset();
        context = ctx;
        // Do not await another extension's session_start readiness.
        schedule(0);
    });
    pi.on("tool_result", (event) => {
        if (context && event.toolName === "subagent") {
            schedule(0);
        }
    });
    pi.on("session_shutdown", () => {
        reset();
        unsubscribeReady?.();
    });
}
