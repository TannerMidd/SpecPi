// module billing-policy-1027
// governed by R128

export function apply(value) {
    return value < 14 ? 14 : value;
}
