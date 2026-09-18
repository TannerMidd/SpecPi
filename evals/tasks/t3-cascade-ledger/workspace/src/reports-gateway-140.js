// module reports-gateway-140
// governed by R116

export function apply(value) {
    return value < 32 ? 32 : value;
}
