import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getWebviewHtml } = require("../vscode/src/webview.js");
const {
    safeHref,
    imageSource,
    parseMarkdown,
    inlineTokens,
    runtimeText,
    providerUsageEntries,
} = require("../vscode/media/chat.js");

const webviewOptions = {
    cspSource: "https://specpi-test.vscode-cdn.net",
    scriptUri: "https://specpi-test.vscode-cdn.net/media/chat.js",
    styleUri: "https://specpi-test.vscode-cdn.net/media/chat.css",
    nonce: "specpi-test-nonce-1234567890",
};

function attributeValue(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "u"));
    assert.ok(match, `Missing ${name} attribute: ${tag}`);

    return match[1];
}

function decodeAttribute(value) {
    return value
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&#x27;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

test("provider usage projects only known plugin status strings without inventing quota semantics", () => {
    const status = {
        "aa-codex-usage": "\u001b[36mcodex\u001b[0m ▀▀▀▄▄▄▄ 4d",
        "provider-usage": "claude 25% 5h · 40% 7d (3m old)",
        "some-other-plugin": "must stay in generic runtime status",
    };
    const entries = providerUsageEntries(status);
    assert.deepEqual(
        entries.map(({ source, text }) => [source, text]),
        [
            ["@llblab/pi-codex-usage", "codex ▀▀▀▄▄▄▄ 4d"],
            ["@sreetej510/pi-usage", status["provider-usage"]],
        ],
    );
    for (const value of [undefined, null, {}, false, 12, "", "\u001b[0m", { token: "SYNTHETIC-PRIVATE" }]) {
        assert.deepEqual(providerUsageEntries({ "provider-usage": value }), []);
    }

    assert.deepEqual(providerUsageEntries(Object.create(status)), []);
    assert.equal(
        providerUsageEntries({ "provider-usage": "usage rate-limited (3m)" })[0].text,
        "usage rate-limited (3m)",
    );
    assert.equal(providerUsageEntries({ "provider-usage": "checking" })[0].text, "checking");
    assert.equal(providerUsageEntries({ "aa-codex-usage": "codex n/a" })[0].text, "codex n/a");
    assert.equal(runtimeText("x".repeat(5000)).length, 4000);
    assert.equal(runtimeText("\u001b]8;;https://example.invalid/\u0007text\u001b]8;;\u0007\u202e\u0000"), "text");
    assert.equal(runtimeText("\u009b31mred\u009b0m\nnext"), "red\nnext");
});

test("chat webview denies content by default and authorizes only its nonce-bearing local scripts", () => {
    const html = getWebviewHtml(webviewOptions);
    const meta = html.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/u)?.[0];
    assert.ok(meta, "The webview must declare a Content Security Policy");
    const content = decodeAttribute(attributeValue(meta, "content"));
    const policy = new Map(
        content
            .split(";")
            .map((directive) => directive.trim().split(/\s+/u))
            .filter(([name]) => name)
            .map(([name, ...sources]) => [name, sources]),
    );
    assert.deepEqual(policy.get("default-src"), ["'none'"]);
    assert.deepEqual(policy.get("script-src"), [`'nonce-${webviewOptions.nonce}'`]);
    assert.deepEqual(policy.get("img-src"), ["data:"]);
    assert.deepEqual(policy.get("connect-src"), ["'none'"]);
    assert.ok(policy.get("style-src")?.includes(webviewOptions.cspSource));
    assert.doesNotMatch(content, /'unsafe-inline'|'unsafe-eval'|\*/u);

    const scripts = Array.from(html.matchAll(/<script\b[^>]*>/gu), (match) => match[0]);
    assert.deepEqual(
        scripts.map((script) => decodeAttribute(attributeValue(script, "src"))),
        [
            "https://specpi-test.vscode-cdn.net/media/chat-extras.js",
            "https://specpi-test.vscode-cdn.net/media/chat-picker.js",
            webviewOptions.scriptUri,
        ],
    );
    for (const script of scripts) {
        assert.equal(decodeAttribute(attributeValue(script, "nonce")), webviewOptions.nonce);
    }

    const stylesheets = Array.from(html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gu), (match) => match[0]);
    assert.deepEqual(
        stylesheets.map((link) => decodeAttribute(attributeValue(link, "href"))),
        [
            webviewOptions.styleUri,
            "https://specpi-test.vscode-cdn.net/media/chat-extras.css",
            "https://specpi-test.vscode-cdn.net/media/chat-picker.css",
        ],
    );
    assert.doesNotMatch(html, /\son(?:click|load|error|submit|input)\s*=/iu);
});

