import { StringDecoder } from "node:string_decoder";

// Parse before retaining a bounded output tail: a long final message must never
// erase evidence that a native tool accessed context outside the protocol.
export function codexEventReader() {
    const decoder = new StringDecoder("utf8");
    const observed = new Set();
    const state = { usage: null, toolEvents: [], error: null, completed: false };
    let pending = "";
    const line = (value) => {
        if (!value.trim()) {
            return;
        }

        try {
            const event = JSON.parse(value);
            if (event.type === "turn.completed") {
                state.usage = event.usage ?? null;
                state.completed = true;
            } else if (event.type === "turn.failed" || event.type === "error") {
                state.error = "Codex reported a failed turn or stream error.";
            }

            if (event.type?.startsWith("item.")) {
                const type = event.item?.type;
                // These items contain no external execution. Unknown item kinds
                // fail closed until a reviewed CLI contract recognizes them.
                if (!["agent_message", "reasoning", "todo_list"].includes(type)) {
                    const key = `${event.item?.id ?? "unknown"}:${type}`;
                    if (!observed.has(key)) {
                        observed.add(key);
                        state.toolEvents.push(type ?? "unknown");
                    }
                }
            }
        } catch {
            state.error = "Codex emitted malformed JSONL; protocol coverage is incomplete.";
        }
    };

    const consume = (value) => {
        pending += value;
        let offset;
        while ((offset = pending.indexOf("\n")) !== -1) {
            const next = pending.slice(0, offset);
            pending = pending.slice(offset + 1);
            if (next.length > 1024 * 1024) {
                state.error = "Codex event exceeded the stream bound.";
            } else {
                line(next);
            }
        }

        if (pending.length > 1024 * 1024) {
            state.error = "Codex event exceeded the stream bound.";
            pending = "";
        }
    };

    return {
        state,
        write(chunk) {
            consume(decoder.write(chunk));
        },
        end() {
            consume(decoder.end());
            line(pending);
            pending = "";

            return state;
        },
    };
}
