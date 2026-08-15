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

  BEFORE_MD5="$(md5_of index.html)"
  node nexus-src/build.js >/dev/null || die "Build failed."
  AFTER_MD5="$(md5_of index.html)"

  if [ "$BEFORE_MD5" != "$AFTER_MD5" ]; then
    git checkout -- index.html 2>/dev/null || true
    die "Committed index.html does not match a fresh build of nexus-src/src.
    ${DIM}The commit is stale. Run 'node nexus-src/build.js', commit the rebuilt index.html, then deploy.${RESET}"
  fi
  ok "index.html rebuilds byte-identical from nexus-src/src"
fi

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
  REMOTE_STATE="$(ssh "$SSH_HOST" "cd '$REMOTE_DIR' 2>/dev/null && { node -e 'process.stdout.write(require(\"./version.json\").version||\"\")' 2>/dev/null || sed -n 's/.*\"version\":\"\([^\"]*\)\".*/\1/p' version.json; echo; sed -n \"s/^const CACHE = '\(.*\)';\$/\1/p\" sw.js | head -1; md5sum index.html 2>/dev/null | cut -d' ' -f1; } || true" 2>/dev/null || true)"
  REMOTE_VERSION="$(printf '%s' "$REMOTE_STATE" | sed -n '1p')"
  REMOTE_CACHE="$(printf '%s' "$REMOTE_STATE" | sed -n '2p')"
  REMOTE_INDEX_MD5="$(printf '%s' "$REMOTE_STATE" | sed -n '3p')"
  LOCAL_INDEX_MD5="$(md5_of index.html)"

  if [ -z "$REMOTE_VERSION" ]; then
    warn "No readable deploy at $REMOTE_DIR yet — treating this as a first deploy."
  else
    say "    live now: version ${BOLD}${REMOTE_VERSION}${RESET}, cache ${BOLD}${REMOTE_CACHE:-<unknown>}${RESET}"
    if [ "$LOCAL_INDEX_MD5" = "$REMOTE_INDEX_MD5" ]; then
      warn "index.html is byte-identical to what is already live — this deploy is a no-op."
    else
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
  CB="$(date +%s)"
  GATE_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${PROD_URL}?cb=${CB}" || true)"
  case "$GATE_CODE" in
    302) ok "Auth gate intact — anonymous request 302s to /connect.html" ;;
    200) die "Auth gate is OPEN: anonymous request returned 200. ${DIM}Check location /roulette/ auth_request in /etc/nginx/nvc-sites/nexus-foundry.conf (never the global nginx.conf).${RESET}" ;;
    *)   die "Auth gate returned $GATE_CODE (expected 302). ${DIM}A 5xx usually means /api/connect/whoami on :3002 is down or slow.${RESET}" ;;
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