test("webview resource attributes cannot inject executable markup", () => {
    const payload = '\"><img src=x onerror=alert(1)><script>alert(2)</script>&';
    const html = getWebviewHtml({
        ...webviewOptions,
        cspSource: webviewOptions.cspSource + payload,
        scriptUri: webviewOptions.scriptUri + payload,
        styleUri: webviewOptions.styleUri + payload,
        extrasScriptUri: "https://specpi-test.vscode-cdn.net/media/chat-extras.js" + payload,
        extrasStyleUri: "https://specpi-test.vscode-cdn.net/media/chat-extras.css" + payload,
        historyScriptUri: "https://specpi-test.vscode-cdn.net/media/chat-picker.js" + payload,
        historyStyleUri: "https://specpi-test.vscode-cdn.net/media/chat-picker.css" + payload,
        nonce: webviewOptions.nonce + payload,
    });
    assert.equal(Array.from(html.matchAll(/<script\b/gu)).length, 3);
    assert.doesNotMatch(html, /<img src=x|<script>alert\(2\)/u);
    const scripts = Array.from(html.matchAll(/<script\b[^>]*>/gu), (match) => match[0]);
    assert.deepEqual(
        scripts.map((script) => decodeAttribute(attributeValue(script, "src"))),
        [
            "https://specpi-test.vscode-cdn.net/media/chat-extras.js" + payload,
            "https://specpi-test.vscode-cdn.net/media/chat-picker.js" + payload,
            webviewOptions.scriptUri + payload,
        ],
    );
    for (const script of scripts) {
        assert.equal(decodeAttribute(attributeValue(script, "nonce")), webviewOptions.nonce + payload);
    }

    const stylesheets = Array.from(html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gu), (match) => match[0]);
    assert.deepEqual(
        stylesheets.map((link) => decodeAttribute(attributeValue(link, "href"))),
        [
            webviewOptions.styleUri + payload,
            "https://specpi-test.vscode-cdn.net/media/chat-extras.css" + payload,
            "https://specpi-test.vscode-cdn.net/media/chat-picker.css" + payload,
        ],
    );
});

test("chat links allow only normalized absolute HTTP and HTTPS destinations", () => {
    assert.equal(safeHref("https://example.com/docs?q=specpi#chat"), "https://example.com/docs?q=specpi#chat");
    assert.equal(safeHref("HTTP://EXAMPLE.COM"), "http://example.com/");
    assert.equal(safeHref("https://example.com/a%20b"), "https://example.com/a%20b");
    for (const href of [
        null,
        undefined,
        42,
        {},
        "https://example.com/a b",
        "https://example.com/\u0000",
        "https://exa\nmple.com/",
        "https://user:secret@example.com/",
        "https://user@example.com/",
        "https://example.com\\@evil.example/",
        `https://example.com/${"x".repeat(4096)}`,
        "https:example.com",
        "http:example.com",
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "\n\tjavascript:alert(1)",
        "java\nscript:alert(1)",
        "java\tscript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///C:/Users/Tanner/private.txt",
        "command:workbench.action.terminal.new",
        "vscode://file/C:/Users/Tanner/private.txt",
        "mailto:user@example.com",
        "blob:https://example.com/untrusted",
        "about:blank",
        "//example.com/path",
        "/relative/path",
        "#fragment",
        "javascript%3Aalert(1)",
        "&#106;avascript:alert(1)",
        "https://",
        "",
    ]) {
        assert.equal(safeHref(href), null, `Unexpected permitted link: ${JSON.stringify(href)}`);
    }
});

test("image transport accepts bounded raster MIME and strict base64 without accepting document formats", () => {
    const data = "AQIDBA==";
    const dimensions = { width: 1, height: 1 };
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
        assert.equal(imageSource({ mimeType, data, ...dimensions }), `data:${mimeType};base64,${data}`);
    }

    for (const image of [
        null,
        undefined,
        {},
        [],
        `data:image/png;base64,${data}`,
        ...[
            "image/svg+xml",
            "IMAGE/SVG+XML",
            "image/PNG",
            "image/jpg",
            "text/html",
            "application/pdf",
            "image/bmp",
            "image/x-icon",
            "",
        ].map((mimeType) => ({ mimeType, data, ...dimensions })),
        ...[
            "",
            "AQID BA==",
            "AQIDBA==\n",
            "data:image/png;base64,AQIDBA==",
            "AAAA=",
            "A===",
            "=AAA",
            "AAA",
            "_w==",
            "AB==",
            "AAB=",
        ].map((invalidData) => ({ mimeType: "image/png", data: invalidData, ...dimensions })),
        { mimeType: "image/png", data: 42, ...dimensions },
    ]) {
        assert.equal(imageSource(image), null, `Unexpected permitted image transport: ${JSON.stringify(image)}`);
    }
});

