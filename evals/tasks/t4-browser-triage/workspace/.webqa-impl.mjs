#!/usr/bin/env node
// webqa — a hermetic browser, reached through the `webqa` command.
//
// Real DOM, real event dispatch, real page scripts, with every source of
// nondeterminism removed: the clock is fixed, timers drain in order, and the
// network answers from `app/api.json`. The same command sequence produces
// byte-identical output on any machine, which is what makes a browser usable
// as a fixture.
//
// State survives between invocations in `.webqa/session.json`. Rather than
// serialising a DOM, the session keeps the action log since the last `goto`
// and replays it onto a freshly built page. Storage and server state are
// snapshotted at `goto` time and replayed forward from there, so a replayed
// increment increments once rather than once per command that follows it.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dispatch, makeEvent, parseHtml, query, runtimeHooks } from "./.webqa-dom.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "app");
const sessionDir = path.join(here, ".webqa");
const sessionFile = path.join(sessionDir, "session.json");
const CLOCK = Date.UTC(2026, 8, 18, 12, 0, 0);

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return fallback;
    }
}

function emptySession() {
    return {
        route: null,
        actions: [],
        storage: {},
        server: {},
        storageAtRoute: {},
        serverAtRoute: {},
        visited: [],
        steps: 0,
    };
}

function loadSession() {
    return readJson(sessionFile, emptySession());
}

function saveSession(session) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
}

function routes() {
    return readJson(path.join(appDir, "routes.json"), {});
}

// A route may arrive mangled. Git Bash on Windows rewrites a leading-slash
// argument into a Windows path, so `webqa goto /cart` reaches this process as
// `C:/Program Files/Git/cart`. Matching on the last segment accepts that, and
// accepts `webqa goto cart` too, rather than failing on a shell's behaviour
// the caller never chose.
function resolveRoute(input) {
    const table = routes();
    if (Object.hasOwn(table, input)) {
        return input;
    }

    const segments = String(input ?? "").split("\\").join("/").split("/").filter(Boolean);
    const candidate = `/${segments[segments.length - 1] ?? ""}`;

    return Object.hasOwn(table, candidate) ? candidate : null;
}

/* ------------------------------------------------------------- page build */

