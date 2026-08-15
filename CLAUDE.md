# Nexus Roulette — agent guide

Single-page React roulette tracker. No bundler, no `package.json`, no CI: `nexus-src/build.js`
concatenates `nexus-src/src/*` and inlines React 18 UMD into one self-contained `index.html` at
the repo root, which is what ships.

## Deploying

**Use `./deploy.sh`. Do not hand-roll tar/ssh/scp.**

```sh
./deploy.sh --check     # every preflight, ships nothing — run this first
./deploy.sh --prod      # staff-gated nexus-foundry.ai/roulette/
./deploy.sh --mirror    # public GitHub Pages friend mirror
./deploy.sh --all       # both, production first
```

It must be run from the repo root on `main` with a clean tree. It will refuse to ship a stale
bundle, a broken version lockstep, or new bytes under an old version, and it verifies md5 per
artifact on the server afterwards. Full behaviour: `docs/DEPLOYMENT-MAP.md`, which is the living
map — **update it whenever a surface, path or mechanism changes.**

Deployed artifact set, exactly these and nothing else:
`index.html`, `sw.js`, `manifest.json`, `version.json`, `icon.svg`.

## Building

```sh
npm install --no-save --prefix . react@18 react-dom@18 @babel/core @babel/preset-react @babel/preset-env
node nexus-src/build.js
```

There is deliberately no `package.json`, which has two consequences that bite silently:

- Pass `--prefix .` or npm walks up and installs into a parent directory; the build then fails on
  a missing `node_modules/react/umd/react.production.min.js`.
- List every package in **one** `--no-save` command. A second `--no-save` install prunes the
  packages from the first (no manifest to remember them) and quietly breaks the next build.

Never commit `index.html` without rebuilding it — `deploy.sh` blocks on a bundle that does not
reproduce from source, and that block is the last line of defence against shipping stale code.

## Version lockstep — all three, every release

1. `APP_VERSION` in `nexus-src/src/constants.js`, plus a `CHANGELOG` entry in the same file
2. `version.json` at the repo root — the in-app update poller compares this against `APP_VERSION`
3. `CACHE` name in `sw.js`

A mismatch between 1 and 2 causes a spurious update banner and reload loop for every user.
Shipping changed content without moving 2 and 3 means no client ever picks the update up.
`deploy.sh` checks all of this before it uploads.

## Line endings

`.gitattributes` pins `* text=auto eol=lf`. **Leave it alone.** The deploy tars the working tree
verbatim, so on Git for Windows (`core.autocrlf=true` by default) a CRLF checkout would ship an
`index.html` of 603,306 bytes against 589,736 committed — a bundle nobody committed, whose md5
can never match. Production was doing exactly this until 2026-08-14. `deploy.sh` now asserts an
LF checkout before it tars anything.

If a checkout ever comes out CRLF anyway: `git rm --cached -r -q . && git reset --hard`.

## Branch flow (GIT-WORKFLOW-SPEC)

`feature/<name>` → `develop` → `main`. `main` is production and only fast-forwards from `develop`
on operator promotion. Push, never merely commit. Commit trailer required:

```
Co-Authored-By: <Agent> <slug@nexus-foundry.ai>
```

## Auth gate

Production is staff-only: nginx `auth_request` against the Connect session cookie
(`nvc_connect_session`), sub-requesting `/api/connect/whoami` on the NVC API (:3002). The GitHub
Pages mirror is public **on purpose** — the operator's friend uses that link — so never assume a
change to this repo is staff-visible only.

As of 2026-08-14 the gate returns `401`, not the `302` to `/connect.html` that
`docs/DEPLOYMENT-MAP.md` describes; access is denied either way, but staff without a live session
get a bare 401 instead of the login page. See the map for the nginx directive that restores it.
