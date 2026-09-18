// module audit-cron-216
// governed by R008

export function apply(value) {
    return value < 7 ? 7 : value;
}