function buildRuntime(route, session) {
    const table = routes();
    const page = table[route];
    if (page === undefined) {
        throw new Error(`no such route: ${route}`);
    }

    const html = fs.readFileSync(path.join(appDir, page), "utf8");
    const document = parseHtml(html);
    document.ownerDocument = document;
    const stamp = (node) => {
        node.ownerDocument = document;
        for (const child of node.childNodes) {
            stamp(child);
        }
    };

    stamp(document);
    const runtime = {
        route,
        document,
        console: [],
        network: [],
        alerts: [],
        timers: [],
        timerSeq: 0,
        now: CLOCK,
        storage: { ...session.storage },
        server: JSON.parse(JSON.stringify(session.server ?? {})),
        navigated: null,
    };
    document.activeElement = null;
    runtimeHooks.onUncaught = (error) => {
        const name = error?.name ?? "Error";
        runtime.console.push({ level: "error", text: `Uncaught ${name}: ${String(error?.message ?? error)}` });
    };

    const api = readJson(path.join(appDir, "api.json"), {});
    const storage = {
        getItem: (key) => (Object.hasOwn(runtime.storage, key) ? runtime.storage[key] : null),
        setItem: (key, value) => {
            runtime.storage[String(key)] = String(value);
        },
        removeItem: (key) => {
            delete runtime.storage[String(key)];
        },
        clear: () => {
            runtime.storage = {};
        },
        key: (index) => Object.keys(runtime.storage)[index] ?? null,
    };

    const fetchImpl = (url, options = {}) => {
        const method = String(options.method ?? "GET").toUpperCase();
        const key = `${method} ${url}`;
        const entry = api[key] ?? api[`${method} *`] ?? { status: 404, body: { error: "not found" } };
        const record = { method, url, status: entry.status, body: entry.body };
        runtime.network.push(record);
        const response = {
            ok: entry.status >= 200 && entry.status < 300,
            status: entry.status,
            statusText: entry.statusText ?? "",
            json: () => Promise.resolve(JSON.parse(JSON.stringify(entry.body ?? null))),
            text: () => Promise.resolve(JSON.stringify(entry.body ?? null)),
        };

        return Promise.resolve(response);
    };

    const sandbox = {
        document,
        console: {
            log: (...parts) => runtime.console.push({ level: "log", text: parts.map(String).join(" ") }),
            info: (...parts) => runtime.console.push({ level: "info", text: parts.map(String).join(" ") }),
            warn: (...parts) => runtime.console.push({ level: "warn", text: parts.map(String).join(" ") }),
            error: (...parts) => runtime.console.push({ level: "error", text: parts.map(String).join(" ") }),
        },
        localStorage: storage,
        sessionStorage: storage,
        fetch: fetchImpl,
        alert: (text) => runtime.alerts.push(String(text)),
        setTimeout: (fn, ms = 0) => {
            runtime.timers.push({ fn, at: runtime.now + Number(ms), seq: runtime.timerSeq++ });

            return runtime.timerSeq;
        },
        clearTimeout: (id) => {
            runtime.timers = runtime.timers.filter((timer) => timer.seq !== id - 1);
        },
        location: {
            pathname: route,
            assign: (next) => {
                runtime.navigated = String(next);
            },
        },
        Event: function Event(type, init = {}) {
            return makeEvent(type, init.detail ?? {});
        },
        server: runtime.server,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    for (const script of query(document, "script")) {
        const source = script.getAttribute("src");
        const code = source === null ? script.textContent : fs.readFileSync(path.join(appDir, source), "utf8");
        try {
            vm.runInContext(code, sandbox, { filename: source ?? `${route}#inline`, timeout: 5000 });
        } catch (error) {
            runtime.console.push({
                level: "error",
                text: `Uncaught ${error?.name ?? "Error"}: ${String(error?.message ?? error)}`,
            });
        }
    }

    dispatch(document, makeEvent("DOMContentLoaded"));

    return runtime;
}

// Timers and promise chains both have to finish before a command prints, or
// the harness would see a half-rendered page and the result would depend on
// how fast the machine is. setImmediate runs after the microtask queue is
// empty, so each pass here is a full turn of the loop.
async function settle(runtime) {
    for (let pass = 0; pass < 500; pass++) {
        await new Promise((resolve) => setImmediate(resolve));
        if (runtime.timers.length === 0) {
            break;
        }

        runtime.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const timer = runtime.timers.shift();
        runtime.now = Math.max(runtime.now, timer.at);
        try {
            timer.fn();
        } catch (error) {
            runtime.console.push({
                level: "error",
                text: `Uncaught ${error?.name ?? "Error"}: ${String(error?.message ?? error)}`,
            });
        }
    }

    await new Promise((resolve) => setImmediate(resolve));
}

function resolveOne(runtime, selector) {
    const found = query(runtime.document, selector);
    if (found.length === 0) {
        throw new Error(`no element matches ${selector}`);
    }

    return found[0];
}

async function applyAction(runtime, action) {
    const [selector, ...rest] = action.args;
    if (action.cmd === "click") {
        const element = resolveOne(runtime, selector);
        if (element.disabled) {
            return `ignored: ${selector} is disabled`;
        }

        element.focus();
        dispatch(element, makeEvent("click"));
        await settle(runtime);

        return `clicked ${selector}`;
    }

    if (action.cmd === "type") {
        const element = resolveOne(runtime, selector);
        element.focus();
        element.value = rest.join(" ");
        dispatch(element, makeEvent("input"));
        dispatch(element, makeEvent("change"));
        await settle(runtime);

        return `typed into ${selector}`;
    }

    if (action.cmd === "check" || action.cmd === "uncheck") {
        const element = resolveOne(runtime, selector);
        element.checked = action.cmd === "check";
        dispatch(element, makeEvent("change"));
        await settle(runtime);

        return `${action.cmd}ed ${selector}`;
    }

    if (action.cmd === "select") {
        const element = resolveOne(runtime, selector);
        element.value = rest.join(" ");
        dispatch(element, makeEvent("change"));
        await settle(runtime);

        return `selected ${rest.join(" ")} in ${selector}`;
    }

    if (action.cmd === "submit") {
        const element = resolveOne(runtime, selector);
        dispatch(element, makeEvent("submit"));
        await settle(runtime);

        return `submitted ${selector}`;
    }

    if (action.cmd === "key") {
        const element = resolveOne(runtime, selector);
        const event = makeEvent("keydown");
        event.key = rest[0] ?? "Enter";
        dispatch(element, event);
        await settle(runtime);

        return `sent ${event.key} to ${selector}`;
    }

    throw new Error(`unknown action: ${action.cmd}`);
}

async function replay(session) {
    if (session.route === null) {
        throw new Error("no page is open — run `webqa goto <route>` first");
    }

    const runtime = buildRuntime(session.route, {
        storage: session.storageAtRoute,
        server: session.serverAtRoute,
    });
    await settle(runtime);
    for (const action of session.actions) {
        await applyAction(runtime, action);
    }

    return runtime;
}

/* ------------------------------------------------------------- rendering */

const IMPLICIT_ROLES = {
    a: "link",
    button: "button",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    form: "form",
    img: "img",
    li: "listitem",
    nav: "navigation",
    ol: "list",
    section: "region",
    select: "combobox",
    table: "table",
    textarea: "textbox",
    ul: "list",
};

function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit !== null) {
        return explicit;
    }

    if (element.tagName === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox") {
            return "checkbox";
        }

        if (type === "radio") {
            return "radio";
        }

        if (type === "submit" || type === "button") {
            return "button";
        }

        return "textbox";
    }

    return IMPLICIT_ROLES[element.tagName] ?? "generic";
}

