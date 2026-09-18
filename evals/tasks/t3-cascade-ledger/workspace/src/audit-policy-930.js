// module audit-policy-930
// governed by R283

export function apply(value) {
    return value > 21 ? 21 : value;
}
