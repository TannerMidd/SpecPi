// Install-time notes for specpi-lancet-guard, the local command guard in the base set.
//
// SpecPi writes nothing into the guard's configuration. The package ships off, downloads its model
// only when someone runs `/lancet-guard setup`, and owns its own switch: `/lancet-guard on` for a
// session, `--global` to save it. An installer run therefore never arms or disarms it, and a
// saved preference survives every update.
//
// It replaced specpi-jev-guard, which SpecPi used to pin and write inert. An update retires that
// pin like any other SpecPi-added package entry. The one thing worth saying out loud is when that
// takes away a gate someone had switched on, so this reads the old package's saved switch -- only
// that field -- to decide whether to say it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Must match the pin in templates/settings.json. */
export const GUARD_PIN = "npm:specpi-lancet-guard@0.5.0";

export const RETIRED_GUARD_PIN = "npm:specpi-jev-guard@0.4.0";

/** Whether the retired Jev guard's saved global setting had it switched on. */
export function retiredGuardWasOn(home = os.homedir()) {
    try {
        const file = path.join(home, ".pi", "jev-guard.json");
        const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));

        return parsed?.enabled === true;
    } catch {
        return false;
    }
}

export const RETIRED_GUARD_NOTICE =
    "The Jev command guard was on and is no longer in SpecPi's default packages. Its replacement, the local LANCET guard, starts off: run /lancet-guard setup in Pi to download its model and turn it on.";
