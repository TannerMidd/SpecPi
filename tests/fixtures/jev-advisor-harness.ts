// Exercise the shipped hooks together, with a loopback classifier and disposable Pi state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import registerAdvisor from "../../extensions/jev-advisor/index.ts";
import registerWorkflow from "../../extensions/workflow-controls/index.ts";
import registerWishlist from "../../extensions/tool-wishlist/index.ts";
import { defaultSettings, saveSettings } from "../../extensions/jev-advisor/config.mjs";
import { saveConsent, revokeConsent } from "../../extensions/jev-advisor/consent.mjs";
import { readAll, summarize } from "../../extensions/jev-advisor/ledger.mjs";
import {
    setCollectionMode,
    recordCapabilityGap,
    refreshWishlist,
    WISHLIST_FILENAMES,
} from "../../extensions/tool-wishlist/core.mjs";
import {
    createTaskContract,
    TASK_CONTRACT_ENTRY,
    renderTaskContract,
} from "../../extensions/workflow-controls/task-contract.mjs";

export default async function advisorHarness() {
    const root = path.join(process.env.PI_CODING_AGENT_DIR!, "workspace");
    const stateDir = path.join(process.env.PI_CODING_AGENT_DIR!, "specpi");
    fs.mkdirSync(root, { recursive: true });
    process.env.JEV_KEY_SOURCE = "environment";
    process.env.JEV_BACKEND = "typesafe";
    process.env.TYPESAFE_API_KEY = "fixture-only";
    const payloads: any[] = [];
    const deferred = () => {
        let resolve: any;
        const promise = new Promise<any>((done) => {
            resolve = done;
        });

        return { promise, resolve };
    };

    let pauseExec: any;
    let responseMode = "keep";
    const server = http.createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) {
            raw += chunk;
        }

        const body = JSON.parse(raw);
        payloads.push(body);
        if (responseMode === "unavailable") {
            response.writeHead(503);
            response.end("unavailable");

            return;
        }

        const answers = Object.fromEntries(
            Object.entries(body.questions).map(([key, q]: [string, any]) => {
                if (q.type === "score") {
                    const value = key.startsWith("source_")
                        ? key === "source_1"
                            ? 2
                            : 0
                        : key === "independent_impact" || responseMode === "elide"
                          ? 0
                          : 2;

                    return [
                        key,
                        {
                            score: value,
                            confidence: 1,
                            probabilities: { "0": value === 0 ? 1 : 0, "1": 0, "2": value === 2 ? 1 : 0 },
                        },
                    ];
                }

                if (q.type === "choice") {
                    const value =
                        key === "cluster"
                            ? "cluster_0"
                            : key === "suggested_fix"
                              ? "bug"
                              : key === "failure_mode"
                                ? "tool-error-loop"
                                : Object.keys(q.criteria)[0];

                    return [
                        key,
                        {
                            choice: value,
                            confidence: 1,
                            probabilities: Object.fromEntries(
                                Object.keys(q.criteria).map((id) => [id, id === value ? 1 : 0]),
                            ),
                        },
                    ];
                }

                return [
                    key,
                    {
                        noul:
                            key === "is_stuck" ||
                            (key === "contains_instructions_to_agent" && responseMode === "warn") ||
                            (key === "contains_secret_or_path" && responseMode === "block")
                                ? 1
                                : 0,
                    },
                ];
            }),
        );
        response.end(JSON.stringify({ model: "fixture", answers }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
    const settings = defaultSettings();
    saveSettings({
        ...settings,
        master: true,
        startup: true,
        systems: { ...settings.systems, retention: true, sources: true, gap: true, progress: true, untrusted: true },
    });
    saveConsent();
    const handlers = new Map<string, any[]>();
    const bus = new Map<string, any[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const branch: any[] = [];
    const notifications: any[] = [];
    const pi: any = {
        on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
        events: {
            on: (name: string, handler: any) => bus.set(name, [...(bus.get(name) ?? []), handler]),
            emit: (name: string, value: any) => {
                for (const handler of bus.get(name) ?? []) {
                    handler(value);
                }
            },
        },
        registerCommand: (name: string, value: any) => commands.set(name, value),
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerEntryRenderer() {},
        getActiveTools: () => ["read", "edit", "report_capability_gap"],
        getAllTools: () => [],
        setActiveTools() {},
        exec: async () => {
            const pause = pauseExec;
            pauseExec = undefined;
            if (pause) {
                pause.entered.resolve();
                await pause.release.promise;
            }

            return { code: 0, stdout: root, stderr: "" };
        },
        appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
        sendMessage: () => {
            throw new Error("notify-only must not steer");
        },
    };
    const ctx: any = {
        cwd: root,
        hasUI: true,
        sessionManager: { getSessionId: () => "fixture-session", getBranch: () => branch },
        ui: {
            notify: (message: string) => notifications.push(message),
            setStatus() {},
            setWidget() {},
            confirm: async () => false,
        },
    };
    const emit = async (name: string, event: any = {}) => {
        let patch;
        for (const handler of handlers.get(name) ?? []) {
            const returned = await handler(event, ctx);
            if (returned) {
                patch = returned;
            }
        }

        return patch;
    };

    // Advisor loads first, reproducing the ordering in which rendered-prompt extraction failed.
    registerAdvisor(pi);
    registerWorkflow(pi);
    registerWishlist(pi);
    const contract = (objective: string) =>
        createTaskContract(
            {
                objective,
                requirements: [{ description: "Required behavior", acceptance: "Fixture passes" }],
                paths: [],
            },
            { root, origin: "human" },
        );
    const first = contract("Repair the real objective, not the Markdown heading");
    branch.push({ type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "set", contract: first } });
    const big = Array.from({ length: 300 }, (_, i) => `result ${i} ${"readable evidence ".repeat(10)}`).join("\n");
    const resultEvent = (toolName = "read", text = big) => ({
        toolName,
        input: { path: "src/module.ts" },
        content: [{ type: "text", text }],
        isError: false,
    });
    try {
        await emit("session_start");
        await emit("before_agent_start", {
            prompt: "Fallback request",
            systemPrompt: `[SPECPI TASK CONTRACT]\n${renderTaskContract(first)}`,
        });
        await emit("tool_result", resultEvent());
        assert.equal(payloads.at(-1).state.objective, first.objective);
        assert.ok(payloads.at(-1).state.result.head.length > 0);
        const second = contract("A different active task");
        branch.push({ type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "set", contract: second } });
        await emit("tool_result", resultEvent());
        assert.equal(
            payloads.at(-1).state.objective,
            second.objective,
            "contract changes refresh without another prompt",
        );
        branch.push({ type: "custom", customType: TASK_CONTRACT_ENTRY, data: { kind: "cleared" } });
        await emit("before_agent_start", { prompt: "Current request after clearing", systemPrompt: "" });
        await emit("tool_result", resultEvent());
        assert.equal(payloads.at(-1).state.objective, "Current request after clearing");
        branch.push({
            type: "custom",
            customType: TASK_CONTRACT_ENTRY,
            data: { kind: "set", contract: { ...second, digest: "bad" } },
        });
        await emit("before_agent_start", { prompt: "Malformed contract fallback", systemPrompt: "" });
        await emit("tool_result", resultEvent());
        assert.equal(payloads.at(-1).state.objective, "Malformed contract fallback");
        branch.length = 0;
        await emit("session_tree");
        const beforeEmpty = payloads.length;
        await emit("tool_result", resultEvent());
        assert.equal(payloads.length, beforeEmpty, "branch changes cannot reuse the previous request");
        await emit("before_agent_start", { prompt: "Inspect current evidence", systemPrompt: "" });
        await emit("input", { text: "The active steering request", source: "interactive", streamingBehavior: "steer" });
        await emit("tool_result", resultEvent());
        assert.equal(payloads.at(-1).state.objective, "The active steering request");
        await emit("input", { text: "A queued future task", source: "interactive", streamingBehavior: "followUp" });
        await emit("tool_result", resultEvent());
        assert.equal(
            payloads.at(-1).state.objective,
            "The active steering request",
            "queued follow-ups are not active requests",
        );

        // A result suspended in objective lookup still belongs to its original task/session.
        for (const boundary of ["session_tree", "session_shutdown"]) {
            const saved = bus.get("specpi:task-objective");
            const reply = deferred();
            bus.set("specpi:task-objective", [(request: any) => request.reply(reply.promise)]);
            const before = payloads.length;
            const pending = emit("tool_result", resultEvent("fetch_content"));
            await emit(boundary);
            reply.resolve({ objective: "Stale evidence", digest: "stale" });
            await pending;
            assert.equal(payloads.length, before, `${boundary} invalidates pending objective lookup`);
            bus.set("specpi:task-objective", saved!);
            if (boundary === "session_shutdown") {
                await emit("tool_result", resultEvent("fetch_content"));
                assert.equal(payloads.length, before, "shutdown also prevents newly arriving results");
                await emit("session_start");
            }

            await emit("before_agent_start", { prompt: "Current task after lifecycle change" });
        }

        const job = (id: string, mode: string, selected: string[]) => ({
            id,
            mode,
            question: `Inspect the ${id} behavior`,
            context: "Relevant context",
            sources: selected,
            requirements: ["R1"],
        });
        const input = {
            operation: "run",
            requestId: "r1",
            packet: {
                objective: "Parent objective",
                requirements: [{ id: "R1", text: "Check behavior" }],
                decisions: [],
                nonGoals: [],
                reason: { benefit: "independent_review", why: "Fresh review", parentWork: "" },
                jobs: [
                    job("scout", "scout", ["src/a.js", "src/b.js", "src/a.js"]),
                    job("review", "review", ["tests/a.js", "tests/b.js"]),
                ],
            },
        };
        const original = structuredClone(input);
        const start = payloads.length;
        await emit("tool_call", { toolName: "delegate", input });
        assert.equal(payloads.length - start, 2);
        assert.deepEqual(input.packet.jobs[0].sources, ["src/b.js", "src/a.js", "src/a.js"]);
        assert.deepEqual(input.packet.jobs[1].sources, ["tests/b.js", "tests/a.js"]);
        for (let i = 0; i < 2; i += 1) {
            assert.deepEqual([...input.packet.jobs[i].sources].sort(), [...original.packet.jobs[i].sources].sort());
            assert.equal(payloads[start + i].state.mode, original.packet.jobs[i].mode);
            assert.equal(payloads[start + i].state.question, original.packet.jobs[i].question);
            assert.ok(!JSON.stringify(payloads[start + i].questions).includes(".js"));
            input.packet.jobs[i].sources = original.packet.jobs[i].sources;
        }

        assert.deepEqual(input, original, "no job/packet field except source order changed");
        await emit("tool_call", { toolName: "delegate", input: { operation: "status" } });
        assert.equal(payloads.length - start, 2);
        const notify = ctx.ui.notify;
        ctx.ui.notify = () => {
            throw new Error("Synthetic notification failure");
        };

        const failedWarning = structuredClone(original);
        await emit("tool_call", { toolName: "delegate", input: failedWarning });
        ctx.ui.notify = notify;
        assert.deepEqual(failedWarning.packet.jobs[1].sources, ["tests/b.js", "tests/a.js"]);
        assert.equal(readAll().at(-1).applied, true);
        assert.deepEqual(readAll().at(-1).effects, ["sources-reordered"]);
        assert.equal(readAll().at(-1).gateThrew, true);

        const report = {
            capability: "Raster image comparison",
            scenario: "Compare rendered images",
            limitation: "No reusable visual comparison available",
            impact: "blocked",
            suggestedFix: "tool",
            workaround: "Manual inspection",
        };
        await setCollectionMode({ stateDir, mode: "off" });
        const beforeOff = payloads.length;
        const reportTool = tools.get("report_capability_gap");
        await reportTool.execute("off", report, undefined, undefined, ctx);
        assert.equal(payloads.length, beforeOff, "wishlist off sends no report to the advisor");
        await setCollectionMode({ stateDir, mode: "on" });
        await recordCapabilityGap({
            stateDir,
            cwd: root,
            sessionId: "seed",
            runId: "seed",
            gap: { ...report, capability: "Visual image comparison" },
        });
        const reported = await reportTool.execute("gap", report, undefined, undefined, ctx);
        assert.equal(reported.details.assessmentRecorded, true);
        const refreshed = await refreshWishlist({ stateDir });
        const stored = refreshed.events.find((item: any) => item.capability === report.capability);
        assert.equal(stored.canonicalKey, "raster-image-comparison");
        assert.equal(stored.impact, "blocked");
        assert.equal(stored.suggestedFix, "tool");
        assert.equal(stored.assessment.impactOpinion, "minor");
        assert.equal(stored.assessment.suggestedFix, "bug");
        assert.equal(stored.assessment.matchedKey, "visual-image-comparison");
        assert.equal(stored.assessment.basis, "reported-observation");
        assert.deepEqual(refreshed.decisions, [], "advice must not create human decisions");
        const group = refreshed.improvements.find((item: any) => item.canonicalKey === "raster-image-comparison");
        assert.equal(group.priority, 4, "the original impact still controls priority");
        assert.equal(group.qualified, true);
        assert.equal(group.state, "open", "a match is not an improvement selection");
        assert.match(fs.readFileSync(reported.details.reportPath, "utf8"), /not independent evidence/u);
        assert.equal(Object.hasOwn(report, "assessment"), false);
        const duplicate = await reportTool.execute("duplicate", report, undefined, undefined, ctx);
        assert.equal(duplicate.details.duplicate, true);
        assert.equal(readAll().at(-1).applied, false, "duplicate reports do not claim a persisted effect");
        responseMode = "block";
        await assert.rejects(
            reportTool.execute(
                "block",
                { ...report, capability: "Different blocked report" },
                undefined,
                undefined,
                ctx,
            ),
            /sensitive/u,
        );
        assert.ok(
            !(await refreshWishlist({ stateDir })).events.some(
                (item: any) => item.capability === "Different blocked report",
            ),
        );

        responseMode = "unavailable";
        const offline = await reportTool.execute(
            "offline",
            { ...report, capability: "Offline collection fallback" },
            undefined,
            undefined,
            ctx,
        );
        assert.equal(offline.details.recorded, true);
        assert.equal(offline.details.assessmentRecorded, false, "classifier failure preserves normal local collection");

        responseMode = "keep";
        // Binding starts before local consent, not after its awaited answer.
        fs.unlinkSync(path.join(stateDir, WISHLIST_FILENAMES.config));
        const confirm = ctx.ui.confirm;
        const localConsent = deferred();
        ctx.ui.confirm = () => localConsent.promise;
        const oldLocal = reportTool.execute("local-consent-race", report, undefined, undefined, ctx);
        const rejectedLocal = assert.rejects(oldLocal, /changed/u);
        await emit("session_tree");
        localConsent.resolve(true);
        await rejectedLocal;
        ctx.ui.confirm = confirm;
        await setCollectionMode({ stateDir, mode: "on" });

        // Root discovery cannot adopt an old report into a new task, even on the same branch.
        for (const change of ["run", "steer", "contract"]) {
            const before = payloads.length;
            const pause = { entered: deferred(), release: deferred() };
            pauseExec = pause;
            const pending = reportTool.execute(`root-${change}`, report, undefined, undefined, ctx);
            const rejected = assert.rejects(pending, /changed/u);
            await pause.entered.promise;
            if (change === "contract") {
                branch.push({
                    type: "custom",
                    customType: TASK_CONTRACT_ENTRY,
                    data: { kind: "set", contract: contract("Replacement contract") },
                });
            } else if (change === "steer") {
                await emit("input", {
                    text: "Replacement steering",
                    source: "interactive",
                    streamingBehavior: "steer",
                });
            } else {
                await emit("before_agent_start", { prompt: "Replacement request" });
            }

            pause.release.resolve();
            await rejected;
            assert.equal(payloads.length, before);
        }

        // Turning collection off during the separate transmission dialog prevents the send.
        revokeConsent();
        const consent = deferred();
        const consentOpened = deferred();
        ctx.ui.confirm = () => {
            consentOpened.resolve();

            return consent.promise;
        };

        const beforeConsent = payloads.length;
        const pendingConsent = reportTool.execute("transmission-race", report, undefined, undefined, ctx);
        const rejectedConsent = assert.rejects(pendingConsent, /changed|collection/u);
        await consentOpened.promise;
        await setCollectionMode({ stateDir, mode: "off" });
        consent.resolve(true);
        await rejectedConsent;
        assert.equal(payloads.length, beforeConsent);
        ctx.ui.confirm = confirm;
        await setCollectionMode({ stateDir, mode: "on" });
        saveConsent();

        // Later wishlist hooks must not lag behind the advisor's awaited objective lookup.
        for (const boundary of ["input", "before_agent_start"]) {
            revokeConsent();
            const consent = deferred();
            const opened = deferred();
            ctx.ui.confirm = () => {
                opened.resolve();

                return consent.promise;
            };

            const pending = reportTool.execute(`delayed-${boundary}`, report, undefined, undefined, ctx);
            await opened.promise;
            const saved = bus.get("specpi:task-objective");
            const objectiveReply = deferred();
            bus.set("specpi:task-objective", [(request: any) => request.reply(objectiveReply.promise)]);
            const before = payloads.length;
            const changing = emit(boundary, {
                prompt: "New task",
                text: "New task",
                source: "interactive",
                streamingBehavior: "steer",
            });
            consent.resolve(true);
            try {
                await assert.rejects(pending, /changed/u);
                assert.equal(payloads.length, before, "old report cannot send during objective lookup");
            } finally {
                objectiveReply.resolve(undefined);
                await changing;
                bus.set("specpi:task-objective", saved!);
                ctx.ui.confirm = confirm;
            }

            saveConsent();
        }

        // Disable advisory authority while its write is waiting on the wishlist lock.
        const recording = deferred();
        const listeners = bus.get("specpi:gap-triage")!;
        bus.set("specpi:gap-triage", [
            ...listeners,
            (request: any) => {
                const record = request.record;
                request.record = (...args: any[]) => {
                    recording.resolve();

                    return record(...args);
                };
            },
        ]);
        const lock = path.join(stateDir, WISHLIST_FILENAMES.lock);
        fs.mkdirSync(lock);
        const pendingWrite = reportTool.execute(
            "write-race",
            { ...report, capability: "Revoked advisory write" },
            undefined,
            undefined,
            ctx,
        );
        await recording.promise;
        await commands.get("jev").handler("disable gap", ctx);
        fs.rmdirSync(lock);
        const localOnly = await pendingWrite;
        assert.equal(localOnly.details.recorded, true);
        assert.equal(localOnly.details.assessmentRecorded, false);
        assert.equal(readAll().at(-1).applied, false);
        bus.set("specpi:gap-triage", listeners);
        await commands.get("jev").handler("enable gap", ctx);

        responseMode = "warn";
        const warned = await emit("tool_result", resultEvent("fetch_content"));
        assert.match(warned.content[0].text, /SpecPi: the content below/u);
        assert.equal(readAll().at(-1).savedBytes, 0);
        assert.deepEqual(readAll().at(-1).effects, ["warning"]);
        responseMode = "elide";
        const shortened = await emit("tool_result", resultEvent());
        assert.ok(Buffer.byteLength(shortened.content[0].text) < Buffer.byteLength(big));
        assert.equal(summarize(readAll()).elisions, 1);
        await emit("tool_result", resultEvent("read", "x".repeat(5000)));
        assert.equal(readAll().at(-1).applied, false, "a one-line result cannot claim shortening");

        responseMode = "keep";
        ctx.hasUI = false;
        for (let i = 0; i < 3; i += 1) {
            await emit("tool_result", { ...resultEvent("bash", "Command failed"), isError: true });
        }

        const progressBefore = readAll().length;
        await emit("turn_end");
        for (let i = 0; i < 200 && readAll().length === progressBefore; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const progress = readAll().at(-1);
        assert.equal(progress.system, "progress");
        assert.equal(progress.applied, false);
        assert.equal(progress.outcome, "no-delivery-channel");
        ctx.hasUI = true;
        await emit("turn_start", { turnIndex: 5 });
        const notifyBefore = readAll().length;
        await emit("turn_end");
        for (let i = 0; i < 200 && readAll().length === notifyBefore; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        assert.deepEqual(readAll().at(-1).effects, ["notification"]);
        await emit("before_agent_start", { prompt: "A new task must not rearm steering", systemPrompt: "" });
        for (let i = 0; i < 3; i += 1) {
            await emit("tool_result", { ...resultEvent("bash", "Command failed"), isError: true });
        }

        const afterNudge = payloads.length;
        await emit("turn_end");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(payloads.length, afterNudge, "the once-per-session nudge bound survives task changes");
        await commands.get("jev").handler("off --session", ctx);
        const offCount = payloads.length;
        await emit("before_agent_start", { prompt: "Do not send this", systemPrompt: "" });
        await emit("tool_result", resultEvent());
        await emit("tool_call", { toolName: "delegate", input: original });
        assert.equal(payloads.length, offCount);
        await emit("session_shutdown");
        console.log("JEV_ADVISOR_HARNESS=passed");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
