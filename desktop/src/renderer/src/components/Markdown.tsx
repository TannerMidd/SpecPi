import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo } from "react";

marked.setOptions({ gfm: true, breaks: false });

export const Markdown = memo(function Markdown({ content }: { content: string }) {
    const rendered = marked.parse(content, { async: false }) as string;
    const sanitized = DOMPurify.sanitize(rendered, {
        ALLOWED_URI_REGEXP: /^(?:(?:https?):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/iu,
        FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "svg", "math"],
        FORBID_ATTR: ["style", "onerror", "onload"],
    });
    const html = sanitized.replace(
        /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gu,
        '<div class="code-block"><button type="button" data-copy-code>Copy code</button><pre><code$1>$2</code></pre></div>',
    );

    return (
        <div
            className="markdown"
            onClick={(event) => {
                const target = event.target as HTMLElement;
                const copy = target.closest<HTMLButtonElement>("button[data-copy-code]");
                if (copy) {
                    const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
                    void window.specpi.copyText(code);

                    return;
                }

                const link = target.closest<HTMLAnchorElement>("a[href]");
                if (link) {
                    event.preventDefault();
                    if (/^https?:$/u.test(new URL(link.href).protocol)) {
                        void window.specpi.openExternal(link.href);
                    }
                }
            }}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
});
