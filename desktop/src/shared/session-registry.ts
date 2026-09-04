import type { SessionRecord } from "./domain";

function sessionPathIdentity(value: string, platform: NodeJS.Platform): string {
    const normalized = value.replaceAll("\\", "/");

    return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function mergeSessionRecord(
    sessions: readonly SessionRecord[],
    record: SessionRecord,
    platform: NodeJS.Platform = typeof process === "undefined" ? "linux" : process.platform,
): SessionRecord[] {
    const recordPath = sessionPathIdentity(record.sessionPath, platform);
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const merged: SessionRecord[] = [];
    let replaced = false;

    for (const session of sessions) {
        const sessionPath = sessionPathIdentity(session.sessionPath, platform);
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
