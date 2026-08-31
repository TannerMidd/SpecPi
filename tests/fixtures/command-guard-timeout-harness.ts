import registerCommandGuard from "../../extensions/command-guard/index.ts";

// Drives one guard instance whose UI answers every prompt after `selectDelayMs`, so a startup fallback and a
// human-paced approval can be told apart by which timeout each call site uses.
async function decide(dependencies: any, selectDelayMs: number) {
    const events = new Map<string, any[]>();
    const commands = new Map<string, any>();
    const pi: any = {
        on(name: string, handler: any) {
            events.set(name, [...(events.get(name) || []), handler]);
        },
        registerCommand(name: string, command: any) {
            commands.set(name, command);
        },
    };
    registerCommandGuard(pi, dependencies);
    const ctx: any = {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
            async select(_title: string, options: string[]) {
                await new Promise((resolve) => setTimeout(resolve, selectDelayMs));

                return options.includes("Allow once") ? "Allow once" : options[0];
            },
            async confirm() {
                await new Promise((resolve) => setTimeout(resolve, selectDelayMs));

                return true;
            },
            notify() {},
            setStatus() {},
        },
    };
    for (const handler of events.get("session_start") || []) {
        await handler({ reason: "startup" }, ctx);
    }

    await commands.get("guard").handler("strict", ctx);
    let result: any;
    for (const handler of events.get("tool_call") || []) {
        result = await handler({ toolName: "bash", input: { command: "git push --force" } }, ctx);
    }

    return result;
}

// A startup prompt that outruns its short bound must still fall back to Guard, while the approval that follows
// waits on the person instead of inheriting that bound.
const slowApprovalUnderShortStartup = await decide({ startupTimeoutMs: 20 }, 250);
const shortApprovalTimesOut = await decide({ startupTimeoutMs: 20, approvalTimeoutMs: 30 }, 250);
const legacyAliasBoundsBoth = await decide({ promptTimeoutMs: 30 }, 250);

process.stdout.write(
    `COMMAND_GUARD_TIMEOUT=${JSON.stringify({
        slowApprovalAllowed: !slowApprovalUnderShortStartup?.block,
        shortApprovalBlocked: shortApprovalTimesOut?.block === true,
        legacyAliasBlocked: legacyAliasBoundsBoth?.block === true,
    })}\n`,
);
