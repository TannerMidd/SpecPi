import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPiFixture } from "../scripts/pi-test-harness.mjs";

test("ordinary Pi native entry uses its public registry and preserves guarded ownership across rebind", (context) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-native-entry-")));
    try {
        fs.writeFileSync(path.join(root, "fixture.md"), "Public native fixture evidence.\n");
        const result = runPiFixture(path.resolve("tests/fixtures/delegation-native-harness.ts"), {
            cwd: root,
            env: { HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "", NODE_USE_ENV_PROXY: "" },
        });
        if (result.unavailable) {
            context.skip(result.error?.message ?? "Pi is unavailable");

            return;
        }

        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const marker = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/u)
            .find((line) => line.startsWith("NATIVE_ENTRY_FIXTURE="));
        assert.ok(marker, `${result.stderr}\n${result.stdout}`);
        const report = JSON.parse(marker.slice("NATIVE_ENTRY_FIXTURE=".length));
        for (const observation of [
            "ordinaryEntryRegistered",
            "publicRegistryCompleted",
            "defaultOff",
            "headlessActivationDenied",
            "sameModel",
            "snapshotRead",
            "strictGuardIntercepted",
            "parentHooksNotInherited",
            "reloadedModuleSharesController",
            "oldCallbacksInert",
            "heldSlotsPreserved",
            "oldResultStale",
            "sharedCallCounter",
            "batchQuotaPreserved",
            "differentRootDenied",
            "activeToolGated",
        ]) {
            assert.equal(report[observation], true, observation);
        }

        assert.equal(report.calls, 7);
        assert.equal(report.batches, 4);
        assert.deepEqual(report.ceilings, { concurrency: 2, sessionCalls: 48, sessionBatches: 4 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("ordinary Pi public reload and session replacement retain delegation process counters", (context) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "specpi-native-reload-")));
    const fixture = path.resolve("tests/fixtures/delegation-native-harness.ts");
    try {
        const result = runPiFixture(fixture, {
            cwd: root,
            input: "",
            args: [
                "--offline",
                "--no-session",
                "--no-context-files",
                "--no-extensions",
                "--no-skills",
                "-e",
                fixture,
                "--print",
                "/native-fixture-reload",
                "/native-fixture-replace",
            ],
            env: {
                SPECPI_NATIVE_FIXTURE_MODE: "reload",
                HTTP_PROXY: "",
                HTTPS_PROXY: "",
                ALL_PROXY: "",
                NO_PROXY: "",
                NODE_USE_ENV_PROXY: "",
            },
        });
        if (result.unavailable) {
            context.skip(result.error?.message ?? "Pi is unavailable");

            return;
        }

        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const marker = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/u)
            .find((line) => line.startsWith("NATIVE_RELOAD_FIXTURE="));
        assert.ok(marker, `${result.stderr}\n${result.stdout}`);
        assert.deepEqual(JSON.parse(marker.slice("NATIVE_RELOAD_FIXTURE=".length)), {
            publicCommandReload: true,
            registrations: 2,
            reloadReason: "reload",
            enabled: false,
            activeTool: false,
            calls: 1,
            batches: 1,
            generationAdvanced: true,
            oldCallbackInert: true,
            lifecycle: ["command", "shutdown:reload", "start:reload"],
        });
        const replacementMarker = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/u)
            .find((line) => line.startsWith("NATIVE_REPLACEMENT_FIXTURE="));
        assert.ok(replacementMarker, `${result.stderr}\n${result.stdout}`);
        assert.deepEqual(JSON.parse(replacementMarker.slice("NATIVE_REPLACEMENT_FIXTURE=".length)), {
            publicNewSession: true,
            registrations: 3,
            startReason: "new",
            freshContext: true,
            initiallyOff: true,
            callsBefore: 1,
            batchesBefore: 1,
            callsAfter: 2,
            batchesAfter: 2,
            newWorkerCompleted: true,
            oldCallbackInert: true,
            finallyOff: true,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
