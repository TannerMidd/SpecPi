// The behaviour of `/jev on` and `/jev off`, which had no test coverage at all until this file.
//
// Everything these assert used to live in closures inside index.ts, which no test imports, so two
// review rounds found defects that a green suite could not have caught: a guard preference destroyed
// on a path that decided nothing, a fail-closed gate armed by a headless session that was told
// nothing changed, a message reporting the guard "left off" while it was on and blocking, and a
// rollback that never ran because the flag was set before the write.
//
// `layer.mjs` takes its world as an argument, so each of those is one object literal here.

import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_NAMES, defaultSettings } from "../extensions/jev-advisor/config.mjs";
import {
    applyLayer,
    enableSystems,
    layerScopeLine,
    layerToPersist,
    startupToPersist,
} from "../extensions/jev-advisor/layer.mjs";

const GUARD_CONFIG = "/home/example/.pi/jev-guard.json";

/** A guard whose every behaviour is a parameter, including whether its write succeeds. */
function fakeGuard({ installed = true, write = { applied: true, reason: "updated" } } = {}) {
    const calls = [];

    return {
        calls,
        deps: {
            fallbackPackage: "@gotgenes/pi-permission-system",
            installed: () => installed,
            keyEnvName: () => "OPENROUTER_API_KEY",
            configPath: () => GUARD_CONFIG,
            apply: (wanted) => {
                calls.push(wanted);

                return write;
            },
        },
    };
}

function deps({ env = {}, sources = [], guard = fakeGuard() } = {}) {
    return { env, keySources: () => sources, guard: guard.deps };
}

const stored = (overrides = {}) => ({ ...defaultSettings(), ...overrides });
const allSystems = (on) => Object.fromEntries(SYSTEM_NAMES.map((name) => [name, on]));
const withKey = { OPENROUTER_API_KEY: "sk-or-v1-x" };

test("turning the layer on turns its systems on, and only when none are chosen", () => {
    const off = stored();
    assert.equal(
        SYSTEM_NAMES.every((name) => off.systems[name] === false),
        true,
        "the shipped default is every system off, which is what made this necessary",
    );

    const filled = enableSystems(off);
    assert.equal(filled.master, true);
    for (const name of SYSTEM_NAMES) {
        assert.equal(filled.systems[name], true, `${name} should come on with the layer`);
    }

    // A deliberate subset survives, so /jev off then /jev on does not hand back what was turned off.
    const chosen = stored({ systems: { ...allSystems(false), retention: true } });
    assert.deepEqual(enableSystems(chosen).systems, chosen.systems);
});

test("the guard is not armed without a key it can itself read", () => {
    // It is fail-closed, so arming it blind hands over a session that refuses to run commands. The
    // advisor having a key is not the question: the guard reads only its own environment variable.
    const guard = fakeGuard();
    const result = applyLayer(
        { on: true },
        { settings: stored(), guardEnabled: false },
        deps({ env: {}, sources: [{ name: "auth.json", present: true }], guard }),
    );

    assert.deepEqual(guard.calls, [], "nothing may be written when the guard cannot read a key");
    assert.equal(result.guardEnabled, false);
    assert.equal(result.guardChanged, false);
    assert.match(result.lines.join("\n"), /left off/u);
    assert.match(result.lines.join("\n"), /OPENROUTER_API_KEY/u);
});

test("a guard that is already on and keyless is reported as on, not as left off", () => {
    // The message that used to appear here read as reassurance at the exact moment the session was
    // broken: the guard was on, blocking every call it could not score, and being described as off.
    const result = applyLayer({ on: true }, { settings: stored(), guardEnabled: true }, deps({ env: {}, sources: [] }));

    const text = result.lines.join("\n");
    assert.match(text, /ALREADY ON/u);
    assert.match(text, /blocking calls it cannot score/u);
    assert.doesNotMatch(text, /left off/u);
});

