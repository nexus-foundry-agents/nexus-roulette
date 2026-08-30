#!/usr/bin/env bash
#
# Nexus Roulette — deploy script
#
# Encodes docs/DEPLOYMENT-MAP.md so the production path is not a sequence of
# remembered shell commands. Two surfaces:
#
#   --prod    tar-over-ssh the 5 artifacts to the staff-gated production host
#   --mirror  git push public-pages main:main (public GitHub Pages friend mirror)
#
# Everything is checked before anything is shipped: version lockstep, a
# byte-identical rebuild of index.html from nexus-src/src, and a clean tree on
# main. After a production deploy it verifies md5 per artifact on the server and
# re-asserts the auth gate still 302s an anonymous request.
#
# Usage: ./deploy.sh --prod | --mirror | --all [--check] [--skip-build] [--yes]
#
set -euo pipefail

# ---------------------------------------------------------------- configuration

SSH_HOST="${ROULETTE_SSH_HOST:-nexus-foundry-ts}"
REMOTE_DIR="${ROULETTE_REMOTE_DIR:-/var/www/html/roulette}"
WEB_USER="${ROULETTE_WEB_USER:-www-data}"
PROD_URL="${ROULETTE_URL:-https://nexus-foundry.ai/roulette/}"
PAGES_REMOTE="${ROULETTE_PAGES_REMOTE:-public-pages}"
RELEASE_BRANCH="${ROULETTE_BRANCH:-main}"

# The deployed artifact set — exactly these, nothing else (DEPLOYMENT-MAP.md).
ARTIFACTS=(index.html sw.js manifest.json version.json icon.svg)

# ---------------------------------------------------------------------- plumbing

DO_PROD=0 DO_MIRROR=0 CHECK_ONLY=0 SKIP_BUILD=0 ASSUME_YES=0 FORCE=0

RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' BOLD=$'\033[1m' DIM=$'\033[2m' RESET=$'\033[0m'
[ -t 1 ] || { RED= GREEN= YELLOW= BOLD= DIM= RESET=; }

say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  # The banner comment above, up to the first line of actual code.
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
  cat <<EOF

Flags
  --prod         Deploy to production (${PROD_URL})
  --mirror       Push the public GitHub Pages mirror ("${PAGES_REMOTE}" remote)
  --all          Both, production first
  --check        Run every preflight check and stop — ships nothing
  --skip-build   Trust the committed index.html; skip the rebuild-and-compare
  --force        Downgrade the "version not bumped" abort to a warning
  -y, --yes      Do not prompt for confirmation
  -h, --help     This text

Environment overrides
  ROULETTE_SSH_HOST      (${SSH_HOST})
  ROULETTE_REMOTE_DIR    (${REMOTE_DIR})
  ROULETTE_WEB_USER      (${WEB_USER})
  ROULETTE_URL           (${PROD_URL})
  ROULETTE_PAGES_REMOTE  (${PAGES_REMOTE})
  ROULETTE_CONNECT_COOKIE
      Optional nvc_connect_session value. When set, production verification also
      fetches each artifact through nginx with that cookie and compares md5, which
      exercises the real staff path end to end rather than only the filesystem.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prod)       DO_PROD=1 ;;
    --mirror)     DO_MIRROR=1 ;;
    --all)        DO_PROD=1; DO_MIRROR=1 ;;
    --check)      CHECK_ONLY=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --force)      FORCE=1 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ $DO_PROD -eq 0 ] && [ $DO_MIRROR -eq 0 ]; then
  if [ $CHECK_ONLY -eq 1 ]; then
    :   # --check on its own is valid: preflight everything, target nothing
  else
    printf 'Nothing to do: pass --prod, --mirror, --all or --check.\n\n' >&2
    usage >&2
    exit 2
  fi
fi

confirm() {
  [ $ASSUME_YES -eq 1 ] && return 0
  if [ ! -t 0 ]; then
    die "Refusing to $1 without a terminal to confirm on (pass --yes to override)."
  fi
  local reply
  printf '%s%s?%s [y/N] ' "$BOLD" "$1" "$RESET"
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) die "Aborted." ;; esac
}

# md5sum on Linux and Git Bash, md5 -q on macOS. Prints the bare hash.
md5_of() {
  if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1
  elif command -v md5 >/dev/null 2>&1; then md5 -q "$1"
  else die "Need md5sum or md5 on PATH to verify the deploy."
  fi
}

# ------------------------------------------------------------------- preflight

cd "$(dirname "$0")"
ROOT="$(pwd)"

step "Preflight"

