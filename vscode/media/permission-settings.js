(() => {
    window.SpecPiPermissionSettings = {
        install({ send, getState }) {
            const schema = window.SpecPiPermissionConfig;
            const byId = (id) => document.getElementById(id);
            const dialog = byId("permission-settings");
            const form = byId("permission-fields");
            const source = byId("permission-source");
            const controls = new Map();
            let snapshot;
            let pending = false;
            let valid = false;
            let formValid = false;
            let saved = false;
            let beforeProfile;
            byId("permission-profile-preview").textContent = schema.destructiveGuardText("global");

            function report(message, error = false) {
                const status = byId("permission-feedback");
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
                    Boolean(state.permissions)
                );
            }

            function updateButtons() {
                const enabled = available() && !pending;
                byId("permission-save").disabled = !enabled || !valid;
                byId("permission-reload").disabled = !enabled;
                byId("permission-effective").disabled = !enabled;
                byId("permission-restart").disabled = !enabled || !saved;
                byId("permission-close").disabled = pending;
                byId("permission-profile-apply").disabled =
                    !enabled || snapshot?.scope !== "global" || beforeProfile !== undefined;
                byId("permission-profile-scope-note").hidden = snapshot?.scope === "global";
                byId("permission-profile-undo").hidden = beforeProfile === undefined;
                byId("permission-profile-undo").disabled = !enabled;
                form.disabled = pending || !formValid;
                source.disabled = pending;
            }

            function check() {
                try {
                    schema.validate(source.value);
                    valid = true;
                    report("Unsaved draft. No settings change until you save and confirm.");
                } catch (error) {
                    valid = false;
                    report(error.message, true);
                }

                saved = false;
                updateButtons();
            }

            function populate() {
                try {
                    const config = schema.parse(source.value);
                    for (const [key, , type] of schema.fields) {
                        const control = controls.get(key);
                        const value = config[key];
                        control.value =
                            value === undefined
                                ? ""
                                : type === "object" || type === "array"
                                  ? JSON.stringify(value, null, 2)
                                  : String(value);
                    }

                    formValid = true;
                } catch {
                    // Keep malformed files editable in the full JSON editor.
                    formValid = false;
                    byId("permission-advanced").open = true;
                }

                check();
            }

            function fromForm() {
                try {
                    const config = schema.parse(source.value);
                    for (const [key, , type] of schema.fields) {
                        const value = controls.get(key).value;
                        if (!value.trim()) {
                            delete config[key];
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

            for (const [key, title, type, help] of schema.fields) {
                const wrapper = document.createElement("div");
                wrapper.className = "permission-field";
                const label = document.createElement("label");
                label.htmlFor = `permission-${key}`;
                label.textContent = title;
                const control = document.createElement(
                    type === "boolean" ? "select" : type === "number" ? "input" : "textarea",
                );
                control.id = label.htmlFor;
                if (type === "boolean") {
                    for (const [value, text] of [
                        ["", "Inherit / default"],
                        ["false", "Off"],
                        ["true", "On"],
                    ]) {
                        const option = document.createElement("option");
                        option.value = value;
                        option.textContent = text;
                        control.append(option);
                    }
                } else if (type === "number") {
                    control.type = "number";
                    control.min = "1";
                    control.step = "1";
                    control.placeholder = "Inherit / default";
                } else {
                    control.rows = key === "permission" ? 12 : 3;
                    control.maxLength = 65536;
                    control.spellcheck = false;
                    control.placeholder = type === "array" ? "[]" : "{}";
                }

                const hint = document.createElement("p");
                hint.id = `${control.id}-help`;
                hint.textContent = help;
                control.setAttribute("aria-describedby", hint.id);
                control.addEventListener(type === "boolean" ? "change" : "input", fromForm);
                wrapper.append(label, control, hint);
                form.append(wrapper);
                controls.set(key, control);
            }

            source.addEventListener("input", populate);
            byId("permission-close").addEventListener("click", () => dialog.close());
            dialog.addEventListener("cancel", (event) => {
                if (pending) {
                    event.preventDefault();
                }
            });
            dialog.addEventListener("close", () => byId("permissions-button").focus());
            byId("permission-reload").addEventListener("click", () => {
                if (available() && !pending) {
                    send({ type: "showPermissions", scope: byId("permission-scope").value });
                }
            });
            byId("permission-profile-apply").addEventListener("click", () => {
                if (
                    !snapshot ||
                    snapshot.scope !== "global" ||
                    !available() ||
                    pending ||
                    beforeProfile !== undefined
                ) {
                    return;
                }

                beforeProfile = source.value;
                source.value = schema.destructiveGuardText("global");
                populate();
                byId("permission-advanced").open = true;
                report(
                    "Global draft replaced with Destructive guard. Review or edit it, then save and confirm. Nothing has been written.",
                );
            });
            byId("permission-profile-undo").addEventListener("click", () => {
                if (beforeProfile === undefined || !available() || pending) {
                    return;
                }

                source.value = beforeProfile;
                beforeProfile = undefined;
                populate();
                if (valid) {
                    report("Previous draft restored. Nothing was saved.");
                }
            });
            byId("permission-save").addEventListener("click", () => {
                if (!snapshot || !available() || pending || !valid) {
                    return;
                }

                pending = true;
                report("Waiting for confirmation in VS Code…");
                updateButtons();
                send({
                    type: "savePermissions",
                    id: snapshot.id,
                    contextToken: snapshot.contextToken,
                    text: source.value,
                });
            });
            byId("permission-effective").addEventListener("click", () => {
                dialog.close();
                send({ type: "showEffectivePermissions" });
            });
            byId("permission-restart").addEventListener("click", () => {
                if (snapshot && available() && !pending && saved) {
                    send({ type: "restartPermissions", id: snapshot.id, contextToken: snapshot.contextToken });
                }
            });

            return {
                render() {
                    if (snapshot && (snapshot.contextToken !== getState().contextToken || !getState().permissions)) {
                        snapshot = undefined;
                        beforeProfile = undefined;
                        source.value = "";
                        dialog.close();
                    }

                    updateButtons();
                },
                handleMessage(message) {
                    if (
                        message.type === "permissionSettings" &&
                        message.settings?.contextToken === getState().contextToken
                    ) {
                        snapshot = message.settings;
                        beforeProfile = undefined;
                        pending = false;
                        source.value = snapshot.text;
                        byId("permission-scope").value = snapshot.scope;
                        byId("permission-path").textContent =
                            `${snapshot.scope === "global" ? "Global" : "Project"}: ${snapshot.path}${snapshot.exists ? "" : " (not created yet)"}`;
                        populate();
                        if (valid) {
                            report(
                                snapshot.exists
                                    ? "Loaded from disk, not the merged runtime policy."
                                    : "No config file. Omitted settings inherit; the upstream fallback is ask.",
                            );
                        }

                        if (!dialog.open) {
                            dialog.showModal();
                        }

                        byId("permission-scope").focus();
                    } else if (message.type === "permissionSettingsError") {
                        report(message.error, true);
                    } else if (message.type === "permissionSaveResult" && snapshot?.id === message.id) {
                        pending = false;
                        if (message.settings) {
                            beforeProfile = undefined;
                            snapshot = message.settings;
                            byId("permission-path").textContent =
                                `${snapshot.scope === "global" ? "Global" : "Project"}: ${snapshot.path}`;
                            saved = true;
                            report(
                                `Saved to disk. Restart Pi to reload this chat and clear session approvals. Other chats may reload policy independently.${snapshot.backup ? ` Backup: ${snapshot.backup}` : ""}`,
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
