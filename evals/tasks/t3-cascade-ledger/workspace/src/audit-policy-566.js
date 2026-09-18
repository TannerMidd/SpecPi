// module audit-policy-566
// governed by R288

export function apply(value) {
    return value < 14 ? 14 : value;
}
