(function () {
    "use strict";

    const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const MAX_IMAGE_COUNT = 8;
    const MAX_IMAGE_BATCH_BYTES = 20 * 1024 * 1024;

    function imageSource(image) {
        if (!image || !IMAGE_MIMES.has(image.mimeType) || typeof image.data !== "string" || !image.data) {
            return null;
        }

        const data = image.data;
        if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0) {
            return null;
        }

        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
            return null;
        }

        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        if (padding) {
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            const last = alphabet.indexOf(data[data.length - padding - 1]);
            if (last < 0 || (padding === 2 ? (last & 15) !== 0 : (last & 3) !== 0)) {
                return null;
            }
        }

        const byteLength = (data.length / 4) * 3 - padding;
        if (byteLength <= 0 || byteLength > MAX_IMAGE_BYTES) {
            return null;
        }

        if (
            !Number.isInteger(image.width) ||
            !Number.isInteger(image.height) ||
            image.width < 1 ||
            image.height < 1 ||
            image.width > 16384 ||
            image.height > 16384 ||
            image.width * image.height > 40_000_000
        ) {
            return null;
        }

        return `data:${image.mimeType};base64,${data}`;
    }

    function safeHref(value) {
        if (
            typeof value !== "string" ||
            value.length > 4096 ||
            !/^https?:\/\//i.test(value) ||
            /[\u0000-\u0020\u007f\\]/.test(value)
        ) {
            return null;
        }

        try {
            const url = new URL(value);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
                return null;
            }

            return url.href;
        } catch {
            return null;
        }
    }

    // This only identifies clickable text. The host validates every target and
    // opens a workspace file through VS Code; it never opens these as URLs.
    function isCodeReference(value) {
        if (
            typeof value !== "string" ||
            !value ||
            value.length > 4096 ||
            /[\u0000-\u001f\u007f`<>"|?*()[\]{}]/u.test(value)
        ) {
            return false;
        }

        let target = value.trim();
        if (/^file:\/\/\/(?!\/)/iu.test(target)) {
            target = target.slice(7);
        }

        target = target.replace(/(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+)?)$/iu, "");
        if (/^[a-z][a-z0-9+.-]*:/iu.test(target) && !/^[a-z]:[\\/]/iu.test(target)) {
            return false;
        }

        target = target.replace(/^\/?[a-z]:[\\/]/iu, "");
        if (!target || target.startsWith("//") || target.startsWith("\\\\") || /[:#]/u.test(target)) {
            return false;
        }

        return (
            /(?:^|[\\/])[^\\/]+\.[a-z0-9][a-z0-9._-]*$/iu.test(target) ||
            (/[\\/]/u.test(target) && /(?:#L\d|:\d)/u.test(value))
        );
    }

    function plainTextTokens(text) {
        const tokens = [];
        let offset = 0;
        for (const match of text.matchAll(/\S+/gu)) {
            const leading = match[0].match(/^[([{"']*/u)[0].length;
            let end = match[0].length;
            while (end > leading && "),.;]}\"'".includes(match[0][end - 1])) {
                end -= 1;
            }

            const reference = match[0].slice(leading, end);
            if (!/(?:#L\d|:\d)/u.test(reference) || !isCodeReference(reference)) {
                continue;
            }

            const start = match.index + leading;
            if (start > offset) {
                tokens.push({ type: "text", text: text.slice(offset, start) });
            }

            tokens.push({ type: "codeLink", text: reference, reference });
            offset = start + reference.length;
        }

        if (offset < text.length) {
            tokens.push({ type: "text", text: text.slice(offset) });
        }

        return tokens;
    }

    function inlineTextTokens(text) {
        const tokens = [];
        const expression =
            /(!?)\[([^\[\]\n]*)\]\((<[^<>\n]+>|[^\s()]+)(?:\s+"[^"\n]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
        let offset = 0;
        let match;
        while ((match = expression.exec(text))) {
            if (match.index > offset) {
                for (const token of plainTextTokens(text.slice(offset, match.index))) {
                    tokens.push(token);
                }
            }

            if (match[2] !== undefined) {
                const destination = match[3].startsWith("<") ? match[3].slice(1, -1) : match[3];
                const href = safeHref(destination);
                if (href) {
                    tokens.push({ type: match[1] ? "externalImage" : "link", text: match[2] || "Image", href });
                } else if (isCodeReference(destination)) {
                    let reference = destination;
                    try {
                        if (!/^file:/iu.test(reference)) {
                            reference = decodeURIComponent(reference);
                        }
                    } catch {
                        // Leave malformed escapes literal for the host to reject or locate.
                    }

                    tokens.push({ type: match[1] ? "imagePreview" : "codeLink", text: match[2] || "Image", reference });
                } else {
                    tokens.push({ type: "text", text: match[0] });
                }
            } else if (match[4] || match[5]) {
                tokens.push({ type: "strong", text: match[4] || match[5] });
            } else if (match[6]) {
                tokens.push({ type: "strike", text: match[6] });
            } else {
                tokens.push({ type: "emphasis", text: match[7] || match[8] });
            }

            offset = expression.lastIndex;
        }

        if (offset < text.length) {
            for (const token of plainTextTokens(text.slice(offset))) {
                tokens.push(token);
            }
        }

        return tokens;
    }

    function inlineTokens(value) {
        const text = String(value ?? "");
        const runs = Array.from(text.matchAll(/`+/g), (match) => ({ start: match.index, length: match[0].length }));
        const nextByLength = new Map();
        for (let index = runs.length - 1; index >= 0; index -= 1) {
            runs[index].closing = nextByLength.get(runs[index].length);
            nextByLength.set(runs[index].length, index);
        }

        const tokens = [];
        let offset = 0;
        for (let index = 0; index < runs.length; index += 1) {
            const run = runs[index];
            if (run.closing === undefined) {
                continue;
            }

            for (const token of inlineTextTokens(text.slice(offset, run.start))) {
                tokens.push(token);
            }

            const closing = runs[run.closing];
            const code = text.slice(run.start + run.length, closing.start);
            tokens.push(
                isCodeReference(code)
                    ? { type: "codeLink", text: code, reference: code }
                    : { type: "code", text: code },
            );
            offset = closing.start + closing.length;
            index = run.closing;
        }

        for (const token of inlineTextTokens(text.slice(offset))) {
            tokens.push(token);
        }

        return tokens;
    }

    function tableCells(line) {
        return line
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());
    }

    function parseMarkdown(value) {
        const lines = String(value ?? "")
            .replace(/\r\n?/g, "\n")
            .split("\n");
        const blocks = [];
        let index = 0;
        while (index < lines.length) {
            const line = lines[index];
            if (!line.trim()) {
                index += 1;
                continue;
            }

            const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
            if (fence) {
                const content = [];
                const ending = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
                index += 1;
                while (index < lines.length && !ending.test(lines[index])) {
                    content.push(lines[index]);
                    index += 1;
                }

                if (index < lines.length) {
                    index += 1;
                }

                blocks.push({ type: "code", language: fence[2].trim().slice(0, 64), text: content.join("\n") });
                continue;
            }

            const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
            if (heading) {
                const headingText = heading[2].trim();
                let end = headingText.length;
                while (headingText[end - 1] === "#") {
                    end -= 1;
                }

                blocks.push({ type: "heading", level: heading[1].length, text: headingText.slice(0, end).trimEnd() });
                index += 1;
                continue;
            }

            if (/^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(line)) {
                blocks.push({ type: "rule" });
                index += 1;
                continue;
            }

            if (/^\s{0,3}>/.test(line)) {
                const content = [];
                while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
                    content.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
                    index += 1;
                }

                blocks.push({ type: "quote", text: content.join("\n") });
                continue;
            }

            const list = line.match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
            if (list) {
                const ordered = Boolean(list[1]);
                const items = [];
                while (index < lines.length) {
                    const item = lines[index].match(/^\s*(?:(\d+)[.)]|([-+*]))\s+(.+)$/);
                    if (!item || Boolean(item[1]) !== ordered) {
                        break;
                    }

                    const task = item[3].match(/^\[([ xX])\]\s+(.*)$/);
                    items.push({ text: task ? task[2] : item[3], checked: task ? task[1] !== " " : null });
                    index += 1;
                }

                blocks.push({ type: "list", ordered, items });
                continue;
            }

            if (
                line.includes("|") &&
                index + 1 < lines.length &&
                /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim())
            ) {
                const headers = tableCells(line);
                const rows = [];
                index += 2;
                while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
                    rows.push(tableCells(lines[index]));
                    index += 1;
                }

                blocks.push({ type: "table", headers, rows });
                continue;
            }

            const content = [line];
            index += 1;
            while (
                index < lines.length &&
                lines[index].trim() &&
                !/^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+[.)]\s)/.test(lines[index])
            ) {
                content.push(lines[index]);
                index += 1;
            }

            blocks.push({ type: "paragraph", text: content.join("\n") });
        }

        return blocks;
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { safeHref, isCodeReference, parseMarkdown, inlineTokens, imageSource };
    }

    if (typeof window === "undefined" || typeof document === "undefined" || typeof acquireVsCodeApi !== "function") {
        return;
    }

    const vscode = acquireVsCodeApi();
    const MAX_INPUT = 64 * 1024;
    const LOCAL_COMMANDS = [
        { name: "help", description: "Show chat commands and keyboard shortcuts" },
        { name: "new", description: "Start a new conversation" },
        { name: "compact", description: "Compact the current conversation context" },
        { name: "model", description: "Choose an available model" },
        { name: "settings", description: "How to configure Pi in the terminal" },
        { name: "login", description: "How to sign in to a model provider with Pi" },
        { name: "logout", description: "How to manage provider sign-out with Pi" },
    ];
    const byId = (id) => document.getElementById(id);
    const input = byId("composer-input");
    const scrollArea = byId("scroll-area");
    const conversation = byId("conversation");
    const messageCache = new Map();
    let state = { status: "disconnected", messages: [], attachments: [], models: [], commands: [] };
    let followScroll = true;
    let modelSignature = "";
    let thinkingSignature = "";
    let attachmentSignature = "";
    let requestSignature = "";
    let requestAnswered = false;
    let slashItems = [];
    let slashIndex = 0;
    let dismissedSlash = "";
    let busySince = null;
    let previousStatus = state.status;
    let lastAnnouncedMessage = "";
    let runtimeSignature = "";
    const pendingCopies = new Map();
    let copySequence = 0;
    const mediaCache = new Map();
    const pendingImagePreviews = new Map();
    const pendingUploads = new Map();
    let imageSequence = 0;
    let readingImages = false;
    let imageFeedback = "";
    let imageFeedbackError = false;
    let previewReturnFocus = null;
    let dragDepth = 0;
    let submission = null;
    let extras = null;
    let history = null;
    const conversationViews = new Map();

    function currentDraft() {
        return {
            text: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            sendMode: byId("send-mode").value,
        };
    }

    function retainView(key, value) {
        if (typeof key !== "string" || !key || key.length > 200) {
            return;
        }

        conversationViews.delete(key);
        conversationViews.set(key, value);
        while (conversationViews.size > 200) {
            conversationViews.delete(conversationViews.keys().next().value);
        }
    }

    function saveDraft() {
        if (state.conversationKey) {
            vscode.postMessage({ type: "saveDraft", conversationKey: state.conversationKey, ...currentDraft() });
        }
    }

    function rememberView() {
        retainView(state.conversationKey, {
            draft: currentDraft(),
            scrollTop: scrollArea.scrollTop,
            followScroll,
            submission,
            busySince,
        });
    }

    function restoreView(next) {
        const saved = conversationViews.get(next.conversationKey);
        const draft = next.draft || saved?.draft || {};
        input.value = typeof draft.text === "string" ? draft.text.slice(0, 2 * MAX_INPUT) : "";
        const start = Number.isSafeInteger(draft.selectionStart) ? draft.selectionStart : input.value.length;
        const end = Number.isSafeInteger(draft.selectionEnd) ? draft.selectionEnd : start;
        input.setSelectionRange(Math.max(0, start), Math.max(0, end));
        byId("send-mode").value = draft.sendMode === "followUp" ? "followUp" : "steer";
        followScroll = saved?.followScroll ?? true;
        submission = saved?.submission || null;
        busySince = saved?.busySince || null;
        scrollArea.scrollTop = saved?.scrollTop || 0;
        dismissedSlash = "";
        messageCache.clear();
        conversation.replaceChildren();
        requestSignature = "";
        runtimeSignature = "";
        attachmentSignature = "";
        imageFeedback = "";
        imageFeedbackError = false;
        hideSlashMenu();
        closeAttachMenu();
        resizeComposer();

        return saved?.scrollTop || 0;
    }

    function restoreDraftText(previous, message) {
        return message.mode === "restore" && previous.trim() && previous.trim() !== message.text.trim()
            ? `${message.text}\n\n${previous}`.slice(0, 2 * MAX_INPUT)
            : message.text.slice(0, 2 * MAX_INPUT);
    }

    function handleBackgroundMessage(message) {
        const saved = conversationViews.get(message.conversationKey) || {};
        if (message.type === "draft" && typeof message.text === "string") {
            if (!message.draftSnapshot && !saved.draft) {
                return;
            }

            const text =
                typeof message.draftSnapshot?.text === "string"
                    ? message.draftSnapshot.text.slice(0, 2 * MAX_INPUT)
                    : restoreDraftText(saved.draft?.text || "", message);
            saved.draft = {
                ...(message.draftSnapshot || saved.draft),
                text,
                selectionStart: text.length,
                selectionEnd: text.length,
            };
            retainView(message.conversationKey, saved);
        } else if (message.type === "sendResult" && saved.submission === message.requestId) {
            saved.submission = null;
            retainView(message.conversationKey, saved);
        }
    }

    function isActive(status = state.status) {
        return ["busy", "retrying", "compacting"].includes(status);
    }

    function send(message) {
        if (state.conversationKey) {
            saveDraft();
            vscode.postMessage({ ...message, conversationKey: state.conversationKey });
        } else {
            vscode.postMessage(message);
        }
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }

        if (text !== undefined) {
            node.textContent = String(text);
        }

        return node;
    }

    function announce(text) {
        byId("announcer").textContent = text;
    }

    function imageKey(value) {
        return value?.mediaId
            ? [value.mediaId, mediaCache.has(value.mediaId), value.name, value.label]
            : [value?.data, value?.mimeType, value?.width, value?.height, value?.name];
    }

    function hydrateMedia(message) {
        const retained = Array.isArray(message.retainedMediaIds)
            ? new Set(message.retainedMediaIds.slice(0, 40))
            : null;
        if (retained) {
            for (const id of mediaCache.keys()) {
                if (!retained.has(id)) {
                    mediaCache.delete(id);
                }
            }
        }

        let totalBytes = Array.from(mediaCache.values()).reduce((total, value) => total + value.bytes, 0);
        for (const value of Array.isArray(message.media) ? message.media.slice(0, 40) : []) {
            if (
                !value ||
                typeof value.id !== "string" ||
                value.id.length > 256 ||
                (retained && !retained.has(value.id))
            ) {
                continue;
            }

            const source = imageSource(value);
            const bytes = source
                ? (value.data.length * 3) / 4 - (value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0)
                : 0;
            const existing = mediaCache.get(value.id);
            if (
                !source ||
                (!existing && mediaCache.size >= 40) ||
                totalBytes - (existing?.bytes || 0) + bytes > 40 * 1024 * 1024
            ) {
                continue;
            }

            totalBytes += bytes - (existing?.bytes || 0);
            mediaCache.set(value.id, { image: value, source, bytes });
        }

        const hydrate = (value) => {
            const entry = value?.mediaId && mediaCache.get(value.mediaId);
            if (!entry || value.data) {
                return value;
            }

            return { ...entry.image, ...value, data: entry.image.data };
        };

        return {
            ...message.state,
            attachments: Array.isArray(message.state.attachments) ? message.state.attachments.map(hydrate) : [],
            messages: Array.isArray(message.state.messages)
                ? message.state.messages.map((value) =>
                      value && Array.isArray(value.images) ? { ...value, images: value.images.map(hydrate) } : value,
                  )
                : [],
        };
    }

    function imageSourceFor(value) {
        return value?.mediaId ? mediaCache.get(value.mediaId)?.source || imageSource(value) : imageSource(value);
    }

    function imageName(value, fallback = "Image") {
        return String(value?.name || value?.label || fallback);
    }

    function showImageFeedback(text, isError = false) {
        imageFeedback = text;
        imageFeedbackError = isError;
        updateImageFeedback();
    }

    function updateImageFeedback() {
        const pending = readingImages || pendingUploads.size > 0;
        const text = pending ? "Adding attachments…" : imageFeedback;
        byId("image-feedback").hidden = !text;
        byId("image-feedback").classList.toggle("is-error", !pending && imageFeedbackError);
        if (byId("image-feedback-text").textContent !== text) {
            byId("image-feedback-text").textContent = text;
        }

        byId("image-feedback-dismiss").hidden = pending;
        updateComposer();
    }

    function closeImagePreview() {
        if (byId("image-preview").open) {
            byId("image-preview").close();
        }
    }

    function openImagePreview(value, sourceButton, label) {
        if (state.uiRequest) {
            announce("Respond to Pi's request before opening an image preview.");
            byId("ui-request-title")?.focus();

            return;
        }

        const source = imageSourceFor(value);
        if (!source) {
            showImageFeedback(
                "This image cannot be displayed. PNG, JPEG, WebP, and GIF images up to 5 MiB are supported.",
                true,
            );

            return;
        }

        previewReturnFocus = sourceButton || document.activeElement;
        const name = label || imageName(value);
        byId("image-preview-title").textContent = name;
        const img = element("img");
        img.alt = name;
        img.src = source;
        img.addEventListener(
            "error",
            () => {
                if (img.parentElement === byId("image-preview-content")) {
                    byId("image-preview-content").replaceChildren(
                        element("p", "image-unavailable", "The image could not be decoded."),
                    );
                }
            },
            { once: true },
        );
        byId("image-preview-content").replaceChildren(img);
        const size = Number(value.byteLength);
        byId("image-preview-meta").textContent =
            `${value.width} × ${value.height}${Number.isFinite(size) && size > 0 ? ` · ${Math.max(1, Math.round(size / 1024))} KiB` : ""}`;
        if (!byId("image-preview").open) {
            byId("image-preview").showModal();
        }

        byId("image-preview-close").focus();
    }

    function imageThumbnail(value, label = imageName(value)) {
        const source = imageSourceFor(value);
        if (!source) {
            return element("span", "image-unavailable", `${label} · Preview unavailable`);
        }

        const button = element("button", "image-thumbnail");
        button.type = "button";
        button.title = `${label} · Click to enlarge`;
        button.setAttribute("aria-label", `Preview image ${label}`);
        const img = element("img");
        img.alt = label;
        img.loading = "lazy";
        img.decoding = "async";
        img.src = source;
        img.addEventListener(
            "load",
            () => {
                if (followScroll) {
                    window.requestAnimationFrame(updateScroll);
                }
            },
            { once: true },
        );
        img.addEventListener(
            "error",
            () => {
                button.replaceChildren(element("span", "image-unavailable", "Preview unavailable"));
            },
            { once: true },
        );
        button.append(img);
        button.addEventListener("click", () => openImagePreview(value, button, label));

        return button;
    }

    function imageGallery(values, existing) {
        const images = Array.isArray(values) ? values.filter(Boolean).slice(0, MAX_IMAGE_COUNT) : [];
        if (!images.length) {
            return null;
        }

        const signature = JSON.stringify(images.map(imageKey));
        if (existing?.imageSignature === signature) {
            return existing;
        }

        const gallery = element("div", "message-images");
        gallery.imageSignature = signature;
        images.forEach((value, index) => gallery.append(imageThumbnail(value, imageName(value, `Image ${index + 1}`))));

        return gallery;
    }

    function requestImagePreview(reference, label, button) {
        if (state.uiRequest) {
            announce("Respond to Pi's request before opening an image preview.");
            byId("ui-request-title")?.focus();

            return;
        }

        const requestId = `image-preview-${++imageSequence}`;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = "Loading image…";
        const timeout = window.setTimeout(() => {
            if (pendingImagePreviews.delete(requestId)) {
                button.disabled = false;
                button.textContent = originalText;
                showImageFeedback("Image preview did not respond. Try opening the image again.", true);
            }
        }, 30000);
        pendingImagePreviews.set(requestId, { button, label, originalText, timeout });
        send({ type: "previewImage", reference, requestId, contextToken: state.contextToken });
    }

    function beginUpload(type, payload) {
        const requestId = `image-upload-${++imageSequence}`;
        const timeout = window.setTimeout(() => {
            if (pendingUploads.delete(requestId)) {
                showImageFeedback(
                    "Attachment upload did not respond. Check the attachment strip before trying again.",
                    true,
                );
            }
        }, 30000);
        pendingUploads.set(requestId, timeout);
        send({ type, requestId, ...payload });
        updateImageFeedback();
    }

    async function attachImageFiles(values) {
        const files = Array.from(values || []);
        if (!files.length) {
            return;
        }

        if (readingImages || pendingUploads.size || submission || state.sending) {
            announce("Wait for the current image attachment to finish.");

            return;
        }

        const existing = state.attachments.filter((value) => value?.kind === "image");
        const totalBytes = files.reduce((total, file) => total + file.size, 0);
        const existingBytes = existing.reduce(
            (total, value) => total + (Number(value.byteLength) || Math.floor(((value.data?.length || 0) * 3) / 4)),
            0,
        );
        if (files.length > MAX_IMAGE_COUNT || files.length + state.attachments.length > MAX_IMAGE_COUNT) {
            showImageFeedback("Attach up to 8 files or images at a time. Remove an attachment first.", true);

            return;
        }

        if (files.some((file) => !IMAGE_MIMES.has(file.type))) {
            showImageFeedback(
                "Choose PNG, JPEG, WebP, or GIF images. SVG and other file types cannot be pasted as images.",
                true,
            );

            return;
        }

        if (files.some((file) => !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES)) {
            showImageFeedback("Each image must be nonempty and no larger than 5 MiB.", true);

            return;
        }

        if (totalBytes + existingBytes > MAX_IMAGE_BATCH_BYTES) {
            showImageFeedback(
                "Image attachments must total no more than 20 MiB. Remove an image or use smaller files.",
                true,
            );

            return;
        }

        const contextToken = state.contextToken;
        readingImages = true;
        imageFeedback = "";
        updateImageFeedback();
        try {
            const images = await Promise.all(
                files.map(
                    (file) =>
                        new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.addEventListener(
                                "load",
                                () => {
                                    if (state.contextToken !== contextToken) {
                                        reject(
                                            new Error(
                                                "The conversation changed. Attach the image again to the current conversation.",
                                            ),
                                        );

                                        return;
                                    }

                                    const result = typeof reader.result === "string" ? reader.result : "";
                                    const marker = result.indexOf(";base64,");
                                    if (marker < 0) {
                                        reject(new Error("An image could not be read. Try attaching it from a file."));

                                        return;
                                    }

                                    resolve({
                                        data: result.slice(marker + 8),
                                        mimeType: file.type,
                                        name: String(file.name || "Pasted image").slice(0, 255),
                                    });
                                },
                                { once: true },
                            );
                            reader.addEventListener(
                                "error",
                                () => reject(new Error("An image could not be read. Try attaching it from a file.")),
                                { once: true },
                            );
                            reader.addEventListener(
                                "abort",
                                () => reject(new Error("Image attachment was cancelled.")),
                                { once: true },
                            );
                            reader.readAsDataURL(file);
                        }),
                ),
            );
            if (state.contextToken !== contextToken) {
                throw new Error("The conversation changed. Attach the image again to the current conversation.");
            }

            beginUpload("attachImageData", { images, contextToken });
        } catch (error) {
            showImageFeedback(error instanceof Error ? error.message : "The image could not be attached.", true);
        } finally {
            readingImages = false;
            updateImageFeedback();
        }
    }

    function closeAttachMenu(returnFocus = false) {
        byId("attach-menu").hidden = true;
        byId("attach-menu-button").setAttribute("aria-expanded", "false");
        if (returnFocus) {
            byId("attach-menu-button").focus();
        }
    }

    function toggleAttachMenu() {
        const open = byId("attach-menu").hidden;
        byId("attach-menu").hidden = !open;
        byId("attach-menu-button").setAttribute("aria-expanded", String(open));
        if (open) {
            hideSlashMenu();
            byId("attach-file").focus();
        }
    }

    function handleImageDrop(event) {
        const transfer = event.dataTransfer;
        if (!transfer) {
            return;
        }

        if (readingImages || pendingUploads.size || submission || state.sending) {
            event.preventDefault();
            announce("Wait for the current attachment or message to finish sending.");

            return;
        }

        const files = Array.from(transfer.files || []);
        const imageFiles = files.filter((file) => file.type.startsWith("image/"));
        const internalUriList = transfer.getData("application/vnd.code.uri-list");
        const resourceUrls = internalUriList ? "" : transfer.getData("ResourceURLs");
        const uriList = internalUriList || (resourceUrls ? "" : transfer.getData("text/uri-list"));
        dragDepth = 0;
        byId("image-drop-target").hidden = true;
        if (uriList || resourceUrls) {
            event.preventDefault();
            if (uriList.length > 65536 || resourceUrls.length > 65536) {
                showImageFeedback("The dropped file list is too large. Drop up to 8 local workspace files.", true);

                return;
            }

            let uris;
            try {
                uris = resourceUrls
                    ? JSON.parse(resourceUrls)
                    : uriList
                          .split(/\r?\n/u)
                          .map((value) => value.trim())
                          .filter((value) => value && !value.startsWith("#"));
            } catch {
                showImageFeedback(
                    "The dropped file list could not be read. Try attaching the workspace files again.",
                    true,
                );

                return;
            }

            if (
                !Array.isArray(uris) ||
                uris.length > MAX_IMAGE_COUNT ||
                uris.some(
                    (value) =>
                        typeof value !== "string" ||
                        value.length > 8192 ||
                        !/^file:\/\//iu.test(value) ||
                        /[\u0000-\u001f\u007f]/u.test(value),
                )
            ) {
                showImageFeedback("Drop up to 8 local workspace files. Remote URLs are not read as attachments.", true);

                return;
            }

            if (uris.length) {
                beginUpload("attachDroppedFiles", { uris, contextToken: state.contextToken });
            }
        } else if (imageFiles.length) {
            event.preventDefault();
            void attachImageFiles(imageFiles);
        } else if (files.length) {
            event.preventDefault();
            showImageFeedback(
                "Use Attach → Workspace file for this file, or drop a PNG, JPEG, WebP, or GIF image.",
                true,
            );
        }
    }

    function copyButton(text, className, label = "Copy") {
        const button = element("button", className, label);
        button.type = "button";
        button.setAttribute(
            "aria-label",
            label === "Copy code" ? "Copy code to clipboard" : "Copy message to clipboard",
        );
        button.addEventListener("click", () => {
            const requestId = `copy-${++copySequence}`;
            const timeout = window.setTimeout(() => pendingCopies.delete(requestId), 10000);
            pendingCopies.set(requestId, { button, label, timeout });
            send({ type: "copy", text, requestId });
        });

        return button;
    }

    function renderInline(parent, text) {
        for (const token of inlineTokens(text)) {
            if (token.type === "text") {
                parent.append(document.createTextNode(token.text));
            } else if (token.type === "link") {
                const link = element("button", "markdown-link", token.text);
                link.type = "button";
                link.title = token.href;
                link.setAttribute("role", "link");
                link.addEventListener("click", () => send({ type: "openLink", url: token.href }));
                parent.append(link);
            } else if (token.type === "codeLink") {
                const link = element("button", "markdown-link code-reference", token.text);
                link.type = "button";
                link.title = `Open ${token.reference} in editor`;
                link.setAttribute("role", "link");
                link.addEventListener("click", () => send({ type: "openCode", reference: token.reference }));
                parent.append(link);
            } else if (token.type === "imagePreview") {
                const button = element("button", "image-preview-action", `Preview image: ${token.text}`);
                button.type = "button";
                button.title = `Read and preview ${token.reference}`;
                button.addEventListener("click", () => requestImagePreview(token.reference, token.text, button));
                parent.append(button);
            } else if (token.type === "externalImage") {
                const button = element("button", "external-image-action", `Open image: ${token.text}`);
                button.type = "button";
                button.title = `Open in your browser: ${token.href}`;
                button.setAttribute("role", "link");
                button.addEventListener("click", () => send({ type: "openLink", url: token.href }));
                parent.append(button);
            } else {
                const tag = { code: "code", strong: "strong", emphasis: "em", strike: "s" }[token.type];
                parent.append(element(tag, "", token.text));
            }
        }
    }

    function renderMarkdown(text) {
        const container = element("div", "markdown");
        for (const block of parseMarkdown(text)) {
            if (block.type === "code") {
                const wrapper = element("div", "code-block");
                const header = element("div", "code-header");
                header.append(element("span", "code-language", block.language || "Code"));
                header.append(copyButton(block.text, "code-copy", "Copy code"));
                const pre = element("pre");
                pre.append(element("code", "", block.text));
                wrapper.append(header, pre);
                container.append(wrapper);
            } else if (block.type === "list") {
                const list = element(block.ordered ? "ol" : "ul");
                if (block.items.every((item) => item.checked !== null)) {
                    list.className = "task-list";
                }

                for (const item of block.items) {
                    const li = element("li");
                    if (item.checked !== null) {
                        const check = element("span", "task-checkbox", item.checked ? "☑" : "☐");
                        check.setAttribute("aria-label", item.checked ? "Completed:" : "Not completed:");
                        li.append(check);
                    }

                    renderInline(li, item.text);
                    list.append(li);
                }

                container.append(list);
            } else if (block.type === "table") {
                const wrapper = element("div", "markdown-table");
                const table = element("table");
                const thead = element("thead");
                const row = element("tr");
                for (const text of block.headers) {
                    const cell = element("th");
                    cell.scope = "col";
                    renderInline(cell, text);
                    row.append(cell);
                }

                thead.append(row);
                table.append(thead);
                const tbody = element("tbody");
                for (const values of block.rows) {
                    const bodyRow = element("tr");
                    for (let index = 0; index < block.headers.length; index += 1) {
                        const cell = element("td");
                        renderInline(cell, values[index] ?? "");
                        bodyRow.append(cell);
                    }

                    tbody.append(bodyRow);
                }

                table.append(tbody);
                wrapper.append(table);
                container.append(wrapper);
            } else if (block.type === "rule") {
                container.append(element("hr"));
            } else {
                const tag =
                    block.type === "heading"
                        ? `h${Math.min(block.level + 1, 6)}`
                        : block.type === "quote"
                          ? "blockquote"
                          : "p";
                const node = element(tag);
                renderInline(node, block.text);
                container.append(node);
            }
        }

        return container;
    }

    function renderMessage(message, existing) {
        const role = ["user", "assistant", "tool", "notice"].includes(message.role) ? message.role : "notice";
        const article = existing || element("article");
        const gallery = imageGallery(message.images, article.querySelector(".message-images"));
        const thinkingOpen = article.querySelector('details[data-section="thinking"]')?.open ?? true;
        const expanded = new Set(
            Array.from(article.querySelectorAll("details[open]")).map((detail) => detail.dataset.section),
        );
        article.className = `message message-${role}${message.isError ? " message-is-error" : ""}`;
        article.replaceChildren();
        if (role === "tool") {
            const details = element("details", `tool-card${message.isError ? " is-error" : ""}`);
            details.dataset.section = "tool";
            details.open = expanded.has("tool");
            const summary = element("summary");
            summary.append(element("span", "tool-name", message.toolName || "Tool"));
            summary.append(
                element(
                    "span",
                    "tool-state",
                    message.isRunning ? "Running…" : message.isError ? "Failed" : "Completed",
                ),
            );
            details.append(summary);
            if (message.input) {
                details.append(
                    element("div", "tool-section-label", "Input"),
                    element("pre", "tool-input", message.input),
                );
                details.append(element("div", "tool-section-label", "Result"));
            }

            details.append(
                element(
                    "pre",
                    "tool-output",
                    message.text || (message.isRunning ? "Waiting for output…" : "No output"),
                ),
            );
            if (gallery) {
                if (!message.text) {
                    details.querySelector(".tool-output").hidden = true;
                }

                details.append(gallery);
            }

            article.append(details);

            return article;
        }

        if (role !== "notice") {
            const header = element("div", "message-header");
            const avatar = element("span", "message-avatar", role === "user" ? "Y" : "π");
            avatar.setAttribute("aria-hidden", "true");
            header.append(avatar, element("span", "message-author", role === "user" ? "You" : "SpecPi"));
            if (message.text) {
                header.append(copyButton(String(message.text), "message-copy"));
            }

            article.append(header);
        }

        if (message.thinking) {
            const details = element("details", "reasoning");
            details.dataset.section = "thinking";
            details.open = thinkingOpen;
            details.append(element("summary", "", message.isRunning ? "Thinking…" : "Thinking"));
            const content = element("div", "reasoning-content");
            content.append(renderMarkdown(message.thinking));
            details.append(content);
            article.append(details);
        }

        const body = element("div", "message-body");
        if (role === "assistant") {
            body.append(renderMarkdown(message.text || ""));
        } else {
            body.textContent = String(message.text || "");
        }

        article.append(body);
        if (gallery) {
            body.hidden = !message.text;
            article.append(gallery);
        }

        return article;
    }

    function renderMessages() {
        const currentIds = new Set();
        const nodes = [];
        state.messages.forEach((message, index) => {
            if (!message || typeof message !== "object") {
                return;
            }

            const id = String(message.id ?? index);
            currentIds.add(id);
            const signature = JSON.stringify([
                message.role,
                message.text,
                message.thinking,
                message.toolName,
                message.input,
                message.isError,
                message.isRunning,
                Array.isArray(message.images) ? message.images.map(imageKey) : [],
            ]);
            let record = messageCache.get(id);
            if (!record || record.signature !== signature) {
                const node = renderMessage(message, record?.node);
                node.dataset.messageId = id;
                record = { signature, node };
                messageCache.set(id, record);
            }

            nodes.push(record.node);
        });
        for (const id of messageCache.keys()) {
            if (!currentIds.has(id)) {
                messageCache.delete(id);
            }
        }

        const existing = Array.from(conversation.children);
        if (nodes.length !== existing.length || nodes.some((node, index) => node !== existing[index])) {
            conversation.replaceChildren(...nodes);
        }

        const lastAssistant = state.messages.findLast((message) => message?.role === "assistant" && message.text);
        if (!isActive() && lastAssistant && lastAssistant.id !== lastAnnouncedMessage) {
            lastAnnouncedMessage = lastAssistant.id;
            announce(`Pi replied. ${String(lastAssistant.text).slice(0, 300)}`);
        }

        byId("welcome").hidden = nodes.length > 0;
    }

    function modelValue(model) {
        return JSON.stringify([String(model?.provider || ""), String(model?.id || "")]);
    }

    function renderModels() {
        const select = byId("model-select");
        const models = state.models.filter((model) => model && model.id && model.provider);
        const signature = JSON.stringify([models, state.model]);
        if (signature !== modelSignature) {
            modelSignature = signature;
            select.replaceChildren();
            if (state.model?.id && !models.some((model) => modelValue(model) === modelValue(state.model))) {
                models.unshift(state.model);
            }

            if (!models.length) {
                const option = element("option", "", "Default model");
                option.value = "";
                select.append(option);
            }

            for (const model of models) {
                const option = element("option", "", model.name || model.id);
                option.value = modelValue(model);
                option.title = `${model.provider} / ${model.id}`;
                select.append(option);
            }
        }

        if (state.model?.id) {
            select.value = modelValue(state.model);
            select.title = `${state.model.name || state.model.id} · ${state.model.provider || "Pi"}`;
        }

        select.disabled = state.status !== "ready" || !state.models.length;
        const thinking = byId("thinking-select");
        const levels = Array.isArray(state.thinkingLevels) ? state.thinkingLevels : ["off"];
        const validLevels = levels.filter((level) =>
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
        );
        const levelsSignature = JSON.stringify(validLevels);
        if (levelsSignature !== thinkingSignature) {
            thinkingSignature = levelsSignature;
            thinking.replaceChildren();
            const labels = {
                off: "Thinking off",
                minimal: "Minimal",
                low: "Low",
                medium: "Medium",
                high: "High",
                xhigh: "Extra high",
                max: "Max",
            };
            for (const level of validLevels.length ? validLevels : ["off"]) {
                const option = element("option", "", labels[level]);
                option.value = level;
                thinking.append(option);
            }
        }

        thinking.value = state.thinkingLevel || "off";
        thinking.disabled = state.status !== "ready" || validLevels.length < 2;
        thinking.title = `Thinking level: ${state.thinkingLevel || "off"}`;
    }

    function renderAttachments() {
        const container = byId("attachments");
        const signature = JSON.stringify(
            state.attachments.map((value) => [value?.id, value?.label, value?.detail, value?.kind, imageKey(value)]),
        );
        if (signature === attachmentSignature) {
            return;
        }

        attachmentSignature = signature;
        container.replaceChildren();
        container.classList.toggle(
            "has-images",
            state.attachments.some((value) => value?.kind === "image"),
        );
        for (const attachment of state.attachments) {
            if (!attachment || !attachment.id) {
                continue;
            }

            const chip = element("div", attachment.kind === "image" ? "attachment attachment-image" : "attachment");
            chip.title = attachment.detail || attachment.label || "Attached context";
            if (attachment.kind === "image") {
                chip.append(imageThumbnail(attachment, attachment.label || "Attached image"));
            }

            chip.append(element("span", "attachment-label", attachment.label || "Context"));
            const remove = element("button", "attachment-remove", "×");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove ${attachment.label || "attachment"}`);
            remove.addEventListener("click", () => send({ type: "removeAttachment", id: attachment.id }));
            chip.append(remove);
            container.append(chip);
        }

        container.hidden = !container.childElementCount;
    }

    function renderRuntimeStatus() {
        const entries = Object.entries(state.runtimeStatus || {}).filter(([, value]) => typeof value === "string");
        const signature = JSON.stringify(entries);
        if (signature === runtimeSignature) {
            return;
        }

        runtimeSignature = signature;
        const container = byId("runtime-values");
        container.replaceChildren();
        for (const [key, value] of entries) {
            const plainValue = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
            container.append(element("dt", "", key), element("dd", "", plainValue));
        }

        byId("runtime-details").hidden = !entries.length;
        byId("runtime-count").textContent = String(entries.length);
    }

    function respondToRequest(response) {
        if (!state.uiRequest?.id || requestAnswered) {
            return;
        }

        requestAnswered = true;
        send({ type: "uiResponse", id: state.uiRequest.id, ...response });
        for (const control of byId("ui-request").querySelectorAll("button, input, textarea")) {
            control.disabled = true;
        }

        announce("Response sent to Pi");
    }

    function renderRequest() {
        const container = byId("ui-request");
        const request = state.uiRequest;
        const signature = JSON.stringify(request || null);
        if (signature === requestSignature) {
            return;
        }

        const hadRequest = !container.hidden;
        requestSignature = signature;
        requestAnswered = false;
        container.replaceChildren();
        container.hidden = !request;
        if (!request) {
            if (hadRequest) {
                input.focus();
            }

            return;
        }

        const title = element("h2", "", request.title || "Pi needs your input");
        title.id = "ui-request-title";
        title.tabIndex = -1;
        container.append(title);
        if (request.message) {
            container.append(element("pre", "request-message", request.message));
        }

        const actions = element("div", "request-actions");
        const cancel = element("button", "text-button", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => respondToRequest({ cancelled: true }));
        if (request.method === "select") {
            const options = element("div", "request-options");
            for (const value of Array.isArray(request.options) ? request.options : []) {
                const option = element("button", "request-option", value);
                option.type = "button";
                option.addEventListener("click", () => respondToRequest({ value }));
                options.append(option);
            }

            container.append(options);
        } else if (request.method === "confirm") {
            const confirm = element("button", "primary-button", "Confirm");
            confirm.type = "button";
            confirm.addEventListener("click", () => respondToRequest({ confirmed: true }));
            actions.append(confirm);
        } else if (request.method === "input" || request.method === "editor") {
            const field = element(request.method === "editor" ? "textarea" : "input", "request-input");
            field.id = "request-input";
            field.setAttribute("aria-label", request.title || "Response to Pi");
            field.placeholder = request.placeholder || "";
            field.value = request.prefill || "";
            field.maxLength = MAX_INPUT;
            if (request.method === "input") {
                field.type = "text";
            }

            const submit = element("button", "primary-button", "Submit");
            submit.type = "button";
            submit.addEventListener("click", () => respondToRequest({ value: field.value }));
            field.addEventListener("keydown", (event) => {
                if (
                    event.key === "Enter" &&
                    !event.isComposing &&
                    (request.method === "input" || event.ctrlKey || event.metaKey)
                ) {
                    event.preventDefault();
                    respondToRequest({ value: field.value });
                }
            });
            container.append(field);
            actions.append(submit);
        }

        actions.append(cancel);
        container.append(actions);
        title.focus();
        announce(`${request.title || "Pi needs your input"}. Review the request and choose a response.`);
    }

    function resizeComposer() {
        input.style.height = "auto";
        const maximum = window.innerHeight <= 580 ? 120 : 180;
        input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
    }

    function updateComposer() {
        const busy = isActive();
        const connected = state.status === "ready" || busy;
        const tooLong = input.value.length > MAX_INPUT;
        const hasImages = state.attachments.some((value) => value?.kind === "image");
        const lacksVision = hasImages && Array.isArray(state.model?.input) && !state.model.input.includes("image");
        const pending = readingImages || pendingUploads.size > 0 || Boolean(submission) || Boolean(state.sending);
        byId("send-button").disabled =
            (!input.value.trim() && !hasImages) ||
            state.status === "connecting" ||
            Boolean(state.uiRequest) ||
            tooLong ||
            lacksVision ||
            pending;
        byId("vision-warning").hidden = !lacksVision;
        byId("vision-warning").textContent = lacksVision
            ? "This model does not accept images. Choose an image-capable model or remove the images to send."
            : "";
        for (const id of [
            "attach-menu-button",
            "attach-selection",
            "attach-file",
            "attach-image",
            "attach-selection-menu",
        ]) {
            byId(id).disabled = pending;
        }

        for (const button of byId("attachments").querySelectorAll(".attachment-remove")) {
            button.disabled = Boolean(submission) || Boolean(state.sending);
        }

        const label = busy
            ? byId("send-mode").value === "followUp"
                ? "Queue follow-up"
                : "Steer Pi"
            : connected
              ? "Send message"
              : "Connect and send message";
        byId("send-button").title = label;
        byId("send-button").setAttribute("aria-label", label);
        byId("send-label").textContent = label;
        byId("stop-button").hidden = !busy;
        byId("send-mode").hidden = !busy;
        byId("runtime-status").hidden = busy;
        byId("composer-details").hidden = !tooLong;
        byId("composer-hint").textContent = tooLong
            ? "Message exceeds 65,536 characters; shorten it to send"
            : state.status === "connecting"
              ? "Waiting for Pi to connect"
              : state.uiRequest
                ? "Pi is waiting for your response above"
                : busy
                  ? byId("send-mode").value === "followUp"
                      ? "Send after Pi finishes"
                      : "Guide Pi after the current tool"
                  : "Enter to send · Shift+Enter for a new line";
        input.setAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter");
        input.setAttribute("aria-invalid", String(tooLong));
    }

    function hideSlashMenu() {
        byId("slash-menu").hidden = true;
        input.removeAttribute("aria-activedescendant");
        input.removeAttribute("aria-controls");
        input.removeAttribute("aria-expanded");
        slashItems = [];
    }

    function chooseSlashCommand(command) {
        const name = String(command.name).replace(/^\//, "");
        input.value = `/${name} `;
        hideSlashMenu();
        input.focus();
        resizeComposer();
        updateComposer();
    }

    function renderSlashMenu() {
        const value = input.value;
        if (state.uiRequest || !/^\/[^\s]*$/.test(value) || value === dismissedSlash) {
            hideSlashMenu();

            return;
        }

        const query = value.slice(1).toLowerCase();
        const commands = [
            ...LOCAL_COMMANDS,
            ...state.commands.filter(
                (command) =>
                    !LOCAL_COMMANDS.some((local) => local.name === String(command?.name || "").replace(/^\//, "")),
            ),
        ];
        slashItems = commands
            .filter((command) => command?.name && String(command.name).replace(/^\//, "").toLowerCase().includes(query))
            .slice(0, 30);
        const menu = byId("slash-menu");
        menu.replaceChildren();
        menu.hidden = !slashItems.length;
        slashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1));
        slashItems.forEach((command, index) => {
            const button = element("button", "slash-option");
            button.type = "button";
            button.id = `slash-option-${index}`;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", String(index === slashIndex));
            button.tabIndex = -1;
            button.append(element("span", "slash-name", `/${String(command.name).replace(/^\//, "")}`));
            if (command.description) {
                button.append(element("span", "slash-description", command.description));
            }

            button.addEventListener("mousedown", (event) => event.preventDefault());
            button.addEventListener("click", () => chooseSlashCommand(command));
            menu.append(button);
        });
        if (slashItems.length) {
            input.setAttribute("aria-controls", "slash-menu");
            input.setAttribute("aria-expanded", "true");
            input.setAttribute("aria-activedescendant", `slash-option-${slashIndex}`);
        }
    }

    function submitMessage() {
        const text = input.value.trim();
        updateComposer();
        if (byId("send-button").disabled) {
            return;
        }

        const mode = isActive() ? byId("send-mode").value : "prompt";
        submission = `chat-send-${++imageSequence}`;
        send({ type: "send", text, mode, requestId: submission });
        input.value = "";
        saveDraft();
        dismissedSlash = "";
        hideSlashMenu();
        resizeComposer();
        updateComposer();
        followScroll = true;
        byId("jump-to-latest").hidden = true;
        input.focus();
    }

    function updateScroll() {
        if (followScroll) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
        }

        byId("jump-to-latest").hidden =
            followScroll || scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 50;
    }

    function formatTokens(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
            return "";
        }

        return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(Math.round(number));
    }

    function formatCost(value) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            return "";
        }

        if (value > 0 && value < 0.0001) {
            return "<$0.0001";
        }

        if (value >= 1e12) {
            return `$${value.toExponential(2)}`;
        }

        if (value >= 1000) {
            return `$${value.toLocaleString("en-US", { notation: "compact", maximumSignificantDigits: 4 })}`;
        }

        return `$${value.toFixed(4)}`;
    }

    function renderState(next) {
        const switched = Boolean(next.conversationKey && state.conversationKey !== next.conversationKey);
        if (switched) {
            rememberView();
        }

        if (state.contextToken !== next.contextToken || (next.uiRequest && next.uiRequest.id !== state.uiRequest?.id)) {
            for (const pending of pendingImagePreviews.values()) {
                window.clearTimeout(pending.timeout);
                pending.button.disabled = false;
                pending.button.textContent = pending.originalText;
            }

            pendingImagePreviews.clear();
            closeImagePreview();
        }

        if (state.contextToken !== next.contextToken && pendingUploads.size) {
            for (const timeout of pendingUploads.values()) {
                window.clearTimeout(timeout);
            }

            pendingUploads.clear();
            imageFeedback = "The conversation changed. Check the current attachments before adding images again.";
            imageFeedbackError = false;
        }

        const restoredScroll = switched ? restoreView(next) : undefined;
        state = {
            ...next,
            status: ["disconnected", "connecting", "ready", "busy", "retrying", "compacting", "error"].includes(
                next.status,
            )
                ? next.status
                : "disconnected",
            messages: Array.isArray(next.messages) ? next.messages : [],
            models: Array.isArray(next.models) ? next.models : [],
            attachments: Array.isArray(next.attachments) ? next.attachments : [],
            commands: Array.isArray(next.commands) ? next.commands : [],
        };
        const busy = isActive();
        const connected = state.status === "ready" || busy;
        const labels = {
            disconnected: "Offline",
            connecting: "Connecting",
            ready: "Connected",
            busy: "Working",
            retrying: "Retrying",
            compacting: "Compacting",
            error: "Connection issue",
        };
        byId("workspace-name").textContent =
            typeof state.workspace === "string" ? state.workspace : state.workspace?.name || "No workspace";
        byId("workspace-name").title =
            typeof state.workspace === "string" ? state.workspace : state.workspace?.path || "Choose workspace";
        byId("session-title").textContent = state.title || "New conversation";
        byId("session-title").title = state.title || "New conversation";
        byId("connection-label").textContent = labels[state.status];
        byId("connection-button").dataset.status = state.status;
        byId("connection-button").disabled = connected || state.status === "connecting";
        byId("connection-button").title = connected ? "Connected to your local Pi process" : "Connect to Pi";
        byId("connection-banner").hidden = state.status !== "connecting";
        const connectionMessage =
            state.status === "connecting"
                ? state.connectionMessage ||
                  "Starting your local Pi process and waiting for its extensions to finish loading…"
                : "";
        if (byId("connection-message").textContent !== connectionMessage) {
            byId("connection-message").textContent = connectionMessage;
        }

        byId("connect-button").hidden = connected || state.status === "connecting";
        byId("connect-button").disabled = state.status === "connecting";
        byId("connect-button").textContent =
            state.status === "connecting"
                ? "Connecting to Pi…"
                : state.status === "error"
                  ? "Reconnect to Pi"
                  : "Connect to Pi";
        byId("connect-note").textContent = connected
            ? "Connected to local Pi. Choose a starting point or write a message below."
            : "Uses your local Pi installation and configured model provider.";
        byId("activity").hidden = !busy;
        byId("activity-label").textContent = state.uiRequest
            ? "Waiting for your response"
            : state.status === "retrying"
              ? "Pi is retrying the request"
              : state.status === "compacting"
                ? "Pi is compacting context"
                : "Pi is working";
        byId("queue-notice").hidden = !(Number(state.queueCount) > 0);
        byId("queue-notice").textContent =
            `${Number(state.queueCount) || 0} message${Number(state.queueCount) === 1 ? "" : "s"} queued`;
        const error = typeof state.error === "string" ? state.error : state.error?.message || "";
        byId("error-banner").hidden = !error;
        if (byId("error-message").textContent !== error) {
            byId("error-message").textContent = error;
        }

        byId("error-retry").textContent = connected ? "Refresh status" : "Reconnect";
        byId("error-retry").hidden = busy || state.status === "connecting";
        byId("new-chat").disabled = false;
        byId("history-button").disabled = false;
        byId("choose-workspace").disabled = false;
        byId("runtime-status").textContent = state.uiRequest
            ? "Your input is needed"
            : busy
              ? "Running in your workspace"
              : connected
                ? "Ready when you are"
                : state.status === "connecting"
                  ? "Starting the local Pi process…"
                  : "Connect when you're ready";
        const tokens =
            typeof state.tokens === "number" ? state.tokens : (state.tokens?.total ?? state.tokens?.totalTokens);
        const percent = state.contextUsage?.percent;
        const cost = formatCost(state.cost);
        const contextLabel =
            typeof percent === "number" && Number.isFinite(percent)
                ? `${Math.round(percent)}%${cost ? "" : " context"}`
                : typeof tokens === "number"
                  ? `${formatTokens(tokens)}${cost ? "" : " tokens"}`
                  : "";
        byId("token-status").textContent = [contextLabel, cost].filter(Boolean).join(" · ");
        const usageDetails = [];
        if (typeof tokens === "number") {
            usageDetails.push(`Total: ${tokens.toLocaleString()} tokens`);
        }

        for (const [key, label] of [
            ["input", "Input"],
            ["output", "Output"],
            ["cacheRead", "Cache read"],
            ["cacheWrite", "Cache write"],
        ]) {
            if (typeof state.tokens?.[key] === "number") {
                usageDetails.push(`${label}: ${state.tokens[key].toLocaleString()}`);
            }
        }

        if (cost) {
            usageDetails.push(
                `Pi-reported conversation cost (USD): $${state.cost.toLocaleString("en-US", { maximumSignificantDigits: 15 })}`,
            );
        }

        usageDetails.push(
            typeof percent === "number" && Number.isFinite(percent)
                ? `Context: ${Math.round(percent)}%${typeof state.contextUsage.tokens === "number" ? ` · ${state.contextUsage.tokens.toLocaleString()} / ${state.contextUsage.contextWindow?.toLocaleString() || "unknown"} tokens` : ""}`
                : "Context usage is unknown until the next model response.",
        );
        byId("token-status").title = usageDetails.join("\n");
        byId("token-status").setAttribute("aria-label", `Session usage details. ${usageDetails.join(". ")}`);
        if (busy && !busySince) {
            busySince = Date.now();
        } else if (!busy) {
            busySince = null;
            byId("activity-elapsed").textContent = "";
        }

        renderMessages();
        renderModels();
        renderAttachments();
        renderRuntimeStatus();
        renderRequest();
        renderSlashMenu();
        updateImageFeedback();
        extras?.update();
        history?.update();
        if (switched && !followScroll) {
            scrollArea.scrollTop = restoredScroll;
        }

        if (previousStatus !== state.status) {
            if (state.uiRequest) {
                // The request announcement takes priority over connection progress.
            } else if (state.status === "ready" && !isActive(previousStatus)) {
                announce("Connected to Pi");
            } else if (state.status === "busy") {
                announce("Pi is working");
            } else if (state.status === "error") {
                announce(error || "Connection issue");
            }

            previousStatus = state.status;
        }

        if (followScroll) {
            // Keep queued scroll events from interpreting transcript layout changes as reader scrolling.
            updateScroll();
        }

        window.requestAnimationFrame(updateScroll);
    }

    const actions = {
        "new-chat": "newChat",
        "review-changes": "reviewChanges",
        "settings-button": "settings",
        "choose-workspace": "chooseWorkspace",
        "connect-button": "connect",
        "connection-button": "connect",
        "cancel-connection": "disconnect",
        "attach-selection": "attachSelection",
        "attach-selection-menu": "attachSelection",
        "attach-file": "attachFile",
        "stop-button": "stop",
        "error-dismiss": "clearError",
    };
    for (const [id, type] of Object.entries(actions)) {
        byId(id).addEventListener("click", () => send({ type }));
    }

    byId("history-button").addEventListener("click", () => history?.toggle());

    byId("attach-menu-button").addEventListener("click", toggleAttachMenu);
    byId("attach-image").addEventListener("click", () => beginUpload("attachImage", {}));
    byId("attach-menu").addEventListener("click", (event) => {
        if (event.target.closest("button")) {
            closeAttachMenu(true);
        }
    });
    byId("attach-menu").addEventListener("keydown", (event) => {
        const buttons = Array.from(byId("attach-menu").querySelectorAll("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && buttons.length) {
            event.preventDefault();
            const next =
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next].focus();
        } else if (event.key === "Escape") {
            event.preventDefault();
            closeAttachMenu(true);
        }
    });
    document.addEventListener("click", (event) => {
        if (!event.target.closest("#attach-menu, #attach-menu-button")) {
            closeAttachMenu();
        }
    });
    input.addEventListener("paste", (event) => {
        const transfer = event.clipboardData;
        const files = Array.from(transfer?.items || [])
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter(Boolean);
        const images = (files.length ? files : Array.from(transfer?.files || [])).filter((file) =>
            file.type.startsWith("image/"),
        );
        if (images.length) {
            event.preventDefault();
            void attachImageFiles(images);
        }
    });
    const isFileDrag = (event) =>
        Array.from(event.dataTransfer?.types || []).some((type) =>
            ["files", "text/uri-list", "application/vnd.code.uri-list", "resourceurls"].includes(type.toLowerCase()),
        );
    document.addEventListener("dragenter", (event) => {
        if (isFileDrag(event)) {
            event.preventDefault();
            dragDepth += 1;
            byId("image-drop-target").hidden = false;
        }
    });
    document.addEventListener("dragover", (event) => {
        if (isFileDrag(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    document.addEventListener("dragleave", (event) => {
        if (isFileDrag(event)) {
            dragDepth = Math.max(0, dragDepth - 1);
            byId("image-drop-target").hidden = dragDepth === 0;
        }
    });
    document.addEventListener("drop", (event) => {
        dragDepth = 0;
        byId("image-drop-target").hidden = true;
        if (isFileDrag(event)) {
            event.preventDefault();
            handleImageDrop(event);
        }
    });
    document.addEventListener("dragend", () => {
        dragDepth = 0;
        byId("image-drop-target").hidden = true;
    });
    byId("image-feedback-dismiss").addEventListener("click", () => showImageFeedback(""));
    byId("image-preview-close").addEventListener("click", closeImagePreview);
    byId("image-preview").addEventListener("close", () => {
        if (byId("image-preview").open) {
            return;
        }

        byId("image-preview-content").replaceChildren();
        byId("image-preview-meta").textContent = "";
        const target = state.uiRequest
            ? byId("ui-request-title") || input
            : previewReturnFocus?.isConnected
              ? previewReturnFocus
              : input;
        previewReturnFocus = null;
        target.focus();
    });

    byId("send-button").addEventListener("click", submitMessage);
    byId("send-mode").addEventListener("change", updateComposer);
    byId("error-retry").addEventListener("click", () => {
        if (state.status === "ready") {
            send({ type: "refresh" });
        } else {
            send({ type: "connect" });
        }
    });
    byId("model-select").addEventListener("change", (event) => {
        try {
            const [provider, modelId] = JSON.parse(event.target.value);
            if (provider && modelId) {
                send({ type: "setModel", provider, modelId });
            }
        } catch {
            announce("Model selection is unavailable");
        }

        renderModels();
    });
    byId("thinking-select").addEventListener("change", (event) => {
        send({ type: "setThinking", level: event.target.value });
        renderModels();
    });
    for (const suggestion of document.querySelectorAll("[data-suggestion]")) {
        suggestion.addEventListener("click", () => {
            input.value = suggestion.dataset.suggestion;
            resizeComposer();
            updateComposer();
            input.focus();
        });
    }

    input.addEventListener("input", () => {
        dismissedSlash = "";
        slashIndex = 0;
        resizeComposer();
        updateComposer();
        renderSlashMenu();
    });
    input.addEventListener("keydown", (event) => {
        if (event.isComposing || event.keyCode === 229) {
            return;
        }

        if (slashItems.length && !byId("slash-menu").hidden) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                slashIndex =
                    (slashIndex + (event.key === "ArrowDown" ? 1 : -1) + slashItems.length) % slashItems.length;
                renderSlashMenu();
                byId(`slash-option-${slashIndex}`)?.scrollIntoView({ block: "nearest" });

                return;
            }

            if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                event.preventDefault();
                chooseSlashCommand(slashItems[slashIndex]);

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                dismissedSlash = input.value;
                hideSlashMenu();

                return;
            }
        }

        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitMessage();
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && byId("image-preview").open) {
            event.preventDefault();
            closeImagePreview();
        } else if (event.key === "Escape" && state.uiRequest && !event.defaultPrevented) {
            event.preventDefault();
            respondToRequest({ cancelled: true });
        }
    });
    byId("jump-to-latest").addEventListener("click", () => {
        followScroll = true;
        updateScroll();
    });
    scrollArea.addEventListener(
        "scroll",
        () => {
            followScroll = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight < 65;
            byId("jump-to-latest").hidden = followScroll;
        },
        { passive: true },
    );
    window.addEventListener("resize", () => {
        resizeComposer();
        updateScroll();
    });
    window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") {
            return;
        }

        history?.handleMessage(message);
        if (message.type !== "state" && message.conversationKey && message.conversationKey !== state.conversationKey) {
            handleBackgroundMessage(message);

            return;
        }

        if (message.type === "state" && message.state && typeof message.state === "object") {
            renderState(hydrateMedia(message));
        } else if (message.type === "focus") {
            input.focus();
        } else if (message.type === "draft" && typeof message.text === "string") {
            input.value = restoreDraftText(input.value, message);
            saveDraft();
            resizeComposer();
            updateComposer();
            input.focus();
        } else if (message.type === "sendResult" && submission && message.requestId === submission) {
            submission = null;
            updateComposer();
        } else if (message.type === "attachmentResult" && pendingUploads.has(message.requestId)) {
            window.clearTimeout(pendingUploads.get(message.requestId));
            pendingUploads.delete(message.requestId);
            showImageFeedback(typeof message.error === "string" ? message.error : "", Boolean(message.error));
        } else if (message.type === "imagePreview" && pendingImagePreviews.has(message.requestId)) {
            const pending = pendingImagePreviews.get(message.requestId);
            pendingImagePreviews.delete(message.requestId);
            window.clearTimeout(pending.timeout);
            pending.button.disabled = false;
            pending.button.textContent = pending.originalText;
            if (message.error) {
                showImageFeedback(String(message.error), true);
            } else {
                openImagePreview(message.image, pending.button, pending.label);
            }
        } else if (message.type === "copied" && pendingCopies.has(message.requestId)) {
            const { button, label, timeout } = pendingCopies.get(message.requestId);
            pendingCopies.delete(message.requestId);
            window.clearTimeout(timeout);
            button.textContent = "Copied";
            announce("Copied to clipboard");
            window.setTimeout(() => {
                button.textContent = label;
            }, 1800);
        }
    });
    window.setInterval(() => {
        if (busySince) {
            const seconds = Math.floor((Date.now() - busySince) / 1000);
            byId("activity-elapsed").textContent =
                seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        }
    }, 1000);
    extras = window.SpecPiExtras?.install({ send, getState: () => state, announce });
    history = window.SpecPiHistory?.install({ send, getState: () => state, announce });
    input.addEventListener("input", saveDraft);
    input.addEventListener("select", saveDraft);
    byId("send-mode").addEventListener("change", saveDraft);
    renderState(state);
    send({ type: "ready" });
})();
