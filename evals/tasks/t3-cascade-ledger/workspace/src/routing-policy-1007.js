// module routing-policy-1007
// governed by R575

export function apply(value) {
    return value < 21 ? 21 : value;
}
