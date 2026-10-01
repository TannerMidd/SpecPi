import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeCommand, judgePath, reviewReason } from "../src/gate.ts";
import { DEFAULT_SETTINGS } from "../src/rules.ts";

const S = { ...DEFAULT_SETTINGS };

function scorer(verdict) {
    const calls = [];
    const score = async (command, shell) => {
        calls.push([command, shell]);
        if (verdict instanceof Error) {
            throw verdict;
        }

        return verdict;
    };

    return { score, calls };
}

describe("local rules decide before LANCET", () => {
    it("a hard-deny block never reaches the model", async () => {
        const { score, calls } = scorer({ classification: "not_flagged", score: 0.01, reason: null });
        const decision = await judgeCommand("rm -rf /", "bash", S, score);
        assert.equal(decision.action, "block");
        assert.equal(decision.source, "rules");
        assert.equal(decision.terminate, true);
        assert.equal(calls.length, 0);
    });

    it("a read-only command passes without a model call or an audit record", async () => {
        const { score, calls } = scorer(new Error("must not be called"));
        const decision = await judgeCommand("git status --short", "bash", S, score);
        assert.deepEqual(decision, {
            action: "allow",
            source: "rules",
            reason: "read-only command chain",
            audited: false,
        });
        assert.equal(calls.length, 0);
    });

    it("the user's allowed list passes with an audit record", async () => {
        const { score } = scorer(new Error("must not be called"));
        const decision = await judgeCommand("make deploy", "bash", { ...S, allowedCommands: ["make *"] }, score);
        assert.equal(decision.action, "allow");
        assert.equal(decision.source, "allowlist");
        assert.equal(decision.audited, true);
    });
});

describe("LANCET verdicts", () => {
    it("not_flagged runs, with its score recorded", async () => {
        const { score, calls } = scorer({ classification: "not_flagged", score: 0.1, reason: null });
        const decision = await judgeCommand("npm test", "bash", S, score);
        assert.equal(decision.action, "allow");
        assert.equal(decision.source, "lancet");
        assert.equal(decision.score, 0.1);
        assert.deepEqual(calls, [["npm test", "bash"]]);
    });

    it("risky asks by default and blocks when configured to", async () => {
        const { score } = scorer({ classification: "risky", score: 0.9, reason: null });
        const asked = await judgeCommand("npm publish", "bash", S, score);
        assert.equal(asked.action, "ask");
        assert.equal(asked.score, 0.9);
        const blocked = await judgeCommand("npm publish", "bash", { ...S, risky: "block" }, score);
        assert.equal(blocked.action, "block");
        assert.equal(blocked.source, "lancet");
    });

    it("Nano's uncertain band asks, even when risky verdicts block", async () => {
        const { score } = scorer({ classification: "review", score: 0.83, reason: "uncertainty-band" });
        const decision = await judgeCommand("git clean -fdx", "bash", { ...S, risky: "block" }, score);
        assert.equal(decision.action, "ask");
        assert.equal(decision.source, "lancet");
        assert.equal(decision.score, 0.83);
        assert.match(decision.reason, /unsure/u);
    });

    it("a command LANCET cannot read asks, whatever the risky policy", async () => {
        const command = `Remove-Item ${"x".repeat(9000)}`;
        const { score, calls } = scorer({ classification: "review", score: null, reason: "raw-input-too-long" });
        const decision = await judgeCommand(command, "powershell", { ...S, risky: "block" }, score);
        assert.equal(decision.action, "ask");
        assert.equal(decision.source, "unsupported");
        assert.match(decision.reason, /8,192 bytes/u);
        assert.deepEqual(calls, [[command, "powershell"]]);
    });

    it("fails closed when the model is unavailable", async () => {
        const { score } = scorer(new Error("the LANCET model is not downloaded; run /lancet-guard setup"));
        const decision = await judgeCommand("npm publish", "bash", S, score);
        assert.equal(decision.action, "block");
        assert.equal(decision.source, "unavailable");
        assert.equal(decision.terminate, false);
        assert.match(decision.reason, /setup/u);
    });

    it("explains every review reason the runtime can give", () => {
        for (const reason of [
            "unsupported-shell",
            "command-not-string",
            "empty-command",
            "nul-byte",
            "invalid-unicode",
            "raw-input-too-long",
            "nonfinite-model-output",
        ]) {
            assert.notEqual(reviewReason(reason), reviewReason(null), reason);
        }
    });
});

describe("writes and edits", () => {
    it("ordinary project files are not gated", () => {
        assert.equal(judgePath("/repo/src/index.ts", "/repo", S), undefined);
    });

    it("protected, out-of-workspace and missing paths ask", () => {
        for (const target of ["/repo/.env", "/etc/hosts", "/repo/../other/x", ""]) {
            const decision = judgePath(target, "/repo", S);
            assert.equal(decision?.action, "ask", target);
            assert.equal(decision?.source, "path", target);
        }
    });
});

describe("defaults", () => {
    it("ships off, asking on risky, and failing closed without a UI", () => {
        assert.equal(DEFAULT_SETTINGS.enabled, false);
        assert.equal(DEFAULT_SETTINGS.risky, "ask");
        assert.equal(DEFAULT_SETTINGS.uncertain, "ask");
    });
});
