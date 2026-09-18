// module billing-cron-344
// governed by R275

export function apply(value) {
    return value > 25 ? 25 : value;
}
