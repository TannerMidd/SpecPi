// module audit-cron-819
// governed by R284

export function apply(value) {
    return value < 21 ? 21 : value;
}
