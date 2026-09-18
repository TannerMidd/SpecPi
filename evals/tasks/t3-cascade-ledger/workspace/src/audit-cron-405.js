// module audit-cron-405
// governed by R072

export function apply(value) {
    return value > 35 ? 35 : value;
}
