// Minimal service worker.
//
// It exists so the page is installable to a home screen, and it deliberately
// caches nothing. Every response here is either authenticated or live agent
// state: a cache would serve stale transcripts, and it would persist
// authenticated content to disk on the phone. Network-only is the honest
// behaviour, and the cost is that the app does not work offline — which it
// could not do anyway, since the agent is on the other end of a tunnel.

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
    // No respondWith: the request falls through to the network untouched.
});
