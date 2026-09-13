import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const repositoryOracleIds = [
    "repo-output-streams",
    "repo-slot-admission",
    "repo-receipt-freshness",
    "repo-command-redaction",
];
export async function evaluateRepository(id, root) {
    const load = (name) => import(pathToFileURL(path.join(root, name)).href);
    if (id === "repo-output-streams") {
        const { OutputRing } = await load("extensions/background-tasks/core.mjs");
        const ring = new OutputRing(128);
        const stdout = Buffer.from("😀 café\u0007");
        const stderr = Buffer.from("界 error");
        ring.append("stdout", stdout.subarray(0, 2));
        ring.append("stderr", stderr.subarray(0, 1));
        ring.append("stdout", stdout.subarray(2));
        ring.append("stderr", stderr.subarray(1));
        ring.append("stdout", undefined, true);
        ring.append("stderr", undefined, true);
        const output = ring.read();
        assert.ok(output.output.includes("😀 café\\u0007"));
        assert.ok(output.output.includes("界 error"));
        assert.equal(output.output.includes("�"), false);
        const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
        assert.deepEqual(ring.digests(), {
            stdout: { bytes: stdout.length, sha256: hash(stdout) },
            stderr: { bytes: stderr.length, sha256: hash(stderr) },
        });
        const overflow = new OutputRing(30);
        const bytes = Buffer.from("😀".repeat(100));
        overflow.append("stdout", bytes);
        assert.ok(overflow.bytes.length <= 30);
        assert.equal(overflow.read().output.includes("�"), false);
        assert.equal(overflow.digests().stdout.sha256, hash(bytes));
        assert.ok(overflow.read().lostBytes > 0);
        assert.throws(() => overflow.read(overflow.end + 1));
        assert.equal(overflow.read(overflow.end).output, "");
        const incomplete = new OutputRing();
        incomplete.append("stderr", Buffer.from([0xe2]));
        incomplete.append("stderr", undefined, true);
        assert.ok(incomplete.read().output.includes("�"), "finalization must flush an incomplete terminal sequence");
    } else if (id === "repo-slot-admission") {
        const { TaskRunner } = await load("extensions/background-tasks/core.mjs");
        for (const status of ["starting", "stopping", "cleanup-unconfirmed", "failed"]) {
            let spawns = 0;
            const runner = new TaskRunner({
                spawnProcess: () => {
                    spawns += 1;
                    throw new Error("synthetic spawn");
                },
                terminate: async () => true,
            });
            for (let index = 0; index < 4; index += 1) {
                runner.tasks.set(String(index), { status, cleanup: "unconfirmed" });
            }

            await assert.rejects(
                runner.start({ cwd: root, command: "synthetic", timeoutSeconds: 1 }, 1),
                /four active|admission/i,
            );
            assert.equal(spawns, 0);
            assert.equal(runner.tasks.size, 4);
        }

        let spawns = 0;
        const runner = new TaskRunner({
            spawnProcess: () => {
                spawns += 1;
                throw new Error("synthetic spawn");
            },
            terminate: async () => true,
        });
        for (let index = 0; index < 4; index += 1) {
            runner.tasks.set(String(index), { cleanup: "confirmed" });
        }

        await runner.start({ cwd: root, command: "synthetic", label: "check", timeoutSeconds: 1 }, 1);
        assert.equal(spawns, 1);
        runner.closed = true;
        await assert.rejects(runner.start({}, 1));
        assert.equal(spawns, 1);
    } else if (id === "repo-receipt-freshness") {
        const { VerificationRegistry, captureInputs, normalizeVerification } = await load(
            "extensions/background-tasks/verification.mjs",
        );
        const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-receipt-oracle-")));
        try {
            fs.mkdirSync(path.join(workspace, "src"));
            fs.writeFileSync(path.join(workspace, "src", "a.mjs"), "original");
            fs.writeFileSync(path.join(workspace, "config.json"), "{}");
            const binding = normalizeVerification(
                { command: "synthetic check", inputs: ["src/", "config.json"] },
                workspace,
            );
            const before = captureInputs(workspace, binding.inputs);
            const good = { status: "exited", exitCode: 0, reason: "command exited", cleanup: "confirmed" };
            const registry = new VerificationRegistry();
            const receipt = registry.add(binding, before, before, good, {});
            assert.equal(registry.resolve(receipt.id, workspace).status, "passed");
            fs.writeFileSync(path.join(workspace, "config.json"), '{"changed":true}');
            assert.equal(registry.resolve(receipt.id, workspace).status, "stale");
            fs.writeFileSync(path.join(workspace, "config.json"), "{}");
            fs.writeFileSync(path.join(workspace, "src", "new.mjs"), "new");
            assert.equal(registry.resolve(receipt.id, workspace).status, "stale");
            fs.unlinkSync(path.join(workspace, "src", "new.mjs"));
            const returned = registry.resolve(receipt.id, workspace);
            returned.after.digest = "forged";
            returned.outcome.exitCode = 7;
            assert.equal(registry.resolve(receipt.id, workspace).status, "passed");
            for (const changes of [
                { exitCode: 9 },
                { cleanup: "unconfirmed" },
                { status: "killed" },
                { reason: "cancelled" },
            ]) {
                const failed = registry.add(binding, before, before, { ...good, ...changes }, {});
                assert.equal(registry.resolve(failed.id, workspace).status, "failed");
            }

            fs.unlinkSync(path.join(workspace, "config.json"));
            assert.equal(registry.resolve(receipt.id, workspace).status, "stale");
            registry.invalidate();
            assert.equal(registry.resolve(receipt.id, workspace).status, "unknown");
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    } else if (id === "repo-command-redaction") {
        const { redactCommand, boundedReason } = await load("extensions/command-guard/redact.mjs");
        const secret = "syntheticCanary482";
        for (const command of [
            `curl https://example.invalid/?Token=${secret}&page=2`,
            `curl https://example.invalid/?q=ok&api-key=${secret}`,
            `curl https://example.invalid/?access_token=${secret}`,
            `tool --password '${secret} with spaces'`,
            `GITHUB_TOKEN=${secret} tool`,
            `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
            `curl https://user:${secret}@example.invalid/path`,
            `echo -----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
        ]) {
            assert.equal(redactCommand(command).includes(secret), false, "secret class must be redacted");
            assert.equal(boundedReason(command).includes(secret), false);
        }

        assert.ok(redactCommand(`curl https://example.invalid/?token=${secret}&page=2`).includes("page=2"));
        assert.equal(redactCommand("npm test -- --runInBand"), "npm test -- --runInBand");
        const bounded = redactCommand("😀".repeat(100), 40);
        assert.ok(Buffer.byteLength(bounded) <= 40);
        assert.equal(bounded.includes("�"), false);
    } else {
        throw new Error(`Unknown repository oracle ${id}`);
    }

    return { task: id, acceptance: "passed", maintainability: "requires-human-review" };
}
