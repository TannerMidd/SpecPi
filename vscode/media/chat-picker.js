(function () {
    "use strict";

    const MAX_CONVERSATIONS = 1000;

    function conversationItems(value, { archived = false, query = "", now = Date.now() } = {}) {
        const search = typeof query === "string" ? query.trim().toLocaleLowerCase().slice(0, 200) : "";
        const ids = new Set();
        const items = [];
        for (const item of Array.isArray(value) ? value.slice(0, MAX_CONVERSATIONS) : []) {
            if (!item || typeof item.id !== "string" || !item.id || item.id.length > 4096 || ids.has(item.id)) {
                continue;
            }

            ids.add(item.id);
            if (Boolean(item.archived) !== archived) {
                continue;
            }

            const title =
                typeof item.title === "string" && item.title.trim()
                    ? item.title.trim().slice(0, 500)
                    : "Untitled conversation";
            const workspaceName = typeof item.workspaceName === "string" ? item.workspaceName.slice(0, 160) : "";
            if (search && !`${title} ${workspaceName}`.toLocaleLowerCase().includes(search)) {
                continue;
            }

            const timestamp = typeof item.updatedAt === "number" ? item.updatedAt : Date.parse(item.updatedAt);
            const updatedAt = Number.isFinite(timestamp) && timestamp > 0 ? Math.min(timestamp, now) : 0;
            items.push({ ...item, title, workspaceName, updatedAt });
        }

        return items.sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title));
    }

    function dateGroup(timestamp, now = Date.now()) {
        if (!timestamp) {
            return "Earlier";
        }

        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const week = new Date(today);
        week.setDate(week.getDate() - 7);
        if (timestamp >= today.getTime()) {
            return "Today";
        }

        if (timestamp >= yesterday.getTime()) {
            return "Yesterday";
        }

        return timestamp >= week.getTime() ? "Previous 7 days" : "Earlier";
    }

    function relativeTime(timestamp, now = Date.now()) {
        if (!timestamp) {
            return "";
        }

        const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
        if (minutes < 1) {
            return "now";
        }

        if (minutes < 60) {
            return `${minutes}m`;
        }

        if (minutes < 1440) {
            return `${Math.floor(minutes / 60)}h`;
        }

        if (minutes < 10080) {
            return `${Math.floor(minutes / 1440)}d`;
        }

        return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function conversationStatus(item) {
        if (["needs-input", "needsInput", "waiting", "waitingForInput"].includes(item.status)) {
            return "Needs input";
        }

        if (["busy", "running", "retrying", "compacting", "connecting"].includes(item.status)) {
            return item.status === "connecting" ? "Connecting" : "Running";
        }

        if (item.status === "error") {
            return "Error";
        }

        return item.unread ? "Unread" : "";
    }

    function install({ send, getState, announce }) {
        const anchor = document.getElementById("history-button");
        if (!anchor || document.getElementById("history-panel")) {
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

        function button(label, className) {
            const node = element("button", className, label);
            node.type = "button";

            return node;
        }

        function icon(name) {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("class", "icon");
            svg.setAttribute("aria-hidden", "true");
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            const paths = {
                search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
                rename: "m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z",
                archive: "M4 8h16v12H4zM3 4h18v4H3zM9 12h6",
                restore: "M4 8h16v12H4zM3 4h18v4H3zM12 17v-6m-3 3 3-3 3 3",
                plus: "M12 5v14M5 12h14",
                close: "m6 6 12 12M6 18 18 6",
            };
            path.setAttribute("d", paths[name]);
            svg.append(path);

            return svg;
        }

        const panel = element("section", "history-panel");
        panel.id = "history-panel";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Conversation history");
        anchor.setAttribute("aria-haspopup", "dialog");
        anchor.setAttribute("aria-expanded", "false");
        anchor.setAttribute("aria-controls", panel.id);
        const header = element("div", "history-header");
        const heading = element("h2", "history-heading", "Conversations");
        const newButton = button("", "history-icon-button history-new");
        newButton.title = "New conversation";
        newButton.setAttribute("aria-label", "New conversation");
        newButton.append(icon("plus"));
        const closeButton = button("", "history-icon-button");
        closeButton.title = "Close conversation history";
        closeButton.setAttribute("aria-label", "Close conversation history");
        closeButton.append(icon("close"));
        header.append(heading, newButton, closeButton);
        const tabs = element("div", "history-tabs");
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", "Conversation lists");
        const currentTab = button("Conversations", "history-tab");
        const archivedTab = button("Archived", "history-tab");
        for (const [index, tab] of [currentTab, archivedTab].entries()) {
            tab.setAttribute("role", "tab");
            tab.id = index ? "history-archived-tab" : "history-current-tab";
            tab.setAttribute("aria-controls", "history-results");
            tabs.append(tab);
        }

        const searchWrap = element("div", "history-search-wrap");
        const search = element("input", "history-search");
        search.id = "history-search";
        search.type = "search";
        search.placeholder = "Search conversations…";
        search.maxLength = 200;
        search.autocomplete = "off";
        search.setAttribute("aria-label", "Search conversations");
        search.setAttribute("aria-controls", "history-list");
        search.setAttribute("aria-describedby", "history-result-count");
        searchWrap.append(icon("search"), search);
        const feedback = element("div", "history-feedback");
        feedback.hidden = true;
        const errorText = element("span", "history-error-text");
        errorText.setAttribute("role", "alert");
        const retryButton = button("Retry", "history-text-button");
        feedback.append(errorText, retryButton);
        const results = element("div", "history-results");
        results.id = "history-results";
        results.setAttribute("role", "tabpanel");
        const list = element("ul", "history-list");
        list.id = "history-list";
        list.setAttribute("aria-label", "Conversations");
        const empty = element("div", "history-empty");
        const emptyTitle = element("p", "history-empty-title");
        const emptyDetail = element("p", "history-empty-detail");
        empty.append(emptyTitle, emptyDetail);
        const moreButton = button("Show more conversations", "history-more history-text-button");
        results.append(list, empty, moreButton);
        const footer = element("div", "history-footer");
        const count = element("span", "history-result-count");
        count.id = "history-result-count";
        const keyboardHint = element("span", "history-keyboard-hint", "↑↓ navigate · Esc close");
        keyboardHint.setAttribute("aria-hidden", "true");
        footer.append(count, keyboardHint);
        panel.append(header, tabs, searchWrap, feedback, results, footer);
        document.body.append(panel);
        let archived = false;
        let limit = 100;
        let focusedId;
        let editing;
        let localError = "";
        let retryAction;
        let renderedSignature;
        let visibleItems = [];
        const pending = new Map();

        function position() {
            if (panel.hidden) {
                return;
            }

            const rect = anchor.getBoundingClientRect();
            const top = Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 240));
            panel.style.top = `${Math.round(top)}px`;
            panel.style.maxHeight = `${Math.min(580, Math.max(160, window.innerHeight - top - 10))}px`;
        }

        function close(restoreFocus = true) {
            panel.hidden = true;
            anchor.setAttribute("aria-expanded", "false");
            if (restoreFocus) {
                anchor.focus();
            }
        }

        function action(message) {
            localError = "";
            retryAction = message;
            if (message.id) {
                pending.set(message.id, message);
            }

            send(message);
            update();
        }

        function select(item) {
            if (item.id === getState().conversationKey || item.isActive) {
                close();

                return;
            }

            action({ type: "selectConversation", id: item.id });
        }

        function rename(item) {
            editing = { id: item.id, value: item.title };
            localError = "";
            retryAction = undefined;
            renderedSignature = undefined;
            update();
            const input = list.querySelector(".history-rename-input");
            input?.focus();
            input?.select();
        }

        function saveRename(item) {
            const name = editing?.value.trim();
            if (!name) {
                localError = "Enter a conversation name.";
                retryAction = undefined;
                update();
                list.querySelector(".history-rename-input")?.focus();

                return;
            }

            if (name === item.title) {
                editing = undefined;
                renderedSignature = undefined;
                update();
                focusRow(item.id);

                return;
            }

            action({ type: "renameConversation", id: item.id, name });
        }

        function focusRow(id) {
            const row = Array.from(list.querySelectorAll(".history-open")).find((node) => node.dataset.id === id);
            if (row) {
                focusedId = id;
                for (const node of list.querySelectorAll(".history-open")) {
                    node.tabIndex = node === row ? 0 : -1;
                }

                row.focus();
                row.scrollIntoView({ block: "nearest" });
            }
        }

        function row(item, state, now) {
            const selected = item.id === state.conversationKey || item.isActive;
            const pendingAction = pending.get(item.id);
            const node = element("li", "history-row");
            node.dataset.selected = String(Boolean(selected));
            node.dataset.id = item.id;
            const open = button("", "history-open");
            open.dataset.id = item.id;
            open.dataset.control = "open";
            open.tabIndex = item.id === focusedId ? 0 : -1;
            if (selected) {
                open.setAttribute("aria-current", "true");
            }

            const title = element("span", "history-title", item.title);
            const detail = element("span", "history-row-detail");
            const status = pendingAction?.type === "selectConversation" ? "Opening…" : conversationStatus(item);
            if (status) {
                const badge = element("span", "history-status", status);
                badge.dataset.status = status.toLowerCase().replaceAll(" ", "-");
                detail.append(badge);
            }

            if (item.workspaceName) {
                detail.append(element("span", "history-workspace", item.workspaceName));
            }

            open.append(title, detail);
            open.title = item.title;
            open.setAttribute(
                "aria-label",
                `${item.title}${selected ? ", current conversation" : ""}${status ? `, ${status}` : ""}`,
            );
            open.addEventListener("click", () => select(item));
            const end = element("div", "history-row-end");
            const time = element("time", "history-time", relativeTime(item.updatedAt, now));
            if (item.updatedAt) {
                time.dateTime = new Date(item.updatedAt).toISOString();
                time.title = new Date(item.updatedAt).toLocaleString();
            }

            const actions = element("div", "history-row-actions");
            const renameButton = button("", "history-icon-button");
            renameButton.append(icon("rename"));
            renameButton.title = "Rename conversation";
            renameButton.setAttribute("aria-label", `Rename ${item.title}`);
            renameButton.dataset.control = "rename";
            renameButton.disabled = Boolean(pendingAction);
            renameButton.addEventListener("click", () => rename(item));
            const archiveButton = button("", "history-icon-button");
            archiveButton.append(icon(archived ? "restore" : "archive"));
            archiveButton.title = archived ? "Restore conversation" : "Archive conversation";
            archiveButton.setAttribute("aria-label", `${archived ? "Restore" : "Archive"} ${item.title}`);
            archiveButton.dataset.control = "archive";
            archiveButton.disabled = Boolean(pendingAction);
            archiveButton.addEventListener("click", () =>
                action({ type: "archiveConversation", id: item.id, archived: !archived }),
            );
            actions.append(renameButton, archiveButton);
            end.append(time, actions);
            node.append(open, end);
            if (editing?.id === item.id) {
                const form = element("form", "history-rename-form");
                const input = element("input", "history-rename-input");
                input.value = editing.value;
                input.maxLength = 160;
                input.setAttribute("aria-label", "Conversation name");
                input.dataset.control = "name";
                input.disabled = Boolean(pendingAction);
                input.addEventListener("input", () => {
                    editing.value = input.value;
                });
                const save = button(pendingAction ? "Saving…" : "Save", "history-save-button");
                save.type = "submit";
                save.dataset.control = "save";
                save.disabled = Boolean(pendingAction);
                const cancel = button("Cancel", "history-text-button");
                cancel.dataset.control = "cancel";
                cancel.disabled = Boolean(pendingAction);
                cancel.addEventListener("click", () => {
                    editing = undefined;
                    renderedSignature = undefined;
                    update();
                    focusRow(item.id);
                });
                form.addEventListener("submit", (event) => {
                    event.preventDefault();
                    saveRename(item);
                });
                form.append(input, save, cancel);
                node.append(form);
            }

            return node;
        }

        function renderList(items, state, now) {
            const signature = JSON.stringify([items, state.conversationKey, editing?.id, [...pending]]);
            if (signature === renderedSignature) {
                return;
            }

            renderedSignature = signature;
            const active = document.activeElement;
            const activeRow = active?.closest(".history-row");
            const restore =
                activeRow && panel.contains(activeRow)
                    ? {
                          id: activeRow.dataset.id,
                          control: active.dataset.control,
                          start: active.selectionStart,
                          end: active.selectionEnd,
                      }
                    : undefined;
            const scrollTop = results.scrollTop;
            const nodes = [];
            let group;
            for (const item of items) {
                const nextGroup = dateGroup(item.updatedAt, now);
                if (nextGroup !== group) {
                    group = nextGroup;
                    const separator = element("li", "history-group", group);
                    separator.setAttribute("role", "presentation");
                    nodes.push(separator);
                }

                nodes.push(row(item, state, now));
            }

            list.replaceChildren(...nodes);
            results.scrollTop = scrollTop;
            if (restore) {
                const restoredRow = Array.from(list.querySelectorAll(".history-row")).find(
                    (node) => node.dataset.id === restore.id,
                );
                const control = Array.from(restoredRow?.querySelectorAll("[data-control]") || []).find(
                    (node) => node.dataset.control === restore.control,
                );
                if (control && !control.disabled) {
                    control.focus({ preventScroll: true });
                    if (control.tagName === "INPUT" && Number.isInteger(restore.start)) {
                        control.setSelectionRange(restore.start, restore.end);
                    }
                } else {
                    const fallback = restoredRow?.querySelector(".history-open") || search;
                    fallback.focus({ preventScroll: true });
                }
            }
        }

        function update() {
            const state = getState();
            const all = conversationItems(state.conversations, { archived, query: search.value });
            let selectedFinished = false;
            for (const [id, message] of pending) {
                const item = Array.isArray(state.conversations)
                    ? state.conversations.find((entry) => entry.id === id)
                    : undefined;
                const finished =
                    message.type === "selectConversation"
                        ? state.conversationKey === id || item?.isActive
                        : message.type === "renameConversation"
                          ? item?.title === message.name
                          : Boolean(item) && Boolean(item.archived) === message.archived;
                if (finished) {
                    pending.delete(id);
                    if (message.type === "renameConversation" && editing?.id === id) {
                        editing = undefined;
                    }

                    selectedFinished ||= message.type === "selectConversation";
                }
            }

            if (selectedFinished && !panel.hidden) {
                close();
            }

            if (panel.hidden) {
                return;
            }

            currentTab.setAttribute("aria-selected", String(!archived));
            currentTab.tabIndex = archived ? -1 : 0;
            archivedTab.setAttribute("aria-selected", String(archived));
            archivedTab.tabIndex = archived ? 0 : -1;
            results.setAttribute("aria-labelledby", archived ? archivedTab.id : currentTab.id);
            const hostError = typeof state.historyError === "string" ? state.historyError.slice(0, 1000) : "";
            const error = localError || hostError;
            feedback.hidden = !error;
            errorText.textContent = error;
            retryButton.hidden = Boolean(localError && !retryAction);
            results.setAttribute("aria-busy", String(Boolean(state.historyLoading)));
            visibleItems = all.slice(0, limit);
            if (!visibleItems.some((item) => item.id === focusedId)) {
                focusedId =
                    visibleItems.find((item) => item.id === state.conversationKey || item.isActive)?.id ||
                    visibleItems[0]?.id;
            }

            renderList(visibleItems, state, Date.now());
            const query = search.value.trim();
            empty.hidden = Boolean(all.length);
            emptyTitle.textContent = state.historyLoading
                ? "Loading conversations…"
                : error
                  ? "Conversations could not be loaded"
                  : query
                    ? "No matching conversations"
                    : archived
                      ? "No archived conversations"
                      : "Your conversations appear here";
            emptyDetail.textContent =
                state.historyLoading || error
                    ? ""
                    : query
                      ? "Try another name or workspace."
                      : archived
                        ? "Archive a conversation to keep your list tidy. You can restore it anytime."
                        : "Start a conversation and return to it whenever you like.";
            count.textContent = state.historyLoading
                ? "Refreshing…"
                : `${all.length} ${all.length === 1 ? "conversation" : "conversations"}${query ? " found" : ""}`;
            moreButton.hidden = visibleItems.length >= all.length;
            position();
        }

        function open(load = true) {
            panel.hidden = false;
            anchor.setAttribute("aria-expanded", "true");
            update();
            search.focus();
            if (load) {
                send({ type: "history" });
            }
        }

        function toggle() {
            if (panel.hidden) {
                open();
            } else {
                close();
            }
        }

        function switchTab(value, focus = false) {
            archived = value;
            limit = 100;
            editing = undefined;
            focusedId = undefined;
            renderedSignature = undefined;
            update();
            if (focus) {
                (archived ? archivedTab : currentTab).focus();
            }
        }

        currentTab.addEventListener("click", () => switchTab(false));
        archivedTab.addEventListener("click", () => switchTab(true));
        tabs.addEventListener("keydown", (event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                switchTab(event.key === "End" || (event.key !== "Home" && !archived), true);
            }
        });
        search.addEventListener("input", () => {
            limit = 100;
            focusedId = undefined;
            update();
        });
        moreButton.addEventListener("click", () => {
            limit += 100;
            update();
        });
        newButton.addEventListener("click", () => {
            close(false);
            send({ type: "newChat" });
        });
        closeButton.addEventListener("click", () => close());
        retryButton.addEventListener("click", () => {
            if (retryAction && localError) {
                action(retryAction);
            } else {
                localError = "";
                send({ type: "history" });
            }
        });
        panel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (editing && event.target.closest(".history-rename-form") && !pending.has(editing.id)) {
                    const id = editing.id;
                    editing = undefined;
                    renderedSignature = undefined;
                    update();
                    focusRow(id);
                } else {
                    close();
                }

                return;
            }

            if ((event.target !== search && !event.target.classList.contains("history-open")) || !visibleItems.length) {
                return;
            }

            const index = visibleItems.findIndex((item) => item.id === event.target.dataset.id);
            let next;
            if (event.key === "ArrowDown") {
                next = Math.min(visibleItems.length - 1, index + 1);
            } else if (event.key === "ArrowUp") {
                next = index < 0 ? visibleItems.length - 1 : Math.max(0, index - 1);
            } else if (event.key === "Home" && event.target !== search) {
                next = 0;
            } else if (event.key === "End" && event.target !== search) {
                next = visibleItems.length - 1;
            } else if (event.key === "Enter" && event.target === search) {
                event.preventDefault();
                select(visibleItems[0]);
            }

            if (next !== undefined) {
                event.preventDefault();
                focusRow(visibleItems[next].id);
            }
        });
        document.addEventListener("pointerdown", (event) => {
            if (!panel.hidden && !panel.contains(event.target) && !anchor.contains(event.target)) {
                close(false);
            }
        });
        document.addEventListener("focusin", (event) => {
            if (!panel.hidden && !panel.contains(event.target) && !anchor.contains(event.target)) {
                close(false);
            }
        });
        window.addEventListener("resize", position);

        function handleMessage(message) {
            if (message.type === "showHistory") {
                open(false);
            } else if (message.type === "historyActionResult") {
                const request = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) {
                    localError =
                        typeof message.error === "string"
                            ? message.error.slice(0, 1000)
                            : "The conversation could not be updated. Try again.";
                    retryAction = request || retryAction;
                    if (panel.hidden) {
                        open(false);
                    }

                    announce(localError);
                } else {
                    if (
                        (message.action === "renameConversation" || request?.type === "renameConversation") &&
                        editing?.id === message.id
                    ) {
                        editing = undefined;
                    }

                    if (
                        !panel.hidden &&
                        (message.action === "selectConversation" || request?.type === "selectConversation")
                    ) {
                        close();
                    }

                    localError = "";
                }

                renderedSignature = undefined;
                update();
            }
        }

        return { update, handleMessage, toggle, close };
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { conversationItems, dateGroup, relativeTime, conversationStatus };
    }

    if (typeof window !== "undefined") {
        window.SpecPiHistory = { install };
    }
})();