// Accessible name, computed the way the spec orders it and stopping short of
// the placeholder fallback. The placeholder is reported separately so a
// control named only by its placeholder is visible as such rather than
// silently counted as named.
function accessibleName(document, element) {
    const label = element.getAttribute("aria-label");
    if (label !== null && label.trim().length > 0) {
        return label.trim();
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
        const parts = labelledBy
            .split(/\s+/u)
            .map((id) => query(document, `#${id}`)[0]?.textContent.trim() ?? "")
            .filter(Boolean);
        if (parts.length > 0) {
            return parts.join(" ");
        }
    }

    if (element.id.length > 0) {
        const explicit = query(document, `label[for=${element.id}]`)[0];
        if (explicit) {
            return explicit.textContent.trim();
        }
    }

    const wrapping = element.closest("label");
    if (wrapping) {
        return wrapping.textContent.trim();
    }

    if (element.tagName === "img") {
        return (element.getAttribute("alt") ?? "").trim();
    }

    if (["button", "a", "h1", "h2", "h3", "summary"].includes(element.tagName)) {
        return element.textContent.trim().replace(/\s+/gu, " ");
    }

    const title = element.getAttribute("title");

    return title === null ? "" : title.trim();
}

function describe(element) {
    const parts = [element.tagName];
    if (element.id.length > 0) {
        parts.push(`#${element.id}`);
    }

    if (element.className.length > 0) {
        parts.push(`.${element.className.split(/\s+/u).filter(Boolean).join(".")}`);
    }

    return parts.join("");
}

const SHOWN_ATTRIBUTES = [
    "role",
    "type",
    "href",
    "disabled",
    "hidden",
    "aria-label",
    "aria-labelledby",
    "aria-expanded",
    "aria-hidden",
    "aria-controls",
    "aria-live",
    "aria-invalid",
    "tabindex",
    "for",
    "data-state",
    "data-total",
    "data-count",
];

function snapshotLines(element, depth, lines) {
    if (element.nodeType === 3) {
        const text = element.data.trim().replace(/\s+/gu, " ");
        if (text.length > 0) {
            lines.push(`${"  ".repeat(depth)}"${text.length > 160 ? `${text.slice(0, 160)}…` : text}"`);
        }

        return;
    }

    if (element.tagName === "script" || element.tagName === "style") {
        return;
    }

    const attributes = SHOWN_ATTRIBUTES.filter((name) => element.hasAttribute(name)).map(
        (name) => `${name}=${JSON.stringify(element.getAttribute(name))}`,
    );
    if (element.valueOverride !== null || element.hasAttribute("value")) {
        attributes.push(`value=${JSON.stringify(element.value)}`);
    }

    if (element.tagName === "input" && (element.getAttribute("type") ?? "") === "checkbox") {
        attributes.push(`checked=${element.checked}`);
    }

    const head = `${"  ".repeat(depth)}<${describe(element)}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`;
    lines.push(head);
    for (const child of element.childNodes) {
        snapshotLines(child, depth + 1, lines);
    }
}

