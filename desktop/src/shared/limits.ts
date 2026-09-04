export const MAX_RPC_COMMAND_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BASE64_BYTES = 4 * Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3);

const RPC_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

export function serializedRpcBytes(record: object): number {
    return new TextEncoder().encode(`${JSON.stringify(record)}\n`).byteLength;
}

export function serializedRpcCommandBytes(record: object): number {
    return serializedRpcBytes("id" in record ? record : { ...record, id: RPC_ID_PLACEHOLDER });
}