[ -f nexus-src/build.js ] || die "Run this from the repo root — nexus-src/build.js not found in $ROOT."

for tool in git node curl; do
  command -v "$tool" >/dev/null 2>&1 || die "Required tool not on PATH: $tool"
done
if [ $DO_PROD -eq 1 ]; then
  for tool in ssh tar; do
    command -v "$tool" >/dev/null 2>&1 || die "Required tool not on PATH: $tool"
  done
fi
ok "Toolchain present"

for f in "${ARTIFACTS[@]}"; do
  [ -f "$f" ] || die "Missing deploy artifact: $f"
done
ok "All ${#ARTIFACTS[@]} artifacts present"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "$RELEASE_BRANCH" ]; then
  if [ $DO_PROD -eq 1 ] || [ $DO_MIRROR -eq 1 ]; then
    die "On branch '$BRANCH', but production ships from '$RELEASE_BRANCH' only.
    ${DIM}Branch flow is feature/<name> → develop → $RELEASE_BRANCH (GIT-WORKFLOW-SPEC).${RESET}"
  fi
  warn "On branch '$BRANCH', not '$RELEASE_BRANCH' — checking it anyway."
else
  ok "On $RELEASE_BRANCH"
fi

if [ -n "$(git status --porcelain)" ]; then
  git status --short | sed 's/^/    /' >&2
  die "Working tree is dirty. Commit or stash before deploying — what ships must be what is committed."
fi
ok "Working tree clean"

git fetch --quiet origin "$RELEASE_BRANCH" 2>/dev/null || warn "Could not fetch origin/$RELEASE_BRANCH — skipping the sync check."
if git rev-parse --verify --quiet "origin/$RELEASE_BRANCH" >/dev/null; then
  LOCAL_SHA="$(git rev-parse HEAD)"
  REMOTE_SHA="$(git rev-parse "origin/$RELEASE_BRANCH")"
  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    if git merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA" 2>/dev/null; then
      warn "HEAD is ahead of origin/$RELEASE_BRANCH — push it, never merely commit (GIT-WORKFLOW-SPEC)."
    else
      die "HEAD has diverged from origin/$RELEASE_BRANCH. Reconcile before deploying."
    fi
  else
    ok "In sync with origin/$RELEASE_BRANCH"
  fi
fi

# ------------------------------------------------------------ version lockstep

step "Version lockstep"