function a11yRows(runtime) {
    const document = runtime.document;
    const interactive = query(document, "a, button, input, select, textarea, [role], [tabindex], img, label");
    const rows = [];
    for (const element of interactive) {
        rows.push({
            selector: describe(element),
            role: roleOf(element),
            name: accessibleName(document, element),
            placeholder: element.getAttribute("placeholder") ?? "",
            tabindex: element.getAttribute("tabindex") ?? "",
            disabled: element.disabled,
            ariaExpanded: element.getAttribute("aria-expanded") ?? "",
            ariaHidden: element.getAttribute("aria-hidden") ?? "",
            ariaControls: element.getAttribute("aria-controls") ?? "",
            text: element.textContent.trim().replace(/\s+/gu, " ").slice(0, 60),
        });
    }

    return rows;
}

/* ------------------------------------------------------------------- CLI */

function parseFlags(argv) {
    const flags = {};
    const rest = [];
    for (const argument of argv) {
        if (argument.startsWith("--")) {
            const equals = argument.indexOf("=");
            if (equals < 0) {
                flags[argument.slice(2)] = true;
            } else {
                flags[argument.slice(2, equals)] = argument.slice(equals + 1);
            }
        } else {
            rest.push(argument);
        }
    }

    return { flags, rest };
}

const HELP = `webqa — drive the application in app/ and read back what it does.

  webqa routes                     list every route and its page file
  webqa goto <route>               open a route in a fresh page ("/cart" or "cart")
  webqa snapshot [--selector=S]    element tree with roles, state and text
  webqa html [--selector=S]        rendered HTML for the page or one subtree
  webqa text [--selector=S]        visible text only
  webqa click <selector>           dispatch a click
  webqa type <selector> <text>     set a field value and fire input + change
  webqa check|uncheck <selector>   toggle a checkbox and fire change
  webqa select <selector> <value>  set a select value and fire change
  webqa submit <selector>          dispatch submit on a form
  webqa key <selector> <key>       dispatch keydown
  webqa console                    console output for the open page
  webqa network                    requests the open page has made
  webqa storage                    localStorage and server state
  webqa a11y [--selector=S]        computed roles, names and ARIA state
  webqa history                    routes visited this session
  webqa batch <file>               run one command per line from a file
  webqa reset                      drop the session and start over

Actions accumulate: the page keeps whatever you did to it until the next
goto or reset. Console and network output cover the open page only, the way
a devtools panel clears on navigation.`;

