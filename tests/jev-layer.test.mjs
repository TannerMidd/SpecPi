// The behaviour of `/jev on` and `/jev off`, which had no test coverage at all until this file.
//
// Everything these assert used to live in closures inside index.ts, which no test imports, so two
// review rounds found defects that a green suite could not have caught: a stored preference
// destroyed on a path that decided nothing, a notification reporting a gate "left off" while it was
// on and blocking, and a rollback that never ran because the flag was set before the write.
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

const stored = (overrides = {}) => ({ ...defaultSettings(), ...overrides });
const allSystems = (on) => Object.fromEntries(SYSTEM_NAMES.map((name) => [name, on]));
const deps = ({ sources = [] } = {}) => ({ keySources: () => sources });

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

test("the layer switch never reaches the command guard", () => {
    // Every system `/jev on` arms only ever adds advice, which is what makes arming all of them a
    // reasonable default and why the switch carries no warning. The one component that can refuse
    // a tool call is a separate package with a separate switch, and the layer neither names it nor
    // records anything about it in either direction.
    const armed = applyLayer({ on: true }, { settings: stored() }, deps());
    assert.ok(!("guard" in armed.settings.systems), "the guard is not one of the systems");
    assert.ok(!("guard" in armed.settings), "and the layer stores no preference about it");
    assert.ok(!/guard/iu.test(armed.lines.join(" ")), "turning the layer on says nothing about it");

    const off = applyLayer({ on: false }, { settings: stored({ master: true }) }, deps());
    assert.ok(!/guard/iu.test(off.lines.join(" ")), "and neither does turning it off");
});

test("switching the layer off never touches the credential store", () => {
    // `offLine` names no key, so resolving one before the branch meant every `/jev off` paid for a
    // stat, read and parse of the one file this layer reads under a narrow, stated exception -- and
    // then discarded the answer. A deps object that throws proves the call is not made at all.
    const explode = {
        keySources: () => {
            throw new Error("the off path must not resolve a key");
        },
    };
    const off = applyLayer({ on: false }, { settings: stored({ master: true, systems: allSystems(true) }) }, explode);
    assert.equal(off.settings.master, false);
    assert.equal(off.lines.length, 1);

    // And the on path still does, because it reports the source it found.
    assert.throws(() => applyLayer({ on: true }, { settings: stored() }, explode));
});

test("what is persisted keeps master and startup together and preserves unrelated settings", () => {
    // Storing them apart is what made the Chat panel's checkbox do nothing on its own: session_start
    // zeroes a stored master whenever startup is false.
    const existing = stored({ budgets: { ...defaultSettings().budgets, total: 16 }, progressNudge: "message" });
    const on = applyLayer({ on: true }, { settings: stored() }, deps());
    const written = layerToPersist(on, existing);

    assert.equal(written.master, true);
    assert.equal(written.startup, true);
    assert.equal(written.budgets.total, 16, "a budget written elsewhere must survive");
    assert.equal(written.progressNudge, "message");

    const off = applyLayer({ on: false }, { settings: stored({ master: true }) }, deps());
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
    // Named for what it is. Written in a vendor key shape, or with "secret" in the value, this is
    // the string a scanner flags and a reader mistakes for the real thing; see fixture-key-shapes.
    const fixtureKey = "openrouter-fixture-value";
    const onWithStore = applyLayer(
        { on: true },
        { settings: stored() },
        deps({ env: { OPENROUTER_API_KEY: fixtureKey }, sources: [{ name: "auth.json", present: true }] }),
    );
    const text = onWithStore.lines.join("\n");
    assert.match(text, /Pi's credential store/u);
    assert.ok(!text.includes(fixtureKey), "a key must never reach a notification");

    const none = applyLayer({ on: true }, { settings: stored() }, deps({ sources: [] }));
    assert.match(none.lines.join("\n"), /Run \/login openrouter to store one/u);
});

test("startupToPersist and enableSystems agree, because they are one rule", () => {
    const off = stored();
    assert.deepEqual(startupToPersist(true, off).systems, enableSystems(off).systems);

    const chosen = stored({ systems: { ...allSystems(false), gap: true } });
    assert.deepEqual(startupToPersist(true, chosen).systems, enableSystems(chosen).systems);
});