test("--session never writes the guard's global configuration", () => {
    const guard = fakeGuard();
    const result = applyLayer(
        { on: true, sessionOnly: true },
        { settings: stored(), guardEnabled: false },
        deps({ env: withKey, guard }),
    );

    assert.deepEqual(guard.calls, [], "a session-scoped toggle must not change every other session");
    assert.equal(result.guardChanged, false);
    assert.equal(result.settings.master, true, "the advisor half is still switched on");
    assert.match(result.lines.join("\n"), /--session cannot scope it/u);
});

test("a session with no human never writes the guard's global configuration", () => {
    // It would change a fail-closed gate for every other Pi session on the machine while being told
    // "this session only", and every other startup-affecting branch of /jev already refuses.
    const guard = fakeGuard();
    const result = applyLayer(
        { on: true, interactive: false },
        { settings: stored(), guardEnabled: false },
        deps({ env: withKey, guard }),
    );

    assert.deepEqual(guard.calls, []);
    assert.equal(result.guardChanged, false);
    assert.match(result.lines.join("\n"), /needs a human interactive command/u);
});

test("an unwritable guard file leaves the session in the state it was actually in", () => {
    // The flag used to be set before the write and never rolled back, so the session believed the
    // guard was on and persisted a preference for a state just proved unreachable.
    const guard = fakeGuard({ write: { applied: false, reason: "unwritable" } });
    const result = applyLayer({ on: true }, { settings: stored(), guardEnabled: false }, deps({ env: withKey, guard }));

    assert.deepEqual(guard.calls, [true], "it tried");
    assert.equal(result.guardEnabled, false, "and did not pretend it succeeded");
    assert.equal(result.guardChanged, false);
    assert.match(result.lines.join("\n"), /could not be written/u);
});

test("arming the guard says it is machine-wide and that the key is not checked", () => {
    const guard = fakeGuard();
    const result = applyLayer({ on: true }, { settings: stored(), guardEnabled: false }, deps({ env: withKey, guard }));

    assert.deepEqual(guard.calls, [true]);
    assert.equal(result.guardEnabled, true);
    assert.equal(result.guardChanged, true);
    const text = result.lines.join("\n");
    assert.match(text, /every Pi session on this machine/u);
    // Presence is all that was checked, so a stale or revoked key still blocks everything. Saying
    // so is the difference between a disclosed trade and a surprise.
    assert.match(text, /stale or revoked/u);
});

test("turning the layer off returns command policy to the permission system", () => {
    const guard = fakeGuard();
    const result = applyLayer(
        { on: false },
        { settings: stored({ master: true, systems: allSystems(true) }), guardEnabled: true },
        deps({ env: withKey, guard }),
    );

    assert.equal(result.settings.master, false);
    assert.deepEqual(guard.calls, [false]);
    assert.equal(result.guardEnabled, false);
    assert.equal(result.guardChanged, true);
});

test("a guard preference is only rewritten by a command that actually wrote the guard", () => {
    // `/jev guard startup on` promises to leave the session alone. A later `/jev on` that decided
    // nothing about the guard -- not installed, or no readable key -- was discarding that silently.
    const preference = stored({ guard: { enabled: false, startup: true } });

    for (const state of [
        applyLayer({ on: true }, { settings: stored(), guardEnabled: false }, deps({ env: {}, guard: fakeGuard() })),
        applyLayer(
            { on: true },
            { settings: stored(), guardEnabled: false },
            deps({ env: withKey, guard: fakeGuard({ installed: false }) }),
        ),
        applyLayer(
            { on: true, sessionOnly: true },
            { settings: stored(), guardEnabled: false },
            deps({ env: withKey }),
        ),
    ]) {
        assert.equal(state.guardChanged, false);
        assert.deepEqual(
            layerToPersist(state, preference).guard,
            { enabled: false, startup: true },
            "a preference nobody touched must survive",
        );
    }

    // And when the command did write the guard, the preference follows it.
    const armed = applyLayer({ on: true }, { settings: stored(), guardEnabled: false }, deps({ env: withKey }));
    assert.equal(armed.guardChanged, true);
    assert.deepEqual(layerToPersist(armed, preference).guard, { enabled: true, startup: true });
});

