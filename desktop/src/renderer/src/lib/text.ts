const ANSI_PATTERN =
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;

export function stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, "");
}

export function safeJson(value: unknown, maxLength = 50_000): string {
    try {
        return stripAnsi(JSON.stringify(value, null, 2)).slice(0, maxLength);
    } catch {
        return "[Unserializable value]";
    }
}
