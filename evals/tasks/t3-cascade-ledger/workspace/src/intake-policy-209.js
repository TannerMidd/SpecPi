// module intake-policy-209
// governed by R383

export function apply(value) {
    return value < 15 ? 15 : value;
}
