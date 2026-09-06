"use strict";

function attribute(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function icon(name, className = "") {
    return `<svg class="icon ${className}" aria-hidden="true" viewBox="0 0 24 24"><use href="#icon-${name}"></use></svg>`;
}

function getWebviewHtml({
    cspSource,
    scriptUri,
    styleUri,
    nonce,
    extrasScriptUri,
    extrasStyleUri,
    historyScriptUri,
    historyStyleUri,
}) {
    const extrasScript = extrasScriptUri || String(scriptUri).replace(/chat\.js(?=[?#]|$)/u, "chat-extras.js");
    const extrasStyle = extrasStyleUri || String(styleUri).replace(/chat\.css(?=[?#]|$)/u, "chat-extras.css");
    const historyScript = historyScriptUri || String(scriptUri).replace(/chat\.js(?=[?#]|$)/u, "chat-picker.js");
    const historyStyle = historyStyleUri || String(styleUri).replace(/chat\.css(?=[?#]|$)/u, "chat-picker.css");
    const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource}; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">
    <link rel="stylesheet" href="${attribute(styleUri)}">
    <link rel="stylesheet" href="${attribute(extrasStyle)}">
    <link rel="stylesheet" href="${attribute(historyStyle)}">
    <title>SpecPi Chat</title>
</head>
<body>
    <svg class="icon-library" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <symbol id="icon-mark" viewBox="0 0 24 24"><path d="M4 5h16v11h-7l-5 4v-4H4z"/><path d="m8 9 2 2-2 2m5 0h3"/></symbol>
            <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
            <symbol id="icon-history" viewBox="0 0 24 24"><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/></symbol>
            <symbol id="icon-settings" viewBox="0 0 24 24"><path d="M4 7h16M4 17h16M8 4v6m8 4v6"/></symbol>
            <symbol id="icon-review" viewBox="0 0 24 24"><path d="M5 3h10l4 4v14H5zm9 0v5h5M8 12h6m-3-3v6m-3 3h6"/></symbol>
            <symbol id="icon-folder" viewBox="0 0 24 24"><path d="M3 6h7l2 3h9v11H3z"/></symbol>
            <symbol id="icon-arrow" viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"/></symbol>
            <symbol id="icon-down" viewBox="0 0 24 24"><path d="M12 5v14m-6-6 6 6 6-6"/></symbol>
            <symbol id="icon-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1"/></symbol>
            <symbol id="icon-attach" viewBox="0 0 24 24"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8a6 6 0 0 1 9 9l-7 7"/></symbol>
            <symbol id="icon-image" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></symbol>
            <symbol id="icon-selection" viewBox="0 0 24 24"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/></symbol>
            <symbol id="icon-close" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></symbol>
            <symbol id="icon-spark" viewBox="0 0 24 24"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></symbol>
            <symbol id="icon-chevron" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></symbol>
            <symbol id="icon-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
        </defs>
    </svg>
    <div class="app">
        <header class="topbar">
            <div class="brand">${icon("mark", "brand-mark")}<span>SpecPi <span class="brand-chat">Chat</span></span></div>
            <nav class="header-actions" aria-label="Conversation actions">
                <button id="new-chat" class="icon-button" type="button" title="New conversation" aria-label="New conversation">${icon("plus")}</button>
                <button id="history-button" class="icon-button" type="button" title="Session history" aria-label="Session history">${icon("history")}</button>
                <button id="review-changes" class="icon-button" type="button" title="Review workspace changes" aria-label="Review workspace changes">${icon("review")}</button>
                <button id="settings-button" class="icon-button" type="button" title="SpecPi Chat settings" aria-label="SpecPi Chat settings">${icon("settings")}</button>
            </nav>
        </header>
        <button id="choose-workspace" class="workspace-bar" type="button" title="Choose workspace">${icon("folder")}<span id="workspace-name">No workspace</span><span class="workspace-runtime">LOCAL PI</span></button>
        <div class="session-bar">
            <h1 id="session-title">New conversation</h1>
            <button id="connection-button" class="connection-pill" type="button" title="Connect to Pi"><span class="status-dot"></span><span id="connection-label">Offline</span></button>
        </div>
        <section id="connection-banner" class="connection-banner" aria-label="Connection progress" hidden>
            <div class="connection-progress-heading"><span class="activity-spinner" aria-hidden="true"></span><span>Connecting to Pi</span></div>
            <p id="connection-message" role="status" aria-live="polite"></p>
            <button id="cancel-connection" class="text-button" type="button">Cancel connection</button>
        </section>
        <main id="scroll-area" class="scroll-area" aria-label="Chat conversation" tabindex="0">
            <section id="welcome" class="welcome" aria-labelledby="welcome-title">
                <div class="welcome-mark">${icon("mark")}</div>
                <p class="eyebrow">A little context. A clear next step.</p>
                <h2 id="welcome-title">Your workspace.<br>Your direction.</h2>
                <p class="welcome-description">Plan a change, explore your code, or work through a problem with Pi by your side.</p>
                <button id="connect-button" class="primary-button connect-button" type="button">Connect to Pi ${icon("chevron")}</button>
                <p id="connect-note" class="connect-note">Uses your local Pi installation and configured model provider.</p>
                <div class="suggestions" aria-label="Conversation starters">
                    <button class="suggestion" type="button" data-suggestion="Help me understand this workspace. Start with the main entry points and how the pieces fit together."><span class="suggestion-title">Explore this workspace</span><span class="suggestion-detail">Find the entry points and moving parts</span>${icon("chevron")}</button>
                    <button class="suggestion" type="button" data-suggestion="Help me plan a change. Ask me what I want to build, then inspect the relevant code before proposing an approach."><span class="suggestion-title">Plan a change</span><span class="suggestion-detail">Turn an idea into a concrete next step</span>${icon("chevron")}</button>
                    <button class="suggestion" type="button" data-suggestion="Review the code I attach. Look for bugs, edge cases, and changes that would make it easier to maintain."><span class="suggestion-title">Review some code</span><span class="suggestion-detail">Attach a file or your editor selection</span>${icon("chevron")}</button>
                </div>
            </section>
            <div id="conversation" class="conversation" role="log" aria-label="Messages" aria-live="off"></div>
            <div id="activity" class="activity" hidden><span class="activity-spinner" aria-hidden="true"></span><span id="activity-label">Pi is working</span><span id="activity-elapsed"></span></div>
        </main>
        <div class="jump-row"><button id="jump-to-latest" class="jump-button" type="button" hidden>${icon("down")} Jump to latest</button></div>
        <footer class="footer">
            <div class="footer-panels">
            <div id="error-banner" class="error-banner" role="alert" hidden><p id="error-message"></p><div class="error-actions"><button id="error-retry" class="text-button" type="button">Try again</button><button id="error-dismiss" class="text-button" type="button">Dismiss</button></div></div>
            <div id="queue-notice" class="queue-notice" hidden></div>
            <details id="runtime-details" class="runtime-details" hidden><summary>Runtime status <span id="runtime-count"></span></summary><dl id="runtime-values"></dl></details>
            <section id="ui-request" class="ui-request" aria-labelledby="ui-request-title" hidden></section>
            <div id="image-feedback" class="image-feedback" role="status" hidden><span id="image-feedback-text"></span><button id="image-feedback-dismiss" class="text-button" type="button" aria-label="Dismiss image attachment message">Dismiss</button></div>
            <p id="vision-warning" class="vision-warning" hidden></p>
            </div>
            <div class="composer" id="composer">
                <div id="attachments" class="attachments" aria-label="Attached context" hidden></div>
                <div id="image-drop-target" class="image-drop-target" hidden>Drop images or workspace files to attach</div>
                <div id="attach-menu" class="attach-menu" role="menu" aria-label="Attach context" hidden>
                    <button id="attach-file" role="menuitem" type="button">${icon("attach")} Workspace file</button>
                    <button id="attach-image" role="menuitem" type="button">${icon("image")} Image…</button>
                    <button id="attach-selection-menu" role="menuitem" type="button">${icon("selection")} Editor selection</button>
                    <p>Paste a screenshot or drop an image here.</p>
                </div>
                <div id="slash-menu" class="slash-menu" role="listbox" aria-label="Pi commands" hidden></div>
                <label class="sr-only" for="composer-input">Message Pi</label>
                <textarea id="composer-input" rows="1" maxlength="65536" placeholder="Ask Pi, or / for commands" title="Enter to send · Shift+Enter for a new line" aria-describedby="composer-hint" autocomplete="off" spellcheck="true"></textarea>
                <div class="composer-options">
                    <div class="context-actions">
                        <button id="attach-menu-button" class="icon-button" type="button" title="Attach file, image, or selection" aria-label="Attach context" aria-haspopup="menu" aria-expanded="false" aria-controls="attach-menu">${icon("attach")}</button>
                        <button id="attach-selection" class="icon-button" type="button" title="Attach editor selection" aria-label="Attach editor selection">${icon("selection")}</button>
                    </div>
                    <label class="sr-only" for="model-select">Model</label>
                    <select id="model-select" class="compact-select model-select" title="Model"><option value="">Default model</option></select>
                    <label class="sr-only" for="thinking-select">Thinking level</label>
                    <select id="thinking-select" class="compact-select thinking-select" title="Thinking level"><option value="off">Thinking off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Max</option></select>
                    <div class="send-actions">
                        <button id="send-button" class="send-button" type="button" title="Send message" aria-label="Send message" disabled>${icon("arrow")}<span id="send-label" class="sr-only">Send</span></button>
                    </div>
                </div>
                <div id="composer-details" class="composer-bottom" hidden>
                    <span id="composer-hint" class="composer-hint">Enter to send · Shift+Enter for a new line</span>
                </div>
            </div>
            <div class="session-footer">
                <div class="footer-status">
                    <span id="runtime-status">Connect when you're ready</span>
                    <label id="send-mode-label" class="sr-only" for="send-mode">Message timing</label>
                    <select id="send-mode" class="compact-select send-mode" title="When to send your next message" hidden><option value="steer">Steer now</option><option value="followUp">Follow up</option></select>
                </div>
                <span id="token-status" title="Session usage"></span>
                <button id="stop-button" class="stop-button" type="button" title="Stop response" aria-label="Stop response" hidden>${icon("stop")}<span>Stop</span></button>
            </div>
        </footer>
        <div id="announcer" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    </div>
    <dialog id="image-preview" class="image-preview" aria-labelledby="image-preview-title">
        <div class="image-preview-header"><h2 id="image-preview-title">Image preview</h2><button id="image-preview-close" class="icon-button" type="button" aria-label="Close image preview">${icon("close")}</button></div>
        <div id="image-preview-content" class="image-preview-content"></div>
        <p id="image-preview-meta" class="image-preview-meta"></p>
    </dialog>
    <script nonce="${attribute(nonce)}" src="${attribute(extrasScript)}"></script>
    <script nonce="${attribute(nonce)}" src="${attribute(historyScript)}"></script>
    <script nonce="${attribute(nonce)}" src="${attribute(scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { getWebviewHtml };