APP_VERSION="$(sed -n 's/^const APP_VERSION = "\(.*\)";$/\1/p' nexus-src/src/constants.js | head -1)"
JSON_VERSION="$(node -e 'process.stdout.write(require("./version.json").version||"")')"
SW_CACHE="$(sed -n "s/^const CACHE = '\(.*\)';$/\1/p" sw.js | head -1)"
CHANGELOG_TOP="$(sed -n 's/^  { v:"\([^"]*\)".*/\1/p' nexus-src/src/constants.js | head -1)"

[ -n "$APP_VERSION" ]   || die "Could not read APP_VERSION from nexus-src/src/constants.js"
[ -n "$JSON_VERSION" ]  || die "Could not read version from version.json"
[ -n "$SW_CACHE" ]      || die "Could not read CACHE from sw.js"

say "    APP_VERSION      ${BOLD}${APP_VERSION}${RESET}   ${DIM}nexus-src/src/constants.js${RESET}"
say "    version.json     ${BOLD}${JSON_VERSION}${RESET}   ${DIM}update poller compares against APP_VERSION${RESET}"
say "    sw.js CACHE      ${BOLD}${SW_CACHE}${RESET}"
say "    CHANGELOG top    ${BOLD}${CHANGELOG_TOP:-<none>}${RESET}"

if [ "$APP_VERSION" != "$JSON_VERSION" ]; then
  die "APP_VERSION ($APP_VERSION) != version.json ($JSON_VERSION).
    ${DIM}This is the mismatch that causes the spurious update banner / reload loop.${RESET}"
fi
ok "APP_VERSION matches version.json"

if [ "$CHANGELOG_TOP" != "$APP_VERSION" ]; then
  warn "Newest CHANGELOG entry is '${CHANGELOG_TOP:-<none>}' but APP_VERSION is '$APP_VERSION' — every release needs an entry."
else
  ok "CHANGELOG has an entry for $APP_VERSION"
fi

# --------------------------------------------------------- rebuild verification

if [ $SKIP_BUILD -eq 1 ]; then
  warn "Skipping the rebuild check (--skip-build): shipping the committed index.html unverified."
else
  step "Rebuild verification"

  if [ ! -f node_modules/react/umd/react.production.min.js ]; then
    die "Build dependencies missing. There is no package.json by design, so install them all in one command:
    ${DIM}npm install --no-save --prefix . react@18 react-dom@18 @babel/core @babel/preset-react @babel/preset-env${RESET}
    ${DIM}(--prefix . or npm walks up and installs into a parent; one command or the second --no-save prunes the first.)${RESET}"
  fi

  node nexus-src/build.js >/dev/null || die "Build failed."

  # Compare through git, not raw md5: git applies .gitattributes normalisation, so
  # this stays correct on a checkout whose eol config differs from the committer's.
  if ! git diff --quiet -- index.html; then
    git checkout -- index.html 2>/dev/null || true
    die "Committed index.html does not match a fresh build of nexus-src/src.
    ${DIM}The commit is stale. Run 'node nexus-src/build.js', commit the rebuilt index.html, then deploy.${RESET}"
  fi
  ok "index.html rebuilds byte-identical from nexus-src/src"
fi

# What gets tarred is the working tree, so it must equal the commit byte for byte.
# On Git for Windows without .gitattributes this is exactly where a CRLF checkout
# would otherwise ship 603,306 bytes of index.html against 589,736 committed.
for f in "${ARTIFACTS[@]}"; do
  eol="$(git ls-files --eol -- "$f" | awk '{print $2}')"
  if [ "$eol" != "w/lf" ] && [ "$eol" != "w/none" ]; then
    die "$f is checked out as ${eol#w/} in the working tree, but the commit stores LF.
    ${DIM}The tar would ship bytes nobody committed. Ensure .gitattributes is present, then:
    git rm --cached -r -q . && git reset --hard${RESET}"
  fi
done
ok "Artifacts checked out LF — what ships is what was committed"

if [ $CHECK_ONLY -eq 1 ]; then
  step "Check only — nothing shipped"
  exit 0
fi

# ------------------------------------------------------------------ production

if [ $DO_PROD -eq 1 ]; then
  step "Production → ${SSH_HOST}:${REMOTE_DIR}"

  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" true 2>/dev/null \
    || die "Cannot reach $SSH_HOST over ssh with BatchMode (needs a key-based, non-interactive login)."
  ok "ssh to $SSH_HOST"

  # What is live right now, so we can refuse to ship new bytes under an old version.
  # Sent over stdin as a literal script (quoted heredoc) rather than squeezed into a
  # nested-quoted ssh argument, and every read is tr -d '\r' first: deploys made from
  # a Windows clone before .gitattributes landed left CRLF files on the server, which
  # silently defeated a $-anchored match on the CACHE line.
  REMOTE_STATE="$(ssh "$SSH_HOST" "ROULETTE_DIR='$REMOTE_DIR' bash -s" 2>/dev/null <<'REMOTE_PROBE' || true
cd "$ROULETTE_DIR" 2>/dev/null || exit 0
tr -d '\r' < version.json 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/version=\1/p' | head -1
tr -d '\r' < sw.js 2>/dev/null | sed -n "s/^const CACHE = '\(.*\)';$/cache=\1/p" | head -1
md5sum index.html 2>/dev/null | sed 's/^\([0-9a-f]*\) .*/md5=\1/'
wc -c < index.html 2>/dev/null | sed 's/^[[:space:]]*/bytes=/'
REMOTE_PROBE
)"
  REMOTE_VERSION="$(printf '%s\n'  "$REMOTE_STATE" | sed -n 's/^version=//p' | head -1)"
  REMOTE_CACHE="$(printf '%s\n'    "$REMOTE_STATE" | sed -n 's/^cache=//p'   | head -1)"
  REMOTE_INDEX_MD5="$(printf '%s\n' "$REMOTE_STATE" | sed -n 's/^md5=//p'    | head -1)"
  REMOTE_BYTES="$(printf '%s\n'    "$REMOTE_STATE" | sed -n 's/^bytes=//p'   | head -1)"
  LOCAL_INDEX_MD5="$(md5_of index.html)"

  if [ -z "$REMOTE_VERSION" ]; then
    warn "No readable deploy at $REMOTE_DIR yet — treating this as a first deploy."
  else
    say "    live now: version ${BOLD}${REMOTE_VERSION}${RESET}, cache ${BOLD}${REMOTE_CACHE:-<unknown>}${RESET}, ${REMOTE_BYTES:-?} bytes"
    if [ "$LOCAL_INDEX_MD5" = "$REMOTE_INDEX_MD5" ]; then
      warn "index.html is byte-identical to what is already live — this deploy is a no-op."
    else
      # A pre-.gitattributes deploy from a Windows clone left CRLF on the server, so the
      # first LF deploy differs in bytes while the app is unchanged. Say so, or the
      # version-bump abort below reads as a mystery.
      LOCAL_BYTES="$(wc -c < index.html | tr -d '[:space:]')"
      LOCAL_LINES="$(wc -l < index.html | tr -d '[:space:]')"
      if [ -n "$REMOTE_BYTES" ] && [ "$REMOTE_BYTES" -gt "$LOCAL_BYTES" ] 2>/dev/null; then
        # CRLF adds exactly one byte per line, so a delta equal to the line count is
        # the signature of a CRLF checkout rather than a real content change.
        if [ "$((REMOTE_BYTES - LOCAL_BYTES))" -eq "$LOCAL_LINES" ]; then
          say "    ${DIM}live copy is exactly ${LOCAL_LINES} bytes larger — one per line, the signature of a"
          say "    CRLF deploy made before .gitattributes pinned LF. Content is unchanged; the next"
          say "    release ships the committed LF bytes and the md5s line up from then on.${RESET}"
        fi
      fi

      # Content changed. Both the version and the cache name must have moved with it.
      STALE=""
      [ "$REMOTE_VERSION" = "$APP_VERSION" ] && STALE="version.json/APP_VERSION still $APP_VERSION"
      if [ -n "$REMOTE_CACHE" ] && [ "$REMOTE_CACHE" = "$SW_CACHE" ]; then
        STALE="${STALE:+$STALE and }sw.js CACHE still $SW_CACHE"
      fi
      if [ -n "$STALE" ]; then
        if [ $FORCE -eq 1 ]; then
          warn "Shipping changed content with $STALE (--force)."
        else
          die "index.html changed but $STALE.
    ${DIM}Clients cache by CACHE name and poll version.json — shipping new bytes under the old
    version means nobody gets the update. Bump all three, or re-run with --force.${RESET}"
        fi
      else
        ok "Version and cache name both moved with the content"
      fi
    fi
  fi

  confirm "Deploy $APP_VERSION ($SW_CACHE) to ${PROD_URL}"

  # Remote script is written so no argument begins with '/' — Git Bash rewrites
  # leading-slash arguments into Windows paths, which would silently retarget this.
  tar -czf - -C "$ROOT" "${ARTIFACTS[@]}" \
    | ssh "$SSH_HOST" "set -eu
        dir='$REMOTE_DIR'
        mkdir -p \"\$dir\"
        tar -xzf - -C \"\$dir\"
        if [ \"\$(id -u)\" -eq 0 ]; then
          chown -R '$WEB_USER':'$WEB_USER' \"\$dir\"
        else
          sudo -n chown -R '$WEB_USER':'$WEB_USER' \"\$dir\"
        fi" \
    || die "Upload failed — production may be half-updated. Re-run once the cause is fixed."
  ok "Uploaded ${#ARTIFACTS[@]} artifacts, owned by $WEB_USER"

  step "Verify production"

  # Authoritative check: hash on disk on the server vs hash on disk here. This works
  # regardless of the auth gate, which an anonymous curl cannot get past.
  REMOTE_MD5S="$(ssh "$SSH_HOST" "cd '$REMOTE_DIR' && md5sum ${ARTIFACTS[*]}")" \
    || die "Could not read back the deployed files for verification."
  MISMATCH=0
  for f in "${ARTIFACTS[@]}"; do
    local_md5="$(md5_of "$f")"
    remote_md5="$(printf '%s\n' "$REMOTE_MD5S" | awk -v f="$f" '$2==f {print $1}')"
    if [ "$local_md5" = "$remote_md5" ]; then
      ok "$f  ${DIM}${local_md5}${RESET}"
    else
      warn "$f  local=${local_md5:-?}  remote=${remote_md5:-missing}"
      MISMATCH=1
    fi
  done
  [ $MISMATCH -eq 0 ] || die "Deployed files do not match local. Production is in an unknown state — investigate before walking away."

  # The auth gate is a separate, silently-failing dependency: it lives in nginx and
  # sub-requests the NVC connect router, so it can break without this repo changing.
  # The invariant that matters is "anonymous never gets 200". 302 is the documented
  # behaviour; 401 is what nginx auth_request returns on its own, and means the gate
  # is closed but the error_page mapping to /connect.html is not in effect.
  # The gate splits on request shape, so BOTH shapes must be probed or the check
  # answers a neighbouring question. A navigation must be redirected to Connect; a
  # subresource must get a bare 401, because handing an installed PWA's manifest or
  # worker an HTML login page breaks the install. Probing only one shape is what
  # made this step warn on every single deploy about a gate that was working — and a
  # warning that always fires is one nobody reads.
  CB="$(date +%s)"
  gate_probe() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

  NAV_CODE="$(gate_probe -H 'Sec-Fetch-Mode: navigate' -H 'Accept: text/html' "${PROD_URL}?cb=${CB}")"
  SUB_CODE="$(gate_probe "${PROD_URL}sw.js?cb=${CB}")"

  case "$NAV_CODE" in
    302) ok "Auth gate — anonymous navigation 302s to /connect.html" ;;
    200) die "Auth gate is OPEN: anonymous navigation returned 200.
    ${DIM}Check location ^~ /roulette/ auth_request in /etc/nginx/nvc-sites/nexus-foundry.conf (never the global nginx.conf).${RESET}" ;;
    401) die "Anonymous navigation got a bare 401 instead of the login redirect.
    ${DIM}Access is denied, but staff without a session hit a dead end instead of Connect —
    and a service worker forwarding that navigation cannot recover from it. Needs
    'error_page 401 403 = @roulette_denied' on location ^~ /roulette/.${RESET}" ;;
    *)   die "Auth gate returned $NAV_CODE for a navigation (expected 302).
    ${DIM}A 5xx usually means /api/connect/whoami on :3002 is down or slow.${RESET}" ;;
  esac

  case "$SUB_CODE" in
    401|403) ok "Auth gate — anonymous subresource gets an honest $SUB_CODE, not HTML" ;;
    200)     die "Auth gate is OPEN: anonymous subresource returned 200." ;;
    302)     die "Anonymous subresource is being REDIRECTED (302).
    ${DIM}An installed PWA would receive the login page as its manifest/worker and break.
    The navigate/subresource split in @roulette_denied has been lost.${RESET}" ;;
    *)       die "Auth gate returned $SUB_CODE for a subresource (expected 401)." ;;
  esac

  # Optional end-to-end pass through nginx as a real staff session.
  if [ -n "${ROULETTE_CONNECT_COOKIE:-}" ]; then
    E2E=0
    for f in "${ARTIFACTS[@]}"; do
      tmp="$(mktemp)"
      code="$(curl -s -o "$tmp" -w '%{http_code}' \
                -H 'Cache-Control: no-cache' \
                -b "nvc_connect_session=${ROULETTE_CONNECT_COOKIE}" \
                "${PROD_URL}${f}?cb=${CB}" || true)"
      if [ "$code" = "200" ] && [ "$(md5_of "$tmp")" = "$(md5_of "$f")" ]; then
        ok "served $f  ${DIM}200, md5 matches${RESET}"
      else
        warn "served $f  http=$code, md5 differs or empty"
        E2E=1
      fi
      rm -f "$tmp"
    done
    [ $E2E -eq 0 ] || die "Authenticated fetch does not match local — nginx may be serving a cached or wrong root."
  else
    say "    ${DIM}Set ROULETTE_CONNECT_COOKIE to also verify the authenticated staff path end to end.${RESET}"
  fi

  say ""
  ok "${BOLD}Production is live on $APP_VERSION${RESET} — ${PROD_URL}"
