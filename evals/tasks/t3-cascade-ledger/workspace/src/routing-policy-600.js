// module routing-policy-600
// governed by R388

export function apply(value) {
    return value < 11 ? 11 : value;
}