test("what is persisted keeps master and startup together and preserves unrelated settings", () => {
    // Storing them apart is what made the Chat panel's checkbox do nothing on its own: session_start
    // zeroes a stored master whenever startup is false.
    const existing = stored({ budgets: { ...defaultSettings().budgets, total: 16 }, progressNudge: "message" });
    const on = applyLayer({ on: true }, { settings: stored(), guardEnabled: false }, deps({ env: withKey }));
    const written = layerToPersist(on, existing);

    assert.equal(written.master, true);
    assert.equal(written.startup, true);
    assert.equal(written.budgets.total, 16, "a budget written elsewhere must survive");
    assert.equal(written.progressNudge, "message");

    const off = applyLayer({ on: false }, { settings: stored({ master: true }), guardEnabled: true }, deps());
    const cleared = layerToPersist(off, existing);
    assert.equal(cleared.master, false);
    assert.equal(cleared.startup, false);
});

test("/jev startup writes both halves of the pair, and fills in the systems", () => {
    // It was the last command still writing `startup` without `master` -- the exact trap the rest of
    // this work removes, left in the command named after it, while reporting new sessions would
    // start on when they would not.
    const on = startupToPersist(true, stored());
    assert.equal(on.master, true);
    assert.equal(on.startup, true);
    for (const name of SYSTEM_NAMES) {
        assert.equal(on.systems[name], true);
    }

    const chosen = stored({ systems: { ...allSystems(false), gap: true } });
    assert.deepEqual(startupToPersist(true, chosen).systems, chosen.systems, "a chosen subset is kept");

    const off = startupToPersist(false, stored({ master: true, startup: true, systems: allSystems(true) }));
    assert.equal(off.master, false);
    assert.equal(off.startup, false);
});

test("the scope line says what the change applied to, and never claims more", () => {
    const file = "/home/example/.pi/agent/specpi/jev/settings.json";
    const on = stored({ master: true, startup: true });

    assert.match(
        layerScopeLine({ sessionOnly: true, interactive: true, persisted: undefined, stored: on, settingsFile: file }),
        /This session only, as asked\. New sessions still start on\./u,
    );
    assert.match(
        layerScopeLine({
            sessionOnly: false,
            interactive: false,
            persisted: undefined,
            stored: on,
            settingsFile: file,
        }),
        /needs an interactive command/u,
    );
    assert.match(
        layerScopeLine({ sessionOnly: false, interactive: true, persisted: undefined, stored: on, settingsFile: file }),
        /could not be written/u,
    );
    assert.match(
        layerScopeLine({ sessionOnly: false, interactive: true, persisted: on, stored: on, settingsFile: file }),
        /Remembered/u,
    );

    // A file with only one half of the pair set describes a layer that never runs, and the line has
    // to say "off" rather than read `startup` alone.
    assert.match(
        layerScopeLine({
            sessionOnly: true,
            interactive: true,
            persisted: undefined,
            stored: stored({ master: false, startup: true }),
            settingsFile: file,
        }),
        /New sessions still start off\./u,
    );
});

test("the key line names its source and never carries a value", () => {
    const secret = "sk-or-v1-supersecret";
    const onWithStore = applyLayer(
        { on: true },
        { settings: stored(), guardEnabled: false },
        deps({ env: { OPENROUTER_API_KEY: secret }, sources: [{ name: "auth.json", present: true }] }),
    );
    const text = onWithStore.lines.join("\n");
    assert.match(text, /Pi's credential store/u);
    assert.ok(!text.includes(secret), "a key must never reach a notification");

    const none = applyLayer({ on: true }, { settings: stored(), guardEnabled: false }, deps({ sources: [] }));
    assert.match(none.lines.join("\n"), /Run \/login openrouter to store one/u);
});
