export class SessionTransitionLock {
    #active = false;

    acquire(): boolean {
        if (this.#active) {
            return false;
        }

        this.#active = true;

        return true;
    }

    release(): void {
        this.#active = false;
    }
}

export function sessionTransitionCancelled(value: unknown): boolean {
    return Boolean(value && typeof value === "object" && (value as { cancelled?: unknown }).cancelled === true);
}

export function forkDraft(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
        return (value as { text: string }).text;
    }

    return fallback;
}
