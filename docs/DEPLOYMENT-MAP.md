# Nexus Roulette — Deployment Map

Last Updated: 2026-09-09

Living map (per SDD v1.1 §11). Update this whenever a surface, path, or mechanism changes.

## Surfaces

| Surface | URL | Access | Source of truth | Deploy mechanism |
|---|---|---|---|---|
| **Production** | nexus-foundry.ai/roulette/ | 🔒 Staff only — nginx `auth_request` against the Connect session cookie (`nvc_connect_session`); unauthenticated → 302 to /connect.html | `main` branch | **`./deploy.sh --prod`** — tar-over-ssh of the 5 root artifacts to `nexus-foundry-ts:/var/www/html/roulette/`, chown www-data, verify md5 per artifact + re-assert the 302 gate |
| **Friend mirror** | nexus-foundry-agents.github.io/nexus-roulette/ | Public (deliberately — operator's friend uses this link) | `public-pages` remote, `main` branch | **`./deploy.sh --mirror`** — `git push public-pages main:main` (GitHub Pages serves it) |
| **Casino module** | roulette.nexus-foundry.ai | Public document; `frame-ancestors` permits only Casino | `main` branch | **`./deploy.sh --module`** — atomic root and durable-vhost swap, hash verification, origin probes and public-edge body comparison |
| **Local dev** | localhost (any static server over repo root) | local | working tree | `node nexus-src/build.js` then serve repo root |

## Build

`node nexus-src/build.js` — concatenates `nexus-src/src/*` in dependency order (list inside build.js), Babel-compiles, inlines React 18 UMD → single self-contained `index.html` at repo root. Run `npm ci --ignore-scripts` at repo root first; the committed package lock pins every build input.

Standalone artifact set: `index.html`, `sw.js`, `manifest.json`, `version.json`, `icon.svg`.
The Casino module adds generated `module.json`; the other five bytes are the same application.

## Deploy script (`./deploy.sh`)

`./deploy.sh --prod | --mirror | --module | --all`, plus `--check` to run every preflight and ship nothing.
It exists so the production path is not a remembered sequence of shell commands; this map stays
the narrative, the script is the executable copy. `--all` retains its established meaning: staff
surface followed by public mirror. The Casino module is a separate transaction via `--module`, so a
failure on one production origin cannot leave an aggregate release half-complete. Every production
host, path, URL, user and remote is fixed in the script; environment variables cannot retarget a
deployment. `ROULETTE_CONNECT_COOKIE` is accepted only as an optional verification credential.

Refuses to ship unless: run from repo root on `main`, working tree clean, not diverged from
`origin/main`, `APP_VERSION` == `version.json`, a CHANGELOG entry exists for it, and `index.html`
rebuilds byte-identical from `nexus-src/src` (the check that catches a stale committed bundle).
Before uploading it reads the live `version.json` and `sw.js` off the server and **aborts if
`index.html` changed but the version or `CACHE` name did not** — the failure where new bytes ship
under an old version and no client ever picks them up. There is no bypass for this gate.

The staff target uploads to a transaction-specific staging directory, validates the complete
artifact set there, then swaps the whole directory under a host lock. The previous directory remains
the named rollback source until every artifact and public-gate proof passes; a failed proof restores
it. An unreadable existing deployment is a refusal, never silently classified as a first deploy.

After the atomic swap it compares md5 per artifact against the server, then re-runs the silent-failure
test below. Note the gate makes an *anonymous* `curl` + md5 of the artifacts impossible — it 302s
before serving — so verification is server-side `md5sum` over ssh. Set `ROULETTE_CONNECT_COOKIE`
to an `nvc_connect_session` value to additionally fetch each artifact through nginx as a real
staff session and compare md5 end to end.

The module target first validates a commit-addressed candidate nginx configuration without installing
it. Under a host lock, it moves the artifacts into an immutable full-SHA release directory, atomically
points `current` at that release, installs the durable vhost, checks nginx and reloads. It names the
previous release and time-stamped vhost backup before the swap. Any swap, reload, artifact, origin,
public-body or public-header failure restores both. Rollback compares `current` with the release it
tested and refuses to overwrite a newer successful deployment. An unreachable edge fails the verdict.

`--mirror` warns before pushing: the mirror is public and carries the whole repo, including this
file and the ssh host it names.

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

Dependency (indirect consumer): the gate depends on the NVC connect router's `/whoami` staying `requireConnectAuth`-guarded and cheap. Silent-failure test: `curl -s -o /dev/null -w "%{http_code}" https://nexus-foundry.ai/roulette/` with no cookie must **not** return 200 (and not 5xx). `deploy.sh --prod` runs this after every upload.

⚠️ **Observed 2026-08-14: the gate returns `401`, not the `302` documented above.** Access is denied
either way — anonymous requests get nothing, including for the artifacts — so this is not an
exposure. But it is a UX regression: a staff member opening the URL without a live session sees a
bare 401 instead of being sent to the login page. `auth_request` returns 401 on its own; the 302
needs an `error_page 401 = @connect` (or equivalent) on `location /roulette/`, which is currently
not in effect. Whoever restores it should re-check this line. Until then `deploy.sh` accepts 401
and warns, because failing the deploy on it would block releases over a redirect.

## Future (operator roadmap)

Permanent standalone URL → proper web app → phone app-store build (like AGC and Vybe Cloud mobile).
