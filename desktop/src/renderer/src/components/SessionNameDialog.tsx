import { useState, type FormEvent } from "react";

export function SessionNameDialog({
    initialName,
    close,
    rename,
}: {
    initialName: string;
    close(): void;
    rename(name: string): Promise<void>;
}) {
    const [name, setName] = useState(initialName);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const trimmedName = name.trim();

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!trimmedName || submitting) {
            return;
        }

        setSubmitting(true);
        setError("");
        try {
            await rename(trimmedName);
            close();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setSubmitting(false);
        }
    };

    return (
        <div
            className="modal-backdrop"
            onMouseDown={(event) => event.target === event.currentTarget && !submitting && close()}
        >
            <section
                className="modal session-name-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="rename-title"
            >
                <header className="modal-header">
                    <h2 id="rename-title">Rename session</h2>
                    <span>Give this Pi session a distinct name.</span>
                </header>
                <form className="modal-body" onSubmit={(event) => void submit(event)}>
                    <label className="dialog-field" htmlFor="session-name">
                        <span>Session name</span>
                        <input
                            id="session-name"
                            aria-label="Session name"
                            autoFocus
                            required
                            maxLength={200}
                            value={name}
                            disabled={submitting}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </label>
                    {error ? <p className="error">{error}</p> : null}
                    <div className="modal-actions">
                        <button className="secondary" type="button" disabled={submitting} onClick={close}>
                            Cancel
                        </button>
                        <button type="submit" disabled={!trimmedName || submitting}>
                            {submitting ? "Renaming…" : "Rename"}
                        </button>
                    </div>
                </form>
            </section>
        </div>
    );
}
