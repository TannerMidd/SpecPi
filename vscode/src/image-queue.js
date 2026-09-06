"use strict";

const { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, MAX_IMAGE_COUNT } = require("./images.js");
const { createHash } = require("node:crypto");

const MAX_TEXT_CHARS = 64 * 1024;
const MAX_FORMATTED_CHARS = 2 * 1024 * 1024;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function validId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
}

function label(value, fallback, maximum = 256) {
    return typeof value === "string"
        ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, maximum)
        : fallback;
}

function snapshotAttachment(attachment, id, index) {
    if (!attachment || typeof attachment !== "object") {
        throw new Error("An image queue attachment is invalid.");
    }

    const common = {
        id: validId(attachment.id) ? attachment.id : `${id.slice(0, 110)}-attachment-${index}`,
        label: label(attachment.label, "Attachment", 1_024),
        detail: label(attachment.detail, "", 512),
    };
    if (attachment.kind !== "image") {
        if (typeof attachment.text !== "string" || Buffer.byteLength(attachment.text, "utf8") > MAX_TEXT_CHARS) {
            throw new Error("Queued file context must contain no more than 64 KiB per attachment.");
        }

        return Object.freeze({ ...common, text: attachment.text });
    }

    const { data, mimeType, byteLength, width, height } = attachment;
    // The host validates image containers before enqueueing. Check only scalar
    // metadata and encoded size here; do not decode the same image a second time.
    const padding = typeof data === "string" ? (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) : 0;
    if (
        typeof data !== "string" ||
        !data.length ||
        data.length % 4 !== 0 ||
        !MIME_TYPES.has(mimeType) ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength > MAX_IMAGE_BYTES ||
        (data.length / 4) * 3 - padding !== byteLength ||
        !Number.isSafeInteger(width) ||
        width < 1 ||
        !Number.isSafeInteger(height) ||
        height < 1
    ) {
        throw new Error("Queued images must already be validated and contain no more than 5 MiB each.");
    }

    return Object.freeze({
        ...common,
        kind: "image",
        type: "image",
        data,
        mimeType,
        byteLength,
        width,
        height,
        ...(typeof attachment.name === "string" ? { name: label(attachment.name, "Image") } : {}),
    });
}

function draft(snapshot) {
    return Object.freeze({ id: snapshot.id, text: snapshot.text, attachments: snapshot.attachments });
}

function recoveryFingerprint(snapshot) {
    const hash = createHash("sha256");
    const append = (value) => hash.update(`${value.length}:`).update(value);
    append(snapshot.text);
    for (const attachment of snapshot.attachments) {
        append(attachment.kind === "image" ? "image" : "text");
        if (attachment.kind === "image") {
            append(attachment.mimeType);
            append(attachment.data);
        } else {
            append(attachment.label);
            append(attachment.text);
        }
    }

    return hash.digest("hex");
}

/**
 * Retains only this chat's explicitly sent image prompts in memory. Pi's
 * clear_queue response contains text without images, so recovery uses exact text
 * and FIFO order after observed user-message events consume matching images.
 * A partially cleared group with identical text and different image/file context
 * cannot be identified safely; only its returned text is available for recovery.
 * Unmatched pending entries may already be running; they are dropped rather than
 * presented for a resend whose acceptance cannot be verified.
 */
class ImageQueue {
    #pending = [];
    #recovered = [];
    #consumed = new Set();
    #consumedMessages = new WeakSet();

