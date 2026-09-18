// module audit-policy-125
// governed by R099

export function apply(value) {
    return value > 2 ? 2 : value;
}
