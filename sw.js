const CACHE = 'nexus-roulette-v132';
const FILES = ['./','./index.html','./manifest.json','./icon.svg'];

// Where a gate denial sends the user. Absolute, because Response.redirect() parses
// against the worker's base rather than the page's.
const LOGIN_URL = new URL('/connect.html?next=%2Froulette%2F', self.location.origin).href;

// ---------------------------------------------------------------------------
// THE STAFF GATE, AND WHY THIS FILE IS CAREFUL (fixed 2026-08-29)
//
// /roulette/ sits behind an nginx auth_request gate. By design that gate only
// redirects requests it can SEE as navigations — it tests Sec-Fetch-Mode:
// navigate — so an installed PWA's manifest and service worker receive an honest
// 401 rather than an HTML login page, which would break the install.
//
// This worker used to forward navigations as fetch(e.request, {cache:'no-store'}).
// Passing an init object REBUILDS the Request, and a script-built request can
// never carry mode "navigate". So every navigation the worker handled reached
// nginx looking like a subresource and came back a bare 401 — and the result was
// written straight into the cache, which made the lockout outlive the session.
// Signing in changed nothing; only a private window, with no worker registered,
// could open the app.
//
// Two rules keep that fixed, and both are load-bearing:
//   1. Forward e.request UNTOUCHED, so the navigate mode survives to nginx.
//   2. NEVER cache a response that is not ok. A 401 in the cache is a lockout
//      that no amount of logging in can clear.
// The 401/403 handler is the belt to that pair of braces: if a denial reaches the
// worker anyway, send the user to Connect instead of rendering the refusal.
// ---------------------------------------------------------------------------

self.addEventListener('install', e => {
  // Per file, not addAll: addAll rejects the WHOLE install if any one file is
  // gated or missing, which would leave the previous worker in control exactly
  // when a session has expired — the moment we most need the new one.
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => null))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Also how a poisoned entry from an older cache name gets destroyed.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

function cacheIfOk(request, response) {
  if (!response || !response.ok) return;          // rule 2
  const clone = response.clone();
  caches.open(CACHE).then(c => c.put(request, clone)).catch(() => {});
}

self.addEventListener('fetch', e => {
  const req = e.request;

  // Never cache version.json — always fetch fresh for update detection.
  if (req.url.includes('version.json')) {
    e.respondWith(fetch(req));
    return;
  }

  const isDocument = req.mode === 'navigate' || req.url.endsWith('.html') || req.url.endsWith('/');

  if (isDocument) {
    e.respondWith(
      // No init object here. See rule 1 above — this is the whole bug.
      fetch(req).then(r => {
        if (r.status === 401 || r.status === 403) return Response.redirect(LOGIN_URL, 302);
        cacheIfOk(req, r);
        return r;
      }).catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
