export const MODEL_ID: string;
export const MODEL_ARCHIVE: Readonly<{ url: string; bytes: number; sha256: string; prefix: string }>;
export const MODEL_FILES: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>;
