import type { SessionRecord } from "../../../shared/domain";

function normalizedPath(value: string): string {
    return value.replaceAll("\\", "/").toLowerCase();
}

export function mergeSessionRecord(sessions: readonly SessionRecord[], record: SessionRecord): SessionRecord[] {
    const seenIds = new Set([record.id]);
    const seenPaths = new Set([normalizedPath(record.sessionPath)]);

    return [
        record,
        ...sessions.filter((session) => {
            const sessionPath = normalizedPath(session.sessionPath);
            if (seenIds.has(session.id) || seenPaths.has(sessionPath)) {
                return false;
            }

            seenIds.add(session.id);
            seenPaths.add(sessionPath);

            return true;
        }),
    ].slice(0, 2_000);
}