test("image transport enforces the decoded byte limit including a same-length base64 overflow", () => {
    const limit = 5 * 1024 * 1024;
    const atLimit = Buffer.alloc(limit).toString("base64");
    const overLimit = Buffer.alloc(limit + 1).toString("base64");
    assert.equal(
        atLimit.length,
        overLimit.length,
        "The boundary fixture must exercise decoded rather than encoded size",
    );
    assert.equal(
        imageSource({ mimeType: "image/png", data: atLimit, width: 1, height: 1 })?.length,
        "data:image/png;base64,".length + atLimit.length,
    );
    assert.equal(imageSource({ mimeType: "image/png", data: overLimit, width: 1, height: 1 }), null);
});

test("image transport rejects excessive or invalid advertised dimensions", () => {
    const image = { mimeType: "image/png", data: "AQIDBA==" };
    assert.ok(imageSource({ ...image, width: 8000, height: 5000 }));
    assert.ok(imageSource({ ...image, width: 16384, height: 1 }));
    for (const dimensions of [
        {},
        { width: 8001, height: 5000 },
        { width: 16385, height: 1 },
        { width: 1, height: 16385 },
        { width: 0, height: 1 },
        { width: 1, height: -1 },
        { width: 1.5, height: 1 },
        { width: "1", height: 1 },
        { width: NaN, height: 1 },
        { width: 1, height: Infinity },
        { width: 1 },
        { height: 1 },
        { width: null, height: null },
    ]) {
        assert.equal(imageSource({ ...image, ...dimensions }), null, JSON.stringify(dimensions));
    }
});

test("Markdown images become explicit workspace preview or external-link actions", () => {
    assert.deepEqual(inlineTokens("![Result](assets/result.png)"), [
        { type: "imagePreview", text: "Result", reference: "assets/result.png" },
    ]);
    assert.deepEqual(inlineTokens("![](assets/result.png)"), [
        { type: "imagePreview", text: "Image", reference: "assets/result.png" },
    ]);
    assert.deepEqual(inlineTokens("![Before](<assets/my%20image.png>)"), [
        { type: "imagePreview", text: "Before", reference: "assets/my image.png" },
    ]);
    assert.deepEqual(inlineTokens("![Remote](HTTPS://EXAMPLE.COM/result.png)"), [
        { type: "externalImage", text: "Remote", href: "https://example.com/result.png" },
    ]);
    assert.deepEqual(inlineTokens("![Remote](http://example.com/result.gif)"), [
        { type: "externalImage", text: "Remote", href: "http://example.com/result.gif" },
    ]);
    for (const destination of [
        "data:image/png;base64,AQIDBA==",
        "javascript:alert%281%29",
        "command:run.png",
        "//example.com/tracker.png",
        "https://user:secret@example.com/image.png",
    ]) {
        const text = `![Unsafe](${destination})`;
        assert.deepEqual(inlineTokens(text), [{ type: "text", text }]);
    }

    assert.deepEqual(inlineTokens("`![Result](assets/result.png)`"), [
        { type: "code", text: "![Result](assets/result.png)" },
    ]);
    assert.deepEqual(inlineTokens("[Source](assets/result.png)"), [
        { type: "codeLink", text: "Source", reference: "assets/result.png" },
    ]);
});

test("Markdown preserves fenced source literally and handles unfinished streaming fences", () => {
    const code = '<script>alert("x")</script>\n[hidden](javascript:alert%281%29)';
    assert.deepEqual(parseMarkdown(`\`\`\`html\n${code}\n\`\`\``), [{ type: "code", language: "html", text: code }]);
    assert.deepEqual(parseMarkdown(`\`\`\`html\n${code}`), [{ type: "code", language: "html", text: code }]);
    assert.deepEqual(inlineTokens("`<img src=x onerror=alert(1)>`"), [
        { type: "code", text: "<img src=x onerror=alert(1)>" },
    ]);
    assert.deepEqual(inlineTokens("``Use `literal` ticks``"), [{ type: "code", text: "Use `literal` ticks" }]);
    assert.deepEqual(inlineTokens("An unfinished `code span"), [{ type: "text", text: "An unfinished `code span" }]);
});

test("chat code references use host navigation for markdown, code spans, and plain file locations", () => {
    const text =
        "See `src/app.ts:12:3`, src/view.ts#L5-L8, [source](src/app.ts:12) and [space](<src/my%20file.ts#L2>).";
    const references = inlineTokens(text).filter((token) => token.type === "codeLink");
    assert.deepEqual(
        references.map((token) => token.reference),
        ["src/app.ts:12:3", "src/view.ts#L5-L8", "src/app.ts:12", "src/my file.ts#L2"],
    );
    assert.equal(inlineTokens("`src/literal%20name.ts:2`")[0].reference, "src/literal%20name.ts:2");
    assert.equal(inlineTokens("`app.ts:12:3`")[0].reference, "app.ts:12:3");
    assert.equal(inlineTokens("See app.ts:12.")[1].reference, "app.ts:12");
    assert.equal(inlineTokens("`F:\\project\\src\\app.ts:12`")[0].reference, "F:\\project\\src\\app.ts:12");
    assert.equal(
        inlineTokens("[source](file:///F:/project/src/app.ts#L4)")[0].reference,
        "file:///F:/project/src/app.ts#L4",
    );
    for (const source of [
        "[unsafe](command:run.ts:12)",
        "`javascript:alert.js:12`",
        "https://example.com/file.ts:12",
        "![image](src/preview.png)",
        "`const result = run();`",
        "`//remote/private/file.ts:12`",
    ]) {
        assert.ok(!inlineTokens(source).some((token) => token.type === "codeLink"), source);
    }

    assert.equal(parseMarkdown("```\nsrc/app.ts:12\n```")[0].type, "code");
});

