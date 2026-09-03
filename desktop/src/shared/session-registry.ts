import type { SessionRecord } from "./domain";

function normalizedPath(value: string): string {
    return value.replaceAll("\\", "/").toLowerCase();
}

export function mergeSessionRecord(sessions: readonly SessionRecord[], record: SessionRecord): SessionRecord[] {
    const recordPath = normalizedPath(record.sessionPath);
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const merged: SessionRecord[] = [];
    let replaced = false;

    for (const session of sessions) {
        const sessionPath = normalizedPath(session.sessionPath);
        if (session.id === record.id || sessionPath === recordPath) {
            if (!replaced) {
                merged.push(record);
                seenIds.add(record.id);
                seenPaths.add(recordPath);
                replaced = true;
            }

            continue;
        }

        if (seenIds.has(session.id) || seenPaths.has(sessionPath)) {
            continue;
        }

        merged.push(session);
        seenIds.add(session.id);
        seenPaths.add(sessionPath);
    }

    if (!replaced) {
        merged.unshift(record);
    }

    return merged.slice(0, 2_000);
}
