// module audit-policy-360
// governed by R104

export function apply(value) {
    return value < 22 ? 22 : value;
}
