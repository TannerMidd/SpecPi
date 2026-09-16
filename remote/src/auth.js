// Pairing-token authentication. Single user, one token, rotatable.
//
// The token is generated in memory at daemon start and printed to the local
// console. It is never written to disk: the daemon holds no credential file to
// leak, and a restart simply issues a new token.

import { randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "specpi_remote";

export class TokenAuth {
    constructor({ token } = {}) {
        this.rotate(token);
    }

    rotate(token) {
        this.token = token || randomBytes(32).toString("base64url");
        this.tokenBytes = Buffer.from(this.token, "utf8");

        return this.token;
    }

    // Constant-time comparison. Length is compared first because
    // timingSafeEqual throws on a length mismatch, and a length difference is
    // not a secret worth protecting here.
    matches(candidate) {
        if (typeof candidate !== "string" || candidate.length === 0) {
            return false;
        }

        const candidateBytes = Buffer.from(candidate, "utf8");
        if (candidateBytes.length !== this.tokenBytes.length) {
            return false;
        }

        return timingSafeEqual(candidateBytes, this.tokenBytes);
    }

    // Accepts the token from a bearer header, a cookie, or a query parameter.
    // The query parameter exists only so a pairing link can be opened once on
    // the phone; the server immediately moves it into a cookie.
    authenticate(request, url) {
        const header = request.headers.authorization;
        if (typeof header === "string" && header.startsWith("Bearer ")) {
            if (this.matches(header.slice(7).trim())) {
                return { ok: true, source: "header" };
            }
        }

        const cookie = readCookie(request.headers.cookie, COOKIE_NAME);
        if (cookie && this.matches(cookie)) {
            return { ok: true, source: "cookie" };
        }

        const query = url?.searchParams.get("t");
        if (query && this.matches(query)) {
            return { ok: true, source: "query" };
        }

        return { ok: false, source: null };
    }

    cookieHeader() {
        // No Secure attribute: the daemon is plain HTTP behind a tunnel, and a
        // Secure cookie would simply never be sent back over an SSH forward.
        // Confidentiality comes from the tunnel, not from the cookie flag.
        return `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
    }
}

export function readCookie(header, name) {
    if (typeof header !== "string") {
        return null;
    }

    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) {
            continue;
        }

        if (part.slice(0, separator).trim() !== name) {
            continue;
        }

        return part.slice(separator + 1).trim();
    }

    return null;
}

export { COOKIE_NAME };
