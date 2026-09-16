(() => {
    window.SpecPiPackageSettings = {
        install({ send, getState }) {
            const webAccess = window.SpecPiWebAccessConfig;
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

            // Each target names one file and one validator. The host resolves
            // the path itself; the webview never sends or sees one it chose.
            function schema() {
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
                legend.textContent = isWeb() ? "Providers and behaviour" : "Settings";
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
                    const config = schema().parse(source.value);
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

                    source.value = `${JSON.stringify(config, null, 4)}\n`;
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

                    updateButtons();
                },
                handleMessage(message) {
                    if (
                        message.type === "packageSettings" &&
                        message.settings?.contextToken === getState().contextToken
                    ) {
                        snapshot = message.settings;
                        pending = false;
                        target.value = snapshot.target;
                        source.value = snapshot.text;
                        rebuildFields();
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
