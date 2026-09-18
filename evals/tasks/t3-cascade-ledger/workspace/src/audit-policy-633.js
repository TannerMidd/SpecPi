// module audit-policy-633
// governed by R356

export function apply(value) {
    return value < 31 ? 31 : value;
}