test("Markdown parses common chat formatting into inert structured tokens", () => {
    const blocks = parseMarkdown("## Change summary\n\nUpdated the sidebar.\n\n- [x] Tests pass\n- [ ] Review diff");
    assert.deepEqual(blocks, [
        { type: "heading", level: 2, text: "Change summary" },
        { type: "paragraph", text: "Updated the sidebar." },
        {
            type: "list",
            ordered: false,
            items: [
                { text: "Tests pass", checked: true },
                { text: "Review diff", checked: false },
            ],
        },
    ]);
    assert.deepEqual(inlineTokens("[Docs](https://example.com/docs)"), [
        { type: "link", text: "Docs", href: "https://example.com/docs" },
    ]);
    assert.deepEqual(inlineTokens("[Run](command:workbench.action.terminal.new)"), [
        { type: "text", text: "[Run](command:workbench.action.terminal.new)" },
    ]);
    assert.deepEqual(inlineTokens("<script>alert(1)</script>"), [{ type: "text", text: "<script>alert(1)</script>" }]);
});

test("the markdown parser never creates raw HTML or executable link tokens", () => {
    const malicious = [
        "<img src=x onerror=alert(1)>",
        "<script>alert(document.cookie)</script>",
        "[execute](javascript:alert%281%29)",
        "[execute](data:text/html,attack)",
        "[execute](command:workbench.action.terminal.new)",
        "![image](https://example.com/tracker.png)",
    ];
    for (const source of malicious) {
        const blocks = parseMarkdown(source);
        const tokens = inlineTokens(source);
        assert.ok(Array.isArray(blocks));
        assert.ok(Array.isArray(tokens));
        for (const token of tokens) {
            assert.notEqual(token.type, "html");
            assert.notEqual(token.type, "image");
            if (token.type === "link" || token.type === "externalImage") {
                assert.ok(safeHref(token.href), "A link token must contain an allowed destination");
            }
        }
    }
});

test("long malformed streaming Markdown cannot trap the renderer in regex backtracking", () => {
    const parserPath = fileURLToPath(new URL("../vscode/media/chat.js", import.meta.url));
    const script = [
        'const assert = require("node:assert/strict");',
        `const { inlineTokens, parseMarkdown } = require(${JSON.stringify(parserPath)});`,
        "const length = 128000;",
        'for (const text of ["[".repeat(length), "[a](a".repeat(length / 5), ".".repeat(length) + "x"]) {',
        '    assert.deepEqual(inlineTokens(text), [{ type: "text", text }]);',
        "}",
        'assert.ok(Array.isArray(inlineTokens("`".repeat(length))));',
        'assert.deepEqual(parseMarkdown("A | B\\n" + " ".repeat(length)), [{ type: "paragraph", text: "A | B" }]);',
        'for (const fill of [" ", "#"]) {',
        '    const text = "a" + fill.repeat(length) + "b";',
        '    assert.deepEqual(parseMarkdown("# " + text), [{ type: "heading", level: 1, text }]);',
        "}",
        'assert.ok(Array.isArray(parseMarkdown("line\\n".repeat(30000))));',
        'process.stdout.write("parsed");',
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
    });
    assert.equal(result.error?.code, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "parsed");
});

test("webview rendering contains no executable string or HTML insertion sinks", () => {
    for (const name of ["chat.js", "chat-extras.js", "chat-picker.js"]) {
        const script = readFileSync(new URL(`../vscode/media/${name}`, import.meta.url), "utf8");
        assert.doesNotMatch(script, /\.(?:innerHTML|outerHTML|insertAdjacentHTML)\b/u, name);
        assert.doesNotMatch(script, /\bdocument\s*\.\s*(?:write|writeln)\s*\(/u, name);
        assert.doesNotMatch(script, /\beval\s*\(|\bnew\s+Function\s*\(/u, name);
        assert.doesNotMatch(script, /\blocalStorage\b|\bsessionStorage\b/u, name);
        assert.doesNotMatch(script, /\bfetch\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\s*\(/u, name);
    }
});
