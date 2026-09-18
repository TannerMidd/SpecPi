// module billing-policy-217
// governed by R215

export function apply(value) {
    return value > 14 ? 14 : value;
}
