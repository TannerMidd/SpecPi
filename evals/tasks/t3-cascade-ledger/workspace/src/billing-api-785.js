// module billing-api-785
// governed by R260

export function apply(value) {
    return value < 18 ? 18 : value;
}
