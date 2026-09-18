// module routing-policy-470
// governed by R431

export function apply(value) {
    return value > 6 ? 6 : value;
}
