import { useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../../../shared/rpc";
import { stripAnsi } from "../lib/text";

function optionDescription(option: string): string | undefined {
    const normalized = option.toLowerCase();
    if (normalized.includes("exact call")) {
        return "remember this exact call until the session closes";
    }

    if (normalized.includes("allow once")) {
        return "approve only this request";
    }

    if (normalized.includes("lock")) {
        return "deny and block further mutation";
    }

    if (normalized.includes("deny")) {
        return "keep the project unchanged";
    }

    if (normalized.includes("strict")) {
        return "deny risky and scope-breaking calls";
    }

    if (normalized.includes("guard")) {
        return "balanced project protection";
    }

    if (normalized.includes("off")) {
        return "no command guard for this session";
    }

    return undefined;
}

function isGuardApproval(title: string): boolean {
    return /^(?:command guard|path mutation|unknown tool) approval\b/iu.test(title);
}

function approvalDetails(title: string): { heading: string; fields: Array<[string, string]> } {
    const [heading, detail = ""] = title.split(/\s+—\s+/u, 2);
    const fields = detail
        .split(/;\s*/u)
        .map((part) => part.match(/^([^:]+):\s*(.*)$/u))
        .filter((match): match is RegExpMatchArray => Boolean(match?.[2]))
        .map((match) => [match[1]!.trim(), match[2]!.trim()] as [string, string]);

    return { heading: heading || "Command approval", fields };
}

export function ExtensionDialog({
    request,
    respond,
}: {
    request: ExtensionUiRequest;
    respond(value: ExtensionUiResponse): Promise<void>;
}) {
    const [value, setValue] = useState(String(request.prefill ?? ""));
    const first = useRef<HTMLButtonElement>(null);
    const cancel = () => respond({ type: "extension_ui_response", id: request.id, cancelled: true });
    useEffect(() => {
        first.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                void cancel();
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [request.id]);
    const title = stripAnsi(String(request.title ?? "Pi requires input"));
    const approval = useMemo(() => approvalDetails(title), [title]);
    if (request.method === "select") {
        const options = Array.isArray(request.options)
            ? request.options.filter((item): item is string => typeof item === "string")
            : [];
        if (isGuardApproval(title)) {
            const detail = Object.fromEntries(
                approval.fields.map(([label, fieldValue]) => [label.toLowerCase(), fieldValue]),
            );
            const summary = detail.reason ?? detail.affected ?? "Review this protected operation.";
            const optionLabel = (option: string) =>
                /exact call/iu.test(option)
                    ? "Session"
                    : /allow once/iu.test(option)
                      ? "Once"
                      : /lock/iu.test(option)
                        ? "Lock"
                        : "Deny";

            return (
                <section className="approval-dock" role="dialog" aria-modal="false" aria-labelledby="approval-title">
                    <div className="approval-line">
                        <div className="approval-shield" aria-hidden="true">
                            ◇
                        </div>
                        <div className="approval-copy">
                            <h2 id="approval-title">Approval needed</h2>
                            <p>{summary}</p>
                        </div>
                        <div className="approval-actions">
                            {options.map((option, index) => (
                                <button
                                    ref={index === 0 ? first : undefined}
                                    key={option}
                                    title={optionDescription(option)}
                                    className={
                                        /deny.*recommended/iu.test(option)
                                            ? "safe"
                                            : /allow/iu.test(option)
                                              ? "allow"
                                              : ""
                                    }
                                    onClick={() =>
                                        void respond({ type: "extension_ui_response", id: request.id, value: option })
                                    }
                                >
                                    {optionLabel(option)}
                                </button>
                            ))}
                        </div>
                    </div>
                    {approval.fields.length > 0 ? (
                        <details className="approval-more">
                            <summary>Review details</summary>
                            <dl className="approval-details">
                                {approval.fields.map(([label, fieldValue]) => (
                                    <div key={label}>
                                        <dt>{label}</dt>
                                        <dd>{fieldValue}</dd>
                                    </div>
                                ))}
                            </dl>
                        </details>
                    ) : null}
                </section>
            );
        }

        return (
            <div
                className="modal-backdrop"
                role="presentation"
                onMouseDown={(event) => event.target === event.currentTarget && void cancel()}
            >
                <section
                    className={`modal extension-modal ${/guard/iu.test(title) ? "guard-modal" : ""}`}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="extension-dialog-title"
                >
                    <header className="modal-header horizontal">
                        <h2 id="extension-dialog-title">{title}</h2>
                        {/guard/iu.test(title) ? <span>session scoped</span> : null}
                    </header>
                    <div className="modal-body option-list">
                        {options.map((option, index) => (
                            <button
                                ref={index === 0 ? first : undefined}
                                key={option}
                                className={index === 0 && /recommended/iu.test(option) ? "recommended" : ""}
                                onClick={() =>
                                    void respond({ type: "extension_ui_response", id: request.id, value: option })
                                }
                            >
                                <strong>{stripAnsi(option)}</strong>
                                {optionDescription(option) ? <span>{optionDescription(option)}</span> : null}
                            </button>
                        ))}
                        <button className="secondary cancel-option" onClick={() => void cancel()}>
                            Cancel
                        </button>
                    </div>
                </section>
            </div>
        );
    }

    if (request.method === "confirm") {
        return (
            <div className="modal-backdrop">
                <section className="modal" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
                    <h2 id="extension-dialog-title">{title}</h2>
                    <p>{stripAnsi(String(request.message ?? ""))}</p>
                    <div className="modal-actions">
                        <button
                            ref={first}
                            className="secondary"
                            onClick={() =>
                                void respond({ type: "extension_ui_response", id: request.id, confirmed: false })
                            }
                        >
                            No
                        </button>
                        <button
                            onClick={() =>
                                void respond({ type: "extension_ui_response", id: request.id, confirmed: true })
                            }
                        >
                            Yes
                        </button>
                    </div>
                </section>
            </div>
        );
    }

    if (request.method !== "input" && request.method !== "editor") {
        return (
            <div className="modal-backdrop">
                <section
                    className="modal"
                    role="alertdialog"
                    aria-modal="true"
                    aria-labelledby="extension-dialog-title"
                >
                    <h2 id="extension-dialog-title">Unsupported extension interface</h2>
                    <p>{title}</p>
                    <p>Pi requested “{stripAnsi(request.method)}”, which this Desktop version cannot render safely.</p>
                    <div className="modal-actions">
                        <button ref={first} onClick={() => void cancel()}>
                            Cancel request
                        </button>
                    </div>
                </section>
            </div>
        );
    }

    const multiline = request.method === "editor";

    return (
        <div className="modal-backdrop">
            <section className="modal" role="dialog" aria-modal="true" aria-labelledby="extension-dialog-title">
                <h2 id="extension-dialog-title">{title}</h2>
                {multiline ? (
                    <textarea autoFocus rows={12} value={value} onChange={(event) => setValue(event.target.value)} />
                ) : (
                    <input
                        autoFocus
                        value={value}
                        placeholder={String(request.placeholder ?? "")}
                        onChange={(event) => setValue(event.target.value)}
                    />
                )}
                <div className="modal-actions">
                    <button className="secondary" onClick={() => void cancel()}>
                        Cancel
                    </button>
                    <button onClick={() => void respond({ type: "extension_ui_response", id: request.id, value })}>
                        Submit
                    </button>
                </div>
            </section>
        </div>
    );
}
