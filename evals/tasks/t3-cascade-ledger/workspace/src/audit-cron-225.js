// module audit-cron-225
// governed by R344

export function apply(value) {
    return value < 32 ? 32 : value;
}
