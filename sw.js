const CACHE = 'nexus-roulette-v152';
const CACHE_PREFIX = 'nexus-roulette-';
// './' is the manifest's start_url — the URL an installed app actually launches.
// Both it and index.html are REQUIRED, so activation can never delete a populated
// older cache and leave the launch URL unservable offline.
const REQUIRED = ['./','./index.html'];
const OPTIONAL = ['./manifest.json','./icon.svg'];

// Everything this worker is allowed to touch lives under its own scope. Absolute,
// so the comparison below is not fooled by a relative URL.
const SCOPE_URL = new URL('./', self.location).href;

// Absolute, because Response.redirect() resolves against the worker's base.
const LOGIN_URL = new URL('/connect.html?next=%2Froulette%2F', self.location.origin).href;

// ---------------------------------------------------------------------------
// THE STAFF GATE (fixed 2026-08-29)
//
// /roulette/ sits behind an nginx auth_request gate that splits deliberately on
// Sec-Fetch-Mode: a navigation gets 302 /connect.html?next=/roulette/, anything
// else gets a bare 401 — so an installed PWA's manifest and worker are never
// handed an HTML login page, which would break the install.
//
// MEASURED: this worker forwarded navigations as fetch(e.request, {cache:'no-store'}).
// A non-empty init rebuilds the Request, and a script-built request cannot carry
// mode "navigate" (Fetch downgrades it to "same-origin"). So every navigation the
// worker handled arrived at nginx looking like a subresource — the access log
// shows GET /roulette/ answering 401 with Referer .../roulette/sw.js — and an
// expired session rendered a dead "401 Authorization Required" with no route to
// Connect. A private window, which has no worker registered, was the only way in.
//
// The rules that keep it fixed:
//   1. Forward a navigation's e.request UNTOUCHED, so the mode survives to nginx.
//   2. Convert a gate denial to the Connect redirect ONLY for a real navigation.
//      A script's fetch() must still receive the honest 401 the gate contract
//      promises — handing it login HTML is the failure the split exists to avoid.
//   3. Cache only a same-origin, in-scope, non-redirected, ok response. Cache.put,
//      unlike add/addAll, will happily store a 401, and a followed 302 to a login
//      page arrives as a perfectly ok 200.
//   4. Do not intercept anything outside this scope at all. Caching authenticated
//      third-party replies could serve one account's private data to the next.
//
// KNOWN LIMIT, deliberate: a client still running the OLD worker cannot heal from
// inside the app. Its sw.js update request is a non-navigation, so an expired
// session 401s it and this file never installs. Recovery is to sign in to Connect
// in a normal tab and reopen the app once — which works where the browser and the
// installed app share a cookie jar (Chrome/Android, desktop). An iOS Home Screen
// app does NOT share Safari's storage after install, so there the recovery is to
// reinstall it. Removing that step needs /roulette/sw.js served ungated, which is
// an nginx routing decision, not this file's.
// ---------------------------------------------------------------------------

// Cache.add() would be shorter, but it FOLLOWS redirects: a gate that 302s a
// subresource would precache the login page under the app's own URL. redirect:
// 'error' makes that a rejection instead, and the same predicate as keep() applies.
function precache(c, path) {
  return fetch(new Request(path, { redirect: 'error' })).then(r => {
    if (!r.ok || r.redirected || r.type !== 'basic') throw new Error('precache refused: ' + path);
    return c.put(path, r);
  });
}

self.addEventListener('install', e => {
  // REQUIRED failing must fail the install, leaving the previous worker — and its
  // populated cache — in charge. Activating with an empty cache would delete a
  // working offline copy and replace it with nothing. OPTIONAL assets are allowed
  // to fail so one gated or missing icon cannot cost us the install; the runtime
  // miss path below repairs them on the next successful fetch.
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(REQUIRED.map(f => precache(c, f)))
        .then(() => Promise.all(OPTIONAL.map(f => precache(c, f).catch(() => null))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Prefix-scoped: this origin hosts more than this app, so never delete a cache
  // that is not ours. Also how a poisoned entry under an older name is destroyed.
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;

  if (req.method !== 'GET') return;                 // cache.put rejects non-GET
  if (!req.url.startsWith(SCOPE_URL)) return;       // rule 4 — external requests untouched

  // Never cache version.json — always fetch fresh for update detection. The app
  // appends ?t=Date.now(), which is what actually defeats the HTTP cache.
  if (req.url.includes('version.json')) {
    e.respondWith(fetch(req));
    return;
  }

  const isNavigation = req.mode === 'navigate';
  const isDocument = isNavigation || req.url.endsWith('.html') || req.url.endsWith('/');

  // rule 3. type 'basic' is same-origin and not opaque; redirected means the
  // response we are holding is whatever the redirect landed on, not what was asked
  // for — a gate that 302s a subresource would otherwise cache the login page.
  const keep = r => {
    if (!r || !r.ok || r.redirected || r.type !== 'basic') return r;
    const copy = r.clone();
    e.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}));
    return r;
  };

  if (isDocument) {
    e.respondWith(
      // A navigation is forwarded untouched (rule 1). Only a worker-initiated
      // document fetch, which has no navigate mode to lose, may bypass the HTTP
      // cache with an init object.
      (isNavigation ? fetch(req) : fetch(req, { cache: 'no-store' }))
        .then(r => {
          if (isNavigation && (r.status === 401 || r.status === 403)) {
            return Response.redirect(LOGIN_URL, 302);   // rule 2
          }
          return keep(r);
        })
        // Offline. Fall back through the launch URL and the shell rather than
        // only the exact request, so a deep link still renders the app.
        .catch(() => caches.open(CACHE).then(c =>
          c.match(req)
            .then(hit => hit || c.match(REQUIRED[0]))
            .then(hit => hit || c.match(REQUIRED[1]))
            .then(hit => hit || Response.error())
        ))
    );
    return;
  }

  // Cache-first, then fill on a miss so a partial install repairs itself. Scoped
  // to our own cache: the global caches.match() searches every cache on the
  // origin and validates no status.
  e.respondWith(
    caches.open(CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(keep)))
  );
});
