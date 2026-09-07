(function () {
    "use strict";

    function mentionAtCursor(value, start, end = start) {
        if (
            typeof value !== "string" ||
            !Number.isInteger(start) ||
            start !== end ||
            start < 0 ||
            start > value.length
        ) {
            return null;
        }

        const match = /(?:^|\s)@([^\s@]{0,256})$/u.exec(value.slice(0, start));
        if (!match) {
            return null;
        }

        const tokenStart = start - match[1].length - 1;
        const token = /^@[^\s@]*/u.exec(value.slice(tokenStart))[0];

        return { start: tokenStart, end: tokenStart + token.length, token, query: match[1], draft: value };
    }

    function removeAcceptedMention(value, mention) {
        if (!mention || value !== mention.draft || value.slice(mention.start, mention.end) !== mention.token) {
            return null;
        }

        return { text: value.slice(0, mention.start) + value.slice(mention.end), cursor: mention.start };
    }

    function install({ send, getState, announce }) {
        const header = document.querySelector(".header-actions");
        const conversation = document.getElementById("conversation");
        const scrollArea = document.getElementById("scroll-area");
        const composer = document.getElementById("composer");
        const input = document.getElementById("composer-input");
        if (
            !header ||
            !conversation ||
            !scrollArea ||
            !composer ||
            !input ||
            document.getElementById("chat-actions-button")
        ) {
            return;
        }

        function element(tag, className, text) {
            const node = document.createElement(tag);
            node.className = className;
            if (text !== undefined) {
                node.textContent = text;
            }

            return node;
        }

        function button(label, className = "extras-small-button") {
            const node = element("button", className, label);
            node.type = "button";

            return node;
        }

        const delegates = element("section", "delegates-panel");
        delegates.id = "delegates-panel";
        delegates.setAttribute("aria-label", "Delegates");
        delegates.hidden = true;
        const delegateHeader = element("div", "delegates-header");
        const delegateCount = element("span", "delegates-count");
        delegateHeader.append(element("strong", "", "Delegates"), delegateCount);
        const delegateRows = element("div", "delegates-rows");
        const delegateNote = element(
            "p",
            "delegates-note",
            "Results are advisory. Stopping keeps a slot occupied until Pi reports settlement; remote termination is not guaranteed.",
        );
        delegates.append(delegateHeader, delegateRows, delegateNote);
        document.querySelector(".footer-panels")?.prepend(delegates);
        const workerRows = new Map();
        let delegateContext;
        let delegateStatus = "";
        function workerLabel(job) {
            if (job.settling && !["running", "queued"].includes(job.state)) {
                return ["complete", "partial", "needs_context"].includes(job.state) ? "Finishing" : "Stopping";
            }

            if (job.disposition) {
                return job.disposition === "accept"
                    ? "Parent accepted"
                    : job.disposition === "discard"
                      ? "Parent discarded"
                      : "Needs checking";
            }

            return (
                {
                    queued: "Queued",
                    running: "Running",
                    complete: "Ready for review",
                    partial: "Partial result",
                    needs_context: "Needs context",
                    failed: "Failed",
                    cancelled: "Stopped",
                    expired: "Timed out",
                    stale: "Invalidated",
                }[job.state] || "Unknown"
            );
        }

        function updateDelegates() {
            const state = getState();
            const context = `${state.conversationKey || ""}/${state.contextToken || ""}`;
            if (context !== delegateContext) {
                delegateContext = context;
                workerRows.clear();
                delegateRows.replaceChildren();
                delegateStatus = "";
            }

            const view = state.delegation;
            const connected = ["ready", "busy", "retrying", "compacting"].includes(state.status);
            const jobs = connected && Array.isArray(view?.jobs) ? view.jobs.slice(0, 8) : [];
            delegates.hidden = !connected || !view || (!jobs.length && !view.active);
            if (view) {
                delegateCount.textContent = `${view.active}/${view.concurrency} occupied · ${view.calls}/${view.callLimit} calls${view.enabled ? "" : " · off/paused"}`;
            }

            if (!jobs.length) {
                workerRows.clear();
                delegateRows.replaceChildren();
                delegateStatus = "";

                return;
            }

            const keys = new Set();
            const nodes = [];
            for (const job of jobs) {
                const key = `${job.batchId}/${job.id}/${job.attemptId}`;
                keys.add(key);
                let row = workerRows.get(key);
                if (!row) {
                    const node = element("div", "delegate-worker");
                    const details = element("details", "delegate-details");
                    const summary = element("summary");
                    const name = element("span", "delegate-name");
                    const status = element("span", "delegate-state");
                    const metrics = element("span", "delegate-metrics");
                    const task = element("p", "delegate-task");
                    const model = element("p", "delegate-model");
                    const error = element("p", "delegate-error");
                    summary.append(name, status, metrics);
                    details.append(summary, task, model, error);
                    const stop = button("Stop", "delegate-stop");
                    stop.setAttribute("aria-label", `Stop delegate ${job.id}`);
                    stop.addEventListener("click", () =>
                        send({
                            type: "stopDelegate",
                            batchId: job.batchId,
                            jobId: job.id,
                            attemptId: job.attemptId,
                            contextToken: getState().contextToken,
                        }),
                    );
                    node.append(details, stop);
                    row = { node, name, status, metrics, task, model, error, stop };
                    workerRows.set(key, row);
                }

                row.name.textContent = `${job.id} · ${job.mode}`;
                row.status.textContent = workerLabel(job);
                row.status.dataset.state =
                    job.settling && !["running", "queued"].includes(job.state) ? "settling" : job.state;
                const seconds = Math.floor(job.elapsedMs / 1000);
                row.metrics.textContent = `${Math.floor(seconds / 60)}m ${seconds % 60}s · ${job.calls} model · ${job.tools} tools`;
                if (job.task) {
                    row.task.textContent = job.task;
                }

                row.task.hidden = !row.task.textContent;
                row.model.textContent = [job.provider, job.model].filter(Boolean).join(" / ");
                row.error.textContent = job.error || "";
                row.error.hidden = !job.error;
                row.stop.hidden = !["queued", "running"].includes(job.state);
                row.stop.disabled = Boolean(
                    job.stopPending ||
                    view.canStop === false ||
                    !state.commands?.some((command) => command.name === "delegate"),
                );
                row.stop.textContent = job.stopPending ? "Requesting…" : "Stop";
                nodes.push(row.node);
            }

            for (const key of workerRows.keys()) {
                if (!keys.has(key)) {
                    workerRows.delete(key);
                }
            }

            const current = Array.from(delegateRows.children);
            if (nodes.length !== current.length || nodes.some((node, index) => current[index] !== node)) {
                delegateRows.replaceChildren(...nodes);
            }

            const nextStatus = jobs.map((job) => `${job.id}: ${workerLabel(job)}`).join("; ");
            if (nextStatus !== delegateStatus) {
                delegateStatus = nextStatus;
                announce(`Delegates — ${nextStatus}`);
            }
        }

        const actions = element("div", "extras-actions");
        const actionsButton = button("⋯", "icon-button extras-actions-button");
        actionsButton.id = "chat-actions-button";
        actionsButton.title = "Chat actions";
        actionsButton.setAttribute("aria-label", "Chat actions");
        actionsButton.setAttribute("aria-haspopup", "menu");
        actionsButton.setAttribute("aria-expanded", "false");
        const menu = element("div", "extras-actions-menu");
        menu.id = "chat-actions-menu";
        menu.hidden = true;
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", "Chat actions");
        actionsButton.setAttribute("aria-controls", menu.id);
        const menuItems = [];
        const actionDefinitions = [
            ["editPrompt", "Edit earlier prompt", "ready"],
            ["forkChat", "Branch conversation", "ready"],
            ["exportChat", "Export conversation", "messages"],
            ["copyConversation", "Copy conversation", "messages"],
            ["showUsage", "Usage details", "connected"],
        ];

        function closeMenu(restoreFocus = false) {
            menu.hidden = true;
            actionsButton.setAttribute("aria-expanded", "false");
            if (restoreFocus) {
                actionsButton.focus();
            }
        }

        function updateActions() {
            const state = getState();
            const hasMessages = Array.isArray(state.messages) && state.messages.length > 0;
            const ready = state.status === "ready" && !state.uiRequest;
            const connected = ["ready", "busy", "retrying", "compacting"].includes(state.status);
            for (const [index, definition] of actionDefinitions.entries()) {
                const requirement = definition[2];
                menuItems[index].disabled =
                    requirement === "ready"
                        ? !ready || !hasMessages
                        : requirement === "messages"
                          ? !hasMessages
                          : !connected;
            }
        }

        for (const [type, label] of actionDefinitions) {
            const item = button(label, "extras-menu-item");
            item.dataset.action = type;
            item.setAttribute("role", "menuitem");
            item.tabIndex = -1;
            item.addEventListener("click", () => {
                closeMenu(true);
                send({ type });
            });
            menuItems.push(item);
            menu.append(item);
        }

        function openMenu(last = false) {
            updateActions();
            menu.hidden = false;
            actionsButton.setAttribute("aria-expanded", "true");
            const enabled = menuItems.filter((item) => !item.disabled);
            (last ? enabled.at(-1) : enabled[0])?.focus();
        }

        actionsButton.addEventListener("click", () => {
            if (menu.hidden) {
                openMenu();
            } else {
                closeMenu(true);
            }
        });
        actionsButton.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                openMenu(event.key === "ArrowUp");
            }
        });
        actions.addEventListener("keydown", (event) => {
            if (menu.hidden) {
                return;
            }

            const enabled = menuItems.filter((item) => !item.disabled);
            const current = enabled.indexOf(document.activeElement);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && enabled.length) {
                event.preventDefault();
                const index =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? enabled.length - 1
                          : (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
                enabled[index].focus();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
            } else if (event.key === "Tab") {
                closeMenu();
            }
        });
        actions.append(actionsButton, menu);
        header.append(actions);
        const usage = document.getElementById("token-status");
        if (usage) {
            usage.setAttribute("role", "button");
            usage.setAttribute("aria-label", "Session usage details");
            usage.tabIndex = 0;
            usage.addEventListener("click", () => {
                if (["ready", "busy", "retrying", "compacting"].includes(getState().status)) {
                    send({ type: "showUsage" });
                }
            });
            usage.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    usage.click();
                }
            });
        }

        const recoveredPanel = element("section", "extras-recovered-drafts");
        recoveredPanel.id = "recovered-image-drafts";
        recoveredPanel.hidden = true;
        recoveredPanel.setAttribute("aria-label", "Stopped image messages");
        const recoveredTitle = element("div", "extras-recovered-title", "Stopped image messages");
        const recoveredRows = element("div", "extras-recovered-rows");
        recoveredPanel.append(recoveredTitle, recoveredRows);
        document.querySelector(".footer-panels")?.append(recoveredPanel);
        let recoveredSignature = "";

        function updateRecoveredDrafts() {
            const state = getState();
            const drafts = Array.isArray(state.recoveredDrafts)
                ? state.recoveredDrafts.filter((draft) => draft && typeof draft.id === "string").slice(0, 8)
                : [];
            const disabled =
                state.status === "connecting" ||
                ["busy", "retrying", "compacting"].includes(state.status) ||
                Boolean(state.uiRequest);
            const signature = JSON.stringify([disabled, drafts]);
            if (signature === recoveredSignature) {
                return;
            }

            recoveredSignature = signature;
            recoveredPanel.hidden = drafts.length === 0;
            recoveredRows.replaceChildren();
            for (const draft of drafts) {
                const row = element("div", "extras-recovered-row");
                const text = typeof draft.text === "string" ? draft.text.slice(0, 120) : "";
                const count =
                    Number.isInteger(draft.imageCount) && draft.imageCount > 0 ? Math.min(8, draft.imageCount) : 0;
                const label = element(
                    "span",
                    "extras-recovered-label",
                    `${count} image${count === 1 ? "" : "s"}${text ? ` · ${text}` : ""}`,
                );
                label.title = label.textContent;
                const restore = button("Restore draft", "text-button extras-recovered-restore");
                restore.disabled = disabled;
                restore.addEventListener("click", () => send({ type: "restoreQueuedDraft", id: draft.id }));
                const dismiss = button("×", "extras-small-button");
                dismiss.setAttribute("aria-label", "Dismiss stopped image message");
                dismiss.disabled = disabled;
                dismiss.addEventListener("click", () => send({ type: "dismissQueuedDraft", id: draft.id }));
                row.append(label, restore, dismiss);
                recoveredRows.append(row);
            }
        }

        const search = element("div", "extras-search");
        search.id = "conversation-search";
        search.hidden = true;
        search.setAttribute("role", "search");
        search.setAttribute("aria-label", "Search conversation");
        const searchInput = element("input", "extras-search-input");
        searchInput.type = "search";
        searchInput.placeholder = "Search messages";
        searchInput.maxLength = 256;
        searchInput.setAttribute("aria-label", "Search messages");
        const searchCount = element("span", "extras-search-count", "0/0");
        searchCount.setAttribute("role", "status");
        const previous = button("↑");
        previous.setAttribute("aria-label", "Previous matching message");
        const next = button("↓");
        next.setAttribute("aria-label", "Next matching message");
        const closeSearchButton = button("×");
        closeSearchButton.setAttribute("aria-label", "Close conversation search");
        search.append(searchInput, searchCount, previous, next, closeSearchButton);
        scrollArea.insertBefore(search, scrollArea.firstChild);
        let matches = [];
        let matchIndex = -1;
        let searchTimer;
        let returnFocus = input;

        function messageSearchText(message) {
            const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    return node.parentElement?.closest(
                        ".message-header, .code-copy, .image-thumbnail, .tool-state, .tool-section-label, .reasoning > summary, [aria-hidden='true']",
                    )
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                },
            });
            const text = [];
            let node;
            while ((node = walker.nextNode())) {
                text.push(node.textContent);
            }

            return text.join("").toLocaleLowerCase();
        }

        function selectMatch(index, scroll = true) {
            for (const message of conversation.querySelectorAll(".extras-search-match")) {
                message.classList.remove("extras-search-match");
            }

            matchIndex = matches.length ? (index + matches.length) % matches.length : -1;
            const selected = matches[matchIndex];
            selected?.classList.add("extras-search-match");
            searchCount.textContent = `${matchIndex + 1}/${matches.length}`;
            searchCount.setAttribute("aria-label", `${matchIndex + 1} of ${matches.length} matching messages`);
            previous.disabled = next.disabled = matches.length === 0;
            if (selected && scroll) {
                const query = searchInput.value.toLocaleLowerCase();
                for (const details of selected.querySelectorAll("details")) {
                    if (details.textContent.toLocaleLowerCase().includes(query)) {
                        details.open = true;
                    }
                }

                selected.scrollIntoView({ block: "nearest" });
            }
        }

        function refreshSearch(scroll = true) {
            window.clearTimeout(searchTimer);
            const selected = matches[matchIndex];
            const query = searchInput.value.toLocaleLowerCase();
            // Search rendered text only. Image URLs and their base64 payloads are never inspected.
            matches = query
                ? Array.from(conversation.querySelectorAll(".message")).filter((message) =>
                      messageSearchText(message).includes(query),
                  )
                : [];
            const retained = matches.indexOf(selected);
            selectMatch(retained >= 0 ? retained : 0, scroll);
        }

        function closeSearch() {
            search.hidden = true;
            window.clearTimeout(searchTimer);
            for (const message of conversation.querySelectorAll(".extras-search-match")) {
                message.classList.remove("extras-search-match");
            }

            (returnFocus?.isConnected ? returnFocus : input).focus();
        }

        function openSearch() {
            if (search.hidden) {
                returnFocus = document.activeElement;
            }

            search.hidden = false;
            searchInput.focus();
            searchInput.select();
            refreshSearch(false);
        }

        searchInput.addEventListener("input", () => refreshSearch());
        search.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
            } else if (event.key === "Enter" && event.target === searchInput) {
                event.preventDefault();
                selectMatch(matchIndex + (event.shiftKey ? -1 : 1));
            }
        });
        previous.addEventListener("click", () => selectMatch(matchIndex - 1));
        next.addEventListener("click", () => selectMatch(matchIndex + 1));
        closeSearchButton.addEventListener("click", closeSearch);
        new MutationObserver(() => {
            if (!search.hidden) {
                window.clearTimeout(searchTimer);
                searchTimer = window.setTimeout(() => refreshSearch(false), 150);
            }
        }).observe(conversation, { childList: true, characterData: true, subtree: true });

        const mentionMenu = element("div", "extras-mention-menu");
        mentionMenu.id = "file-mention-menu";
        mentionMenu.hidden = true;
        mentionMenu.setAttribute("role", "listbox");
        mentionMenu.setAttribute("aria-label", "Workspace files");
        composer.append(mentionMenu);
        let mentionTimer;
        let suggestionSequence = 0;
        let attachmentSequence = 0;
        let activeMention = null;
        let suggestionId = "";
        let mentionItems = [];
        let mentionIndex = 0;
        let dismissedMention = "";
        const pendingMentions = new Map();
        let mentionContext = getState().contextToken;
        let mentionConversation = getState().conversationKey;

        function mentionSignature() {
            return `${input.selectionStart}:${input.value}`;
        }

        function hideMentions() {
            window.clearTimeout(mentionTimer);
            mentionMenu.hidden = true;
            mentionItems = [];
            suggestionId = "";
            activeMention = null;
            if (input.getAttribute("aria-controls") === mentionMenu.id) {
                input.removeAttribute("aria-controls");
                input.removeAttribute("aria-expanded");
                input.removeAttribute("aria-activedescendant");
                input.removeAttribute("aria-autocomplete");
            }
        }

        function syncMentionAccessibility() {
            if (mentionMenu.hidden) {
                return;
            }

            input.setAttribute("aria-controls", mentionMenu.id);
            input.setAttribute("aria-expanded", "true");
            input.setAttribute("aria-autocomplete", "list");
            if (mentionItems.length) {
                input.setAttribute("aria-activedescendant", `file-mention-${mentionIndex}`);
            } else {
                input.removeAttribute("aria-activedescendant");
            }
        }

        function chooseMention(file) {
            if (!activeMention || pendingMentions.size >= 8) {
                return;
            }

            const requestId = `mention-attachment-${++attachmentSequence}`;
            const mention = activeMention;
            const timeout = window.setTimeout(() => {
                pendingMentions.delete(requestId);
                announce("The file attachment has not been confirmed. Your draft was kept.");
            }, 30000);
            pendingMentions.set(requestId, { mention, timeout });
            dismissedMention = mentionSignature();
            hideMentions();
            send({ type: "attachMention", path: file.path, requestId, contextToken: getState().contextToken });
            input.focus();
        }

        function renderMentions(message = "No matching workspace files") {
            mentionMenu.replaceChildren();
            if (!mentionItems.length) {
                const notice = element("div", "extras-mention-notice", message);
                notice.setAttribute("role", "status");
                mentionMenu.append(notice);
            }

            for (const [index, file] of mentionItems.entries()) {
                const item = button(file.label || file.path, "extras-mention-option");
                item.id = `file-mention-${index}`;
                item.title = file.path;
                item.tabIndex = -1;
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", String(index === mentionIndex));
                item.addEventListener("mousedown", (event) => event.preventDefault());
                item.addEventListener("click", () => chooseMention(file));
                mentionMenu.append(item);
            }

            mentionMenu.hidden = false;
            syncMentionAccessibility();
        }

        function queryMentions() {
            hideMentions();
            const state = getState();
            const mention = mentionAtCursor(input.value, input.selectionStart, input.selectionEnd);
            if (
                !mention ||
                state.uiRequest ||
                state.status === "connecting" ||
                dismissedMention === mentionSignature()
            ) {
                return;
            }

            activeMention = mention;
            suggestionId = `mention-search-${++suggestionSequence}`;
            mentionIndex = 0;
            renderMentions("Finding workspace files…");
            mentionTimer = window.setTimeout(() => {
                send({ type: "findFiles", query: mention.query, requestId: suggestionId });
            }, 150);
        }

        input.addEventListener("input", (event) => {
            dismissedMention = "";
            if (event.isComposing) {
                hideMentions();

                return;
            }

            queryMentions();
        });
        input.addEventListener("compositionend", queryMentions);
        input.addEventListener("click", queryMentions);
        input.addEventListener("keyup", (event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                queryMentions();
            }
        });
        input.addEventListener(
            "keydown",
            (event) => {
                if (mentionMenu.hidden || event.isComposing || event.keyCode === 229) {
                    return;
                }

                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    dismissedMention = mentionSignature();
                    hideMentions();
                } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (mentionItems.length) {
                        mentionIndex =
                            (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionItems.length) %
                            mentionItems.length;
                        renderMentions();
                        document.getElementById(`file-mention-${mentionIndex}`)?.scrollIntoView({ block: "nearest" });
                    }
                } else if (event.key === "Tab" && event.shiftKey) {
                    hideMentions();
                } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                    if (mentionItems.length || event.key === "Enter") {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        if (mentionItems.length) {
                            chooseMention(mentionItems[mentionIndex]);
                        }
                    } else {
                        hideMentions();
                    }
                }
            },
            true,
        );

        document.addEventListener("pointerdown", (event) => {
            if (!actions.contains(event.target)) {
                closeMenu();
            }

            if (event.target !== input && !mentionMenu.contains(event.target)) {
                hideMentions();
            }
        });
        document.addEventListener("keydown", (event) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                hideMentions();
                openSearch();
            }
        });
        window.addEventListener("message", (event) => {
            const message = event.data;
            if (!message || typeof message !== "object") {
                return;
            }

            if (
                message.type !== "state" &&
                message.conversationKey &&
                message.conversationKey !== getState().conversationKey
            ) {
                return;
            }

            if (message.type === "state") {
                update();
            } else if (message.type === "draft") {
                hideMentions();
                for (const pending of pendingMentions.values()) {
                    window.clearTimeout(pending.timeout);
                }

                pendingMentions.clear();
            } else if (message.type === "fileSuggestions" && message.requestId === suggestionId && activeMention) {
                const current = mentionAtCursor(input.value, input.selectionStart, input.selectionEnd);
                if (
                    !current ||
                    current.draft !== activeMention.draft ||
                    current.start !== activeMention.start ||
                    current.end !== activeMention.end ||
                    current.query !== activeMention.query
                ) {
                    hideMentions();

                    return;
                }

                mentionItems = Array.isArray(message.files)
                    ? message.files
                          .filter(
                              (file) =>
                                  file &&
                                  typeof file.path === "string" &&
                                  file.path.length > 0 &&
                                  file.path.length <= 4096 &&
                                  (file.label === undefined || typeof file.label === "string"),
                          )
                          .slice(0, 30)
                    : [];
                mentionIndex = 0;
                renderMentions(message.error ? "Workspace files could not be listed" : undefined);
                announce(`${mentionItems.length} matching workspace files`);
            } else if (message.type === "attachmentResult" && pendingMentions.has(message.requestId)) {
                const pending = pendingMentions.get(message.requestId);
                pendingMentions.delete(message.requestId);
                window.clearTimeout(pending.timeout);
                if (message.error || message.success === false) {
                    announce(
                        typeof message.error === "string"
                            ? message.error
                            : "File attachment cancelled. Your draft was kept.",
                    );

                    return;
                }

                const updated = removeAcceptedMention(input.value, pending.mention);
                if (updated) {
                    input.value = updated.text;
                    input.setSelectionRange(updated.cursor, updated.cursor);
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                }

                announce("Workspace file attached");
            }
        });
        function update() {
            if (mentionContext !== getState().contextToken || mentionConversation !== getState().conversationKey) {
                mentionContext = getState().contextToken;
                mentionConversation = getState().conversationKey;
                hideMentions();
                for (const pending of pendingMentions.values()) {
                    window.clearTimeout(pending.timeout);
                }

                pendingMentions.clear();
            }

            updateActions();
            updateDelegates();
            updateRecoveredDrafts();
            if (usage) {
                const disabled = !["ready", "busy", "retrying", "compacting"].includes(getState().status);
                usage.setAttribute("aria-disabled", String(disabled));
                usage.tabIndex = disabled ? -1 : 0;
            }

            if (getState().uiRequest || getState().status === "connecting") {
                hideMentions();
            } else {
                syncMentionAccessibility();
            }
        }

        update();

        return { update };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { mentionAtCursor, removeAcceptedMention };
    }

    if (typeof window !== "undefined") {
        window.SpecPiExtras = { install };
    }
})();
