# Nexus Roulette — Deployment Map

Living map (per SDD v1.1 §11). Update this whenever a surface, path, or mechanism changes.

## Surfaces

| Surface | URL | Access | Source of truth | Deploy mechanism |
|---|---|---|---|---|
| **Production** | nexus-foundry.ai/roulette/ | 🔒 Staff only — nginx `auth_request` against the Connect session cookie (`nvc_connect_session`); unauthenticated → 302 to /connect.html | `main` branch | tar-over-ssh of the 5 root artifacts to `nexus-foundry-ts:/var/www/html/roulette/`, chown www-data, verify cache-busted curl + md5 vs local |
| **Friend mirror** | nexus-foundry-agents.github.io/nexus-roulette/ | Public (deliberately — operator's friend uses this link) | `public-pages` remote, `main` branch | `git push public-pages main:main` (GitHub Pages serves it) |
| **Local dev** | localhost (any static server over repo root) | local | working tree | `node nexus-src/build.js` then serve repo root |

## Build

`node nexus-src/build.js` — concatenates `nexus-src/src/*` in dependency order (list inside build.js), Babel-compiles, inlines React 18 UMD → single self-contained `index.html` at repo root. Requires `npm install --no-save react@18 react-dom@18 @babel/core @babel/preset-react @babel/preset-env` at repo root (gitignored; no package.json by design).

Deployed artifact set (exactly these, nothing else): `index.html`, `sw.js`, `manifest.json`, `version.json`, `icon.svg`.

## Version lockstep (all three, every release)

1. `APP_VERSION` in `nexus-src/src/constants.js` (+ a CHANGELOG entry)
2. `version.json` at repo root (the update poller compares against APP_VERSION)
3. `CACHE` name in `sw.js`

A mismatch between 1 and 2 causes a spurious update banner/reload loop.

## Branch flow (GIT-WORKFLOW-SPEC)

`feature/<name>` → `develop` → `main`. `main` is production and only fast-forwards from `develop` on operator promotion. Commit trailer `Co-Authored-By: <Agent> <slug@nexus-foundry.ai>` required; push, never merely commit.

## Auth gate (since 2026-07-25)

nginx (`/etc/nginx/nvc-sites/nexus-foundry.conf` — durable include, NEVER the global nginx.conf):
`location /roulette/` carries `auth_request /_roulette_auth`, which sub-requests `GET /api/connect/whoami` on the NVC API (:3002) with the browser's cookies. Valid Connect staff session → 200, serve; otherwise → 302 `/connect.html`. The GitHub Pages mirror is intentionally ungated.

Dependency (indirect consumer): the gate depends on the NVC connect router's `/whoami` staying `requireConnectAuth`-guarded and cheap. Silent-failure test: `curl -s -o /dev/null -w "%{http_code}" https://nexus-foundry.ai/roulette/` with no cookie must return 302 (not 200, not 500).

## Future (operator roadmap)

Permanent standalone URL → proper web app → phone app-store build (like AGC and Vybe Cloud mobile).