    get pending() {
        return Object.freeze([...this.#pending]);
    }

    get recovered() {
        return Object.freeze(this.#recovered.map(draft));
    }

    track({ id, text, message, attachments } = {}) {
        if (
            !validId(id) ||
            this.#pending.some((entry) => entry.id === id) ||
            this.#recovered.some((entry) => entry.id === id)
        ) {
            throw new Error("Each queued image prompt needs a unique identifier.");
        }

        if (
            typeof text !== "string" ||
            text.length > MAX_TEXT_CHARS ||
            typeof message !== "string" ||
            message.length > MAX_FORMATTED_CHARS
        ) {
            throw new Error("The queued image prompt exceeds its text limit.");
        }

        if (
            !Array.isArray(attachments) ||
            attachments.length > MAX_IMAGE_COUNT ||
            !attachments.some((attachment) => attachment?.kind === "image")
        ) {
            throw new Error("Track a prompt containing images and no more than eight attachments.");
        }

        const copies = Object.freeze(attachments.map((attachment, index) => snapshotAttachment(attachment, id, index)));
        const allImages = [...this.#pending, ...this.#recovered]
            .flatMap((entry) => entry.attachments)
            .concat(copies)
            .filter((attachment) => attachment.kind === "image");
        if (
            allImages.length > MAX_IMAGE_COUNT ||
            allImages.reduce((sum, image) => sum + image.byteLength, 0) > MAX_IMAGE_TOTAL_BYTES
        ) {
            throw new Error(
                "Pending and recovered image prompts can retain at most eight images and 20 MiB. Restore or dismiss a recovered draft before queueing more images.",
            );
        }

        const snapshot = Object.freeze({ id, text, message, attachments: copies });
        this.#pending.push(snapshot);

        return snapshot;
    }

    consume(messageEvent) {
        const message = messageEvent?.message ?? messageEvent;
        if (message?.role !== "user" || !Array.isArray(message.content)) {
            return false;
        }

        const textParts = message.content.filter((part) => part?.type === "text");
        if (textParts.some((part) => typeof part.text !== "string")) {
            return false;
        }

        const text = textParts.map((part) => part.text).join("\n");
        const images = message.content.filter((part) => part?.type === "image");
        if (!images.length) {
            return false;
        }

        const index = this.#pending.findIndex((entry) => {
            if (entry.message !== text) {
                return false;
            }

            const expected = entry.attachments.filter((attachment) => attachment.kind === "image");

            return (
                expected.length === images.length &&
                expected.every(
                    (image, imageIndex) =>
                        image.data === images[imageIndex].data && image.mimeType === images[imageIndex].mimeType,
                )
            );
        });
        if (index === -1) {
            return false;
        }

        if (this.#consumedMessages.has(message)) {
            return false;
        }

        if (Number.isSafeInteger(message.timestamp) && message.timestamp >= 0) {
            const hash = createHash("sha256").update(`${message.timestamp}\0`).update(text);
            for (const image of images) {
                hash.update("\0").update(image.mimeType).update("\0").update(image.data);
            }

            const key = hash.digest("hex");
            if (this.#consumed.has(key)) {
                return false;
            }

            this.#consumed.add(key);
            if (this.#consumed.size > 64) {
                this.#consumed.delete(this.#consumed.values().next().value);
            }
        }

        this.#consumedMessages.add(message);

        this.#pending.splice(index, 1);

        return true;
    }

    discard(id) {
        const count = this.#pending.length + this.#recovered.length;
        this.#pending = this.#pending.filter((entry) => entry.id !== id);
        this.#recovered = this.#recovered.filter((entry) => entry.id !== id);

        return count !== this.#pending.length + this.#recovered.length;
    }

    clear() {
        this.#pending = [];
        this.#recovered = [];
        this.#consumed.clear();
        this.#consumedMessages = new WeakSet();
    }

    recover(queue) {
        const drafts = [];
        const remainingTexts = [];
        if (queue && Array.isArray(queue.steering) && Array.isArray(queue.followUp)) {
            const cleared = [...queue.steering, ...queue.followUp].filter((text) => typeof text === "string");
            const groups = new Map();
            for (const snapshot of this.#pending) {
                if (!groups.has(snapshot.message)) {
                    groups.set(snapshot.message, []);
                }

                groups.get(snapshot.message).push(snapshot);
            }

            const ambiguous = new Set();
            for (const [text, snapshots] of groups) {
                const count = cleared.filter((value) => value === text).length;
                if (count > 0 && count < snapshots.length && new Set(snapshots.map(recoveryFingerprint)).size > 1) {
                    ambiguous.add(text);
                }
            }

            for (const text of cleared) {
                if (ambiguous.has(text)) {
                    remainingTexts.push(text);

                    continue;
                }

                const index = this.#pending.findIndex((entry) => entry.message === text);
                if (index === -1) {
                    remainingTexts.push(text);

                    continue;
                }

                const [snapshot] = this.#pending.splice(index, 1);
                this.#recovered.push(snapshot);
                drafts.push(draft(snapshot));
            }
        }

        const droppedCount = this.#pending.length;
        this.#pending = [];

        return { drafts, remainingTexts, droppedCount };
    }
}

module.exports = { ImageQueue };
