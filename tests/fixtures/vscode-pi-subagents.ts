import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Synthetic implementation of the public pi-subagents 0.67.0 fleetStatus v1 API.
// No workers, providers, or persisted child state are used by this fixture.
export default function fixture(pi: ExtensionAPI) {
    let session = 0;
    let active = true;
    const capabilities = { fleetStatus: { version: 1 } };
    pi.events.on("subagents:rpc:v1:request", (request: any) => {
        const data =
            request.method === "ping"
                ? { capabilities }
                : request.method === "status"
                  ? {
                        fleet: {
                            version: 1,
                            totalActive: active ? 1 : 0,
                            omitted: 0,
                            entries: active
                                ? [
                                      {
                                          key: "opaque-1",
                                          agent: "reviewer",
                                          goal: `Synthetic session ${session}`,
                                          model: "offline-fixture",
                                          startedAt: 1000,
                                          tokens: { input: 10, output: 5, total: 15 },
                                      },
                                  ]
                                : [],
                        },
                        asyncSnapshot: { private: "NOT_FOR_THE_WEBVIEW" },
                    }
                  : undefined;
        if (!data) {
            throw new Error(`Unexpected control request: ${request.method}`);
        }

        pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
            version: 1,
            requestId: request.requestId,
            success: true,
            data,
        });
    });
    pi.on("session_start", () => {
        session += 1;
        active = true;
        pi.events.emit("subagents:rpc:v1:ready", { capabilities });
    });
    pi.registerCommand("fleet-fixture-finish", {
        description: "Finish synthetic fleet activity",
        handler: async () => {
            active = false;
            pi.events.emit("subagents:rpc:v1:ready", { capabilities });
        },
    });
}
