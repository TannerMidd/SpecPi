(() => {
    window.SpecPiPackageSettings = {
        install({ send, getState }) {
            const webAccess = window.SpecPiWebAccessConfig;
            const jev = window.SpecPiJevConfig;
            const byId = (id) => document.getElementById(id);
            const dialog = byId("package-settings");
            const form = byId("package-fields");
            const source = byId("package-source");
            const target = byId("package-target");
            const credentials = byId("package-credentials");
            const controls = new Map();
            let snapshot;
            let pending = false;
            let valid = false;
            let formValid = false;
            let saved = false;

            const isWeb = () => snapshot?.target === "webAccess";
            const isJev = () => snapshot?.target === "jevLayer";

            // Each target names one file and one validator. The host resolves
            // the path itself; the webview never sends or sees one it chose.
            function schema() {
                if (isJev()) {
                    return { fields: jev.fields, validate: (text) => jev.validate(text), parse: jev.parse };
                }

                return {
                    fields: webAccess.fields,
                    validate: (text) => webAccess.validate(text),
                    parse: webAccess.parse,
                };
            }

            function report(message, error = false) {
                const status = byId("package-feedback");
                status.textContent = message;
                status.dataset.error = String(error);
            }

            function available() {
                const state = getState();

                return (
                    state.status === "ready" &&
                    !state.sending &&
                    !state.uiRequest &&
                    !state.queueCount &&
                    Boolean(state.packageSettings)
                );
            }

            function updateButtons() {
                const enabled = available() && !pending;
                byId("package-save").disabled = !enabled || !valid || !snapshot;
                byId("package-reload").disabled = !enabled;
                byId("package-restart").disabled = !enabled || !saved;
                byId("package-close").disabled = pending;
                target.disabled = pending;
                form.disabled = pending || !formValid;
                source.disabled = pending;
            }

            function check() {
                try {
                    const { unknown } = schema().validate(source.value);
                    valid = true;
                    const note = unknown.length
                        ? ` Unrecognised keys are kept as written: ${unknown.slice(0, 6).join(", ")}.`
                        : "";
                    report(`Unsaved draft. Nothing is written until you save and confirm.${note}`);
                } catch (error) {
                    valid = false;
                    report(error.message, true);
                }

                saved = false;
                updateButtons();
            }

            function rebuildFields() {
                controls.clear();
                form.textContent = "";
                const legend = document.createElement("legend");
                legend.textContent = isWeb() ? "Providers and behaviour" : isJev() ? "Jev layer" : "Settings";
                form.append(legend);
                for (const [key, title, type, help] of schema().fields) {
                    const wrapper = document.createElement("div");
                    wrapper.className = "package-field";
                    const label = document.createElement("label");
                    label.htmlFor = `package-field-${key}`;
                    label.textContent = title;
                    const enumerated = Array.isArray(type);
                    const control = document.createElement(
                        enumerated || type === "boolean"
                            ? "select"
                            : type === "number" || type === "string"
                              ? "input"
                              : "textarea",
                    );
                    control.id = label.htmlFor;
                    if (enumerated || type === "boolean") {
                        const options = enumerated
                            ? [["", "Inherit / default"], ...type.map((value) => [value, value])]
                            : [
                                  ["", "Inherit / default"],
                                  ["false", "Off"],
                                  ["true", "On"],
                              ];
                        for (const [value, text] of options) {
                            const option = document.createElement("option");
                            option.value = value;
                            option.textContent = text;
                            control.append(option);
                        }
                    } else if (type === "number") {
                        control.type = "number";
                        control.min = "0";
                        control.step = "1";
                        control.placeholder = "Inherit / default";
                    } else if (type === "string") {
                        control.type = "text";
                        control.maxLength = 4096;
                        control.spellcheck = false;
                        control.placeholder = "Inherit / default";
                    } else {
                        control.rows = 3;
                        control.maxLength = 65536;
                        control.spellcheck = false;
                        control.placeholder = type === "array" ? "[]" : "{}";
                    }

                    const hint = document.createElement("p");
                    hint.id = `${control.id}-help`;
                    hint.textContent = help;
                    control.setAttribute("aria-describedby", hint.id);
                    control.addEventListener(enumerated || type === "boolean" ? "change" : "input", fromForm);
                    wrapper.append(label, control, hint);
                    form.append(wrapper);
                    controls.set(key, control);
                }
            }

            function populate() {
                try {
                    const parsed = schema().parse(source.value);
                    // A file that is on with no system running is repaired as it is loaded, so the
                    // boxes tick where the person can see them. The repair used to be reachable
                    // only by toggling the layer, which a file already in that state cannot do.
                    const repaired = isJev() ? jev.couple(parsed, parsed) : { config: parsed, note: "" };
                    const config = repaired.config;
                    if (repaired.note) {
                        source.value = `${JSON.stringify(config, null, 4)}
`;
                    }

                    for (const [key, , type] of schema().fields) {
                        const control = controls.get(key);
                        const value = config[key];
                        control.value =
                            value === undefined
                                ? ""
                                : Array.isArray(type) || type === "boolean" || type === "number" || type === "string"
                                  ? String(value)
                                  : JSON.stringify(value, null, 2);
                    }

                    formValid = true;
                    if (repaired.note) {
                        check();
                        // Carry the error flag rather than defaulting it to false: appending a note
                        // to a draft that failed validation was re-styling the error as an ordinary
                        // message, leaving Save disabled with no visible reason.
                        const status = byId("package-feedback");
                        report(`${status.textContent}${repaired.note}`, status.dataset.error === "true");

                        return;
                    }
                } catch {
                    // Keep a malformed file editable in the full JSON editor.
                    formValid = false;
                    byId("package-advanced").open = true;
                }

                check();
            }

            function fromForm() {
                try {
                    const config = schema().parse(source.value);
                    const before = { ...config };
                    for (const [key, , type] of schema().fields) {
                        const value = controls.get(key).value;
                        if (!value.trim()) {
                            delete config[key];
                        } else if (Array.isArray(type) || type === "string") {
                            config[key] = value;
                        } else if (type === "boolean") {
                            config[key] = value === "true";
                        } else if (type === "number") {
                            config[key] = Number(value);
                        } else {
                            try {
                                config[key] = JSON.parse(value);
                            } catch {
                                throw new Error(`Invalid JSON in ${key}.`);
                            }
                        }
                    }

                    // Enabling the Jev layer fills in its systems when none are on, in the form,
                    // so the boxes visibly tick before anything is saved. See `couple` in
                    // media/jev-config.js for why that happens here rather than on the way to disk.
                    const coupled = isJev() ? jev.couple(config, before) : { config, note: "" };
                    source.value = `${JSON.stringify(coupled.config, null, 4)}\n`;
                    if (coupled.note) {
                        populate();
                        const status = byId("package-feedback");
                        report(`${status.textContent}${coupled.note}`, status.dataset.error === "true");

                        return;
                    }

                    check();
                } catch (error) {
                    valid = false;
                    saved = false;
                    report(error.message, true);
                    updateButtons();
                }
            }

            // Credentials are described, never shown. The host sends only a
            // kind per field, so nothing here can render a stored secret.
            const KINDS = {
                unset: "Not configured",
                literal: "Stored in this file",
                environment: "Read from an environment variable",
                command: "Resolved by a local command",
            };

            // Only the packages this session reports may be chosen; the host refuses any other
            // target anyway, so an option left selectable would be a control that always errors.
            function renderTargets() {
                const allowed = new Set(getState().packageSettings?.targets || []);
                for (const option of target.options) {
                    option.hidden = !allowed.has(option.value);
                    option.disabled = option.hidden;
                }
            }

            function plural(count, word) {
                return `${count} ${word}${count === 1 ? "" : "s"}`;
            }

            // Counts, not effects: this is a budget display, and the one thing a person wants from
            // it is whether a system has room left. `applied` rides along because "asked 6 times,
            // changed nothing" is the finding a bare call count hides.
            function renderUsage() {
                const section = byId("package-usage");
                section.hidden = !isJev();
                const list = byId("package-usage-list");
                list.textContent = "";
                if (!isJev()) {
                    return;
                }

                const usage = snapshot.usage;
                const summary = byId("package-usage-summary");
                if (!usage) {
                    summary.textContent =
                        "No calls recorded. The advisor writes this file once the layer is on, so an untouched layer has none.";

                    return;
                }

                // "Running" and "ended" are different facts and the panel says which, because a
                // count with no such label reads as live however old it is.
                const when = usage.updatedAt ? new Date(usage.updatedAt).toLocaleString() : "an unknown time";
                summary.textContent = usage.active
                    ? `A Jev session that started ${usage.startedAt ? new Date(usage.startedAt).toLocaleString() : "recently"} has made ${plural(usage.calls, "call")} of ${usage.budgets.total}, as of ${when}.`
                    : `The last Jev session ended having made ${plural(usage.calls, "call")} of ${usage.budgets.total}, as of ${when}.`;
                for (const row of jev.usageRows(usage)) {
                    const item = document.createElement("li");
                    const name = document.createElement("code");
                    name.textContent = row.label;
                    const detail = document.createElement("span");
                    const spent = row.budget > 0 && row.calls >= row.budget ? " · budget spent" : "";
                    const changed = row.applied === null ? "" : `, ${row.applied} changed something`;
                    detail.textContent = `${row.calls} of ${row.budget}${changed}${spent}`;
                    item.append(name, detail);
                    list.append(item);
                }
            }

            /**
             * Where a key would come from, and which source is in force. Presence only: the host
             * sends a boolean per source and never a value, so there is nothing here that could
             * render a secret even by mistake.
             *
             * Every source is listed, including the empty ones, because "which of these do I have
             * to fix" is the question someone with no key is actually asking. A bare "not
             * configured" is what sent people looking for a key field that does not exist.
             */
            function renderKey() {
                const section = byId("package-key");
                section.hidden = !isJev();
                const list = byId("package-key-list");
                list.textContent = "";
                if (!isJev()) {
                    return;
                }

                const status = snapshot.key || { sources: [] };
                const summary = byId("package-key-summary");
                const active = status.sources.find((item) => item.name === status.active);
                summary.textContent = active
                    ? `In use: ${active.label}. The seven systems above can reach Jev.`
                    : "No key anywhere. Every system will report no advice, and the harness runs exactly as it did before the layer existed. Run /login openrouter in Pi to store one.";
                for (const item of status.sources) {
                    const row = document.createElement("li");
                    const name = document.createElement("code");
                    name.textContent = item.label;
                    const detail = document.createElement("span");
                    const state = !item.present
                        ? "Empty"
                        : item.name === status.active
                          ? "In use"
                          : "Present, but a source above it is used first";
                    // Said on the row rather than only in the prose below it, because this is the
                    // difference between a guard that works and a guard that blocks every command.
                    const guard = item.guard ? " · the command guard reads this one" : "";
                    detail.textContent = `${state}${guard} — ${item.detail}`;
                    row.append(name, detail);
                    list.append(row);
                }
            }

            function renderCredentials() {
                credentials.hidden = !isWeb();
                const list = byId("package-credential-list");
                list.textContent = "";
                if (!isWeb()) {
                    return;
                }

                const entries = Object.entries(snapshot.credentials || {});
                const configured = entries.filter(([, kind]) => kind !== "unset");
                byId("package-credential-summary").textContent = configured.length
                    ? `${configured.length} of ${entries.length} provider credentials are configured. Values are never shown here.`
                    : "No provider credentials are configured.";
                for (const [key, kind] of configured) {
                    const row = document.createElement("li");
                    const name = document.createElement("code");
                    name.textContent = key;
                    const detail = document.createElement("span");
                    detail.textContent = KINDS[kind] || kind;
                    row.append(name, detail);
                    list.append(row);
                }
            }

            source.addEventListener("input", populate);
            target.addEventListener("change", () => {
                if (available() && !pending) {
                    send({ type: "showPackageSettings", target: target.value });
                }
            });
            byId("package-close").addEventListener("click", () => dialog.close());
            dialog.addEventListener("cancel", (event) => {
                if (pending) {
                    event.preventDefault();
                }
            });
            dialog.addEventListener("close", () => byId("package-settings-button").focus());
            byId("package-reload").addEventListener("click", () => {
                if (available() && !pending) {
                    send({ type: "showPackageSettings", target: target.value });
                }
            });
            byId("package-save").addEventListener("click", () => {
                if (!snapshot || !available() || pending || !valid) {
                    return;
                }

                pending = true;
                report("Waiting for confirmation in VS Code…");
                updateButtons();
                send({
                    type: "savePackageSettings",
                    id: snapshot.id,
                    contextToken: snapshot.contextToken,
                    text: source.value,
                });
            });
            byId("package-restart").addEventListener("click", () => {
                if (snapshot && available() && !pending && saved) {
                    send({ type: "restartPackageSettings", id: snapshot.id, contextToken: snapshot.contextToken });
                }
            });

            function describe() {
                const where = snapshot.exists ? "" : " (not created yet)";
                byId("package-path").textContent = `${snapshot.path}${where}`;
                byId("package-scope-note").hidden = true;
            }

            return {
                render() {
                    if (
                        snapshot &&
                        (snapshot.contextToken !== getState().contextToken || !getState().packageSettings)
                    ) {
                        snapshot = undefined;
                        source.value = "";
                        dialog.close();
                    }

                    renderTargets();
                    updateButtons();
                },
                handleMessage(message) {
                    if (
                        message.type === "packageSettings" &&
                        message.settings?.contextToken === getState().contextToken
                    ) {
                        snapshot = message.settings;
                        pending = false;
                        renderTargets();
                        target.value = snapshot.target;
                        source.value = snapshot.text;
                        rebuildFields();
                        renderUsage();
                        renderKey();
                        renderCredentials();
                        describe();
                        populate();
                        if (valid) {
                            report(
                                snapshot.exists
                                    ? "Loaded from disk, not the package's merged runtime configuration."
                                    : "No file yet. Omitted keys use the package defaults.",
                            );
                        }

                        if (!dialog.open) {
                            dialog.showModal();
                        }

                        target.focus();
                    } else if (message.type === "packageSettingsError") {
                        report(message.error, true);
                    } else if (message.type === "packageSaveResult" && snapshot?.id === message.id) {
                        pending = false;
                        if (message.settings) {
                            snapshot = message.settings;
                            source.value = snapshot.text;
                            renderUsage();
                            renderKey();
                            renderCredentials();
                            describe();
                            saved = true;
                            report(
                                `Saved to disk. Restart Pi so the package reloads it.${snapshot.backup ? ` Backup: ${snapshot.backup}` : ""}`,
                            );
                        } else {
                            report(message.error || "Save cancelled. Your draft is unchanged.", Boolean(message.error));
                        }

                        updateButtons();
                    }
                },
            };
        },
    };
})();
