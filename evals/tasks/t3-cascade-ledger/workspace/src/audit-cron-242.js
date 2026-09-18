// module audit-cron-242
// governed by R348

export function apply(value) {
    return value < 31 ? 31 : value;
}