fi

# ---------------------------------------------------------------------- mirror

if [ $DO_MIRROR -eq 1 ]; then
  step "Friend mirror → ${PAGES_REMOTE}"

  if ! git remote get-url "$PAGES_REMOTE" >/dev/null 2>&1; then
    die "No '$PAGES_REMOTE' remote configured. Add it, then re-run:
    ${DIM}git remote add $PAGES_REMOTE https://github.com/nexus-foundry-agents/nexus-roulette.git${RESET}"
  fi
  MIRROR_URL="$(git remote get-url "$PAGES_REMOTE")"
  say "    ${DIM}${MIRROR_URL}${RESET}"

  warn "This mirror is PUBLIC and pushes the whole repo — including docs/DEPLOYMENT-MAP.md,"
  warn "which names the production ssh host and path. That is pre-existing and deliberate;"
  warn "it is called out here so it stays a decision rather than a surprise."

  confirm "Publish $APP_VERSION to the public mirror"

  git push "$PAGES_REMOTE" "$RELEASE_BRANCH:$RELEASE_BRANCH" \
    || die "Mirror push failed."
  ok "Pushed $RELEASE_BRANCH to $PAGES_REMOTE — GitHub Pages will rebuild shortly"
  say "    ${DIM}https://nexus-foundry-agents.github.io/nexus-roulette/${RESET}"
fi
