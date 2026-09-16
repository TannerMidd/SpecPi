import test from "node:test";
import assert from "node:assert/strict";
import { TokenAuth, readCookie, COOKIE_NAME } from "../src/auth.js";

function request(headers = {}) {
    return { headers };
}

test("generates a token when none is supplied", () => {
    const auth = new TokenAuth();
    assert.equal(typeof auth.token, "string");
    assert.ok(auth.token.length >= 32);
});

test("accepts the matching token and rejects everything else", () => {
    const auth = new TokenAuth({ token: "correct-token" });
    assert.equal(auth.matches("correct-token"), true);
    assert.equal(auth.matches("wrong-token"), false);
    assert.equal(auth.matches("correct-token-with-suffix"), false);
    assert.equal(auth.matches(""), false);
    assert.equal(auth.matches(undefined), false);
    assert.equal(auth.matches(null), false);
});

test("a length mismatch is rejected rather than throwing", () => {
    // timingSafeEqual throws on unequal lengths; the guard must come first.
    const auth = new TokenAuth({ token: "short" });
    assert.doesNotThrow(() => auth.matches("a-much-longer-candidate"));
    assert.equal(auth.matches("a-much-longer-candidate"), false);
});

test("authenticates from a bearer header", () => {
    const auth = new TokenAuth({ token: "tok" });
    const result = auth.authenticate(request({ authorization: "Bearer tok" }), new URL("http://x/"));
    assert.deepEqual(result, { ok: true, source: "header" });
});

test("authenticates from a cookie", () => {
    const auth = new TokenAuth({ token: "tok" });
    const result = auth.authenticate(request({ cookie: `${COOKIE_NAME}=tok` }), new URL("http://x/"));
    assert.deepEqual(result, { ok: true, source: "cookie" });
});

test("authenticates from the pairing query parameter", () => {
    const auth = new TokenAuth({ token: "tok" });
    const result = auth.authenticate(request(), new URL("http://x/?t=tok"));
    assert.deepEqual(result, { ok: true, source: "query" });
});

test("rejects a request carrying nothing", () => {
    const auth = new TokenAuth({ token: "tok" });
    assert.equal(auth.authenticate(request(), new URL("http://x/")).ok, false);
});

test("rejects a wrong token from every source", () => {
    const auth = new TokenAuth({ token: "tok" });
    assert.equal(auth.authenticate(request({ authorization: "Bearer no" }), new URL("http://x/")).ok, false);
    assert.equal(auth.authenticate(request({ cookie: `${COOKIE_NAME}=no` }), new URL("http://x/")).ok, false);
    assert.equal(auth.authenticate(request(), new URL("http://x/?t=no")).ok, false);
});

test("rotating invalidates the previous token", () => {
    const auth = new TokenAuth({ token: "first" });
    auth.rotate();
    assert.equal(auth.matches("first"), false);
    assert.equal(auth.matches(auth.token), true);
});

test("the cookie is HttpOnly and SameSite=Strict", () => {
    const auth = new TokenAuth({ token: "tok" });
    const header = auth.cookieHeader();
    assert.match(header, /HttpOnly/u);
    assert.match(header, /SameSite=Strict/u);
});

test("readCookie picks the right entry out of several", () => {
    assert.equal(readCookie(`other=1; ${COOKIE_NAME}=wanted; third=3`, COOKIE_NAME), "wanted");
    assert.equal(readCookie("other=1", COOKIE_NAME), null);
    assert.equal(readCookie(undefined, COOKIE_NAME), null);
});
