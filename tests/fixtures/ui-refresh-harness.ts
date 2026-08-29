import registerPromptRefresh from "../../extensions/ui-refresh/index.ts";

const events = new Map<string, any[]>();
const widgetCalls: any[] = [];
let renderCount = 0;

const pi: any = {
  on(name: string, handler: any) {
    const handlers = events.get(name) ?? [];
    handlers.push(handler);
    events.set(name, handlers);
  },
};

registerPromptRefresh(pi);

const tui = { renderNow() { renderCount += 1; } };
const ctx: any = {
  mode: "tui",
  ui: {
    setWidget(key: string, content: any) {
      widgetCalls.push({ key, cleared: content === undefined });
      if (typeof content === "function") content(tui, {});
    },
  },
};

for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
for (const handler of events.get("ui_prompt_start") ?? []) await handler({ kind: "select" }, ctx);
for (const handler of events.get("ui_prompt_start") ?? []) await handler({ kind: "input" }, ctx);
await new Promise<void>((resolve) => setImmediate(resolve));
for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);

process.stdout.write(`ZENPI_UI_REFRESH_HARNESS=${JSON.stringify({
  eventNames: [...events.keys()],
  widgetCalls,
  renderCount,
})}\n`);