async function main(argv) {
    const [command, ...rest] = argv;
    const { flags, rest: args } = parseFlags(rest);
    if (command === undefined || command === "help" || command === "--help") {
        console.log(HELP);

        return 0;
    }

    if (command === "reset") {
        saveSession(emptySession());
        console.log("session reset");

        return 0;
    }

    if (command === "routes") {
        for (const [route, page] of Object.entries(routes())) {
            console.log(`${route}\t${page}`);
        }

        return 0;
    }

    const session = loadSession();
    if (command === "goto") {
        const route = resolveRoute(args[0]);
        if (route === null) {
            console.error(`no such route: ${args[0]}. Try \`webqa routes\`.`);

            return 2;
        }

        if (session.route !== null) {
            const previous = await replay(session);
            session.storage = previous.storage;
            session.server = previous.server;
        }

        session.route = route;
        session.actions = [];
        session.storageAtRoute = { ...session.storage };
        session.serverAtRoute = JSON.parse(JSON.stringify(session.server ?? {}));
        session.visited.push(route);
        session.steps += 1;
        const runtime = await replay(session);
        session.storage = runtime.storage;
        session.server = runtime.server;
        saveSession(session);
        const errors = runtime.console.filter((entry) => entry.level === "error").length;
        const nodes = query(runtime.document, "*").length;
        console.log(`200 ${route} — ${nodes} nodes, ${errors} console error(s), ${runtime.network.length} request(s)`);

        return 0;
    }

    if (command === "history") {
        console.log(session.visited.join(" -> ") || "(nothing visited)");

        return 0;
    }

    if (command === "batch") {
        const file = args[0];
        const lines = fs
            .readFileSync(path.resolve(file), "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));
        let code = 0;
        for (const line of lines) {
            console.log(`$ webqa ${line}`);
            const parts = line.match(/"[^"]*"|\S+/gu)?.map((part) => part.replace(/^"|"$/gu, "")) ?? [];
            code = (await main(parts)) || code;
        }

        return code;
    }

    const actions = ["click", "type", "check", "uncheck", "select", "submit", "key"];
    if (actions.includes(command)) {
        if (session.route === null) {
            console.error("no page is open — run `webqa goto <route>` first");

            return 2;
        }

        const action = { cmd: command, args };
        const runtime = await replay(session);
        let message = "";
        try {
            message = await applyAction(runtime, action);
        } catch (error) {
            console.error(String(error?.message ?? error));

            return 2;
        }

        session.actions.push(action);
        session.steps += 1;
        session.storage = runtime.storage;
        session.server = runtime.server;
        saveSession(session);
        const errors = runtime.console.filter((entry) => entry.level === "error");
        console.log(message);
        if (runtime.navigated !== null) {
            console.log(`page requested navigation to ${runtime.navigated}`);
        }

        for (const entry of errors.slice(-3)) {
            console.log(`  console.error: ${entry.text}`);
        }

        return 0;
    }

    const runtime = await replay(session).catch((error) => {
        console.error(String(error?.message ?? error));

        return null;
    });
    if (runtime === null) {
        return 2;
    }

    // `--selector` narrows the tree commands to one subtree and filters the
    // a11y table by substring, so it accepts `#w-03-toggle` there and
    // `w-03-toggle` here rather than making the caller remember which.
    let scope = runtime.document;
    if (flags.selector && ["snapshot", "html", "text"].includes(command)) {
        try {
            scope = resolveOne(runtime, String(flags.selector));
        } catch (error) {
            console.error(String(error?.message ?? error));

            return 2;
        }
    }

    if (command === "snapshot") {
        const lines = [];
        for (const child of scope.childNodes) {
            snapshotLines(child, 0, lines);
        }

        console.log(lines.join("\n"));

        return 0;
    }

    if (command === "html") {
        console.log(scope === runtime.document ? scope.innerHTML : scope.outerHTML);

        return 0;
    }

    if (command === "text") {
        console.log(scope.textContent.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim());

        return 0;
    }

    if (command === "console") {
        if (runtime.console.length === 0) {
            console.log("(no console output)");

            return 0;
        }

        for (const entry of runtime.console) {
            console.log(`${entry.level.toUpperCase()} ${entry.text}`);
        }

        return 0;
    }

    if (command === "network") {
        if (runtime.network.length === 0) {
            console.log("(no requests)");

            return 0;
        }

        for (const entry of runtime.network) {
            console.log(`${entry.status} ${entry.method} ${entry.url} ${JSON.stringify(entry.body)}`);
        }

        return 0;
    }

    if (command === "storage") {
        console.log(`localStorage ${JSON.stringify(runtime.storage, null, 2)}`);
        console.log(`server ${JSON.stringify(runtime.server, null, 2)}`);

        return 0;
    }

    if (command === "a11y") {
        const wanted = flags.selector === undefined ? null : String(flags.selector).replace(/^#/u, "");
        for (const row of a11yRows(runtime)) {
            if (wanted !== null && !row.selector.includes(wanted)) {
                continue;
            }

            console.log(
                [
                    row.selector,
                    `role=${row.role}`,
                    `name=${JSON.stringify(row.name)}`,
                    `placeholder=${JSON.stringify(row.placeholder)}`,
                    `tabindex=${JSON.stringify(row.tabindex)}`,
                    `disabled=${row.disabled}`,
                    `aria-expanded=${JSON.stringify(row.ariaExpanded)}`,
                    `aria-hidden=${JSON.stringify(row.ariaHidden)}`,
                    `aria-controls=${JSON.stringify(row.ariaControls)}`,
                ].join(" "),
            );
        }

        return 0;
    }

    if (command === "alerts") {
        console.log(runtime.alerts.join("\n") || "(no alerts)");

        return 0;
    }

    console.error(`unknown command: ${command}\n\n${HELP}`);

    return 2;
}

// A bad selector or an unknown route is a normal thing for a caller to try.
// It gets one line and a nonzero exit, not a stack trace: a page of Node
// internals in a transcript is context spent on nothing.
try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 2;
}
