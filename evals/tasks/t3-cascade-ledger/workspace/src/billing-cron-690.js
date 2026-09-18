// module billing-cron-690
// governed by R348

export function apply(value) {
    return value < 31 ? 31 : value;
}
