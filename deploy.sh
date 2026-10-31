#!/usr/bin/env bash
#
# Nexus Roulette — deploy script
#
# Encodes docs/DEPLOYMENT-MAP.md so the production path is not a sequence of
# remembered shell commands. Three surfaces:
#
#   --prod    tar-over-ssh the 5 artifacts to the staff-gated production host
#   --mirror  git push public-pages main:main (public GitHub Pages friend mirror)
#   --module  atomically deploy the same app plus its declaration to the Casino module host
#
# Everything is checked before anything is shipped: version lockstep, a
# byte-identical rebuild of index.html from nexus-src/src, and a clean tree on
# main. After a production deploy it verifies md5 per artifact on the server and
# re-asserts the auth gate still 302s an anonymous request.
#
# Usage: ./deploy.sh --prod | --mirror | --module | --all [--check] [--yes]
#
set -euo pipefail

# ---------------------------------------------------------------- configuration

SSH_HOST="nexus-foundry-ts"
REMOTE_DIR="/var/www/html/roulette"
WEB_USER="www-data"
PROD_URL="https://nexus-foundry.ai/roulette/"
# Production targets are literals. A deploy target is authority, not configuration supplied by
# the environment; allowing an override here lets a stray variable retarget cleanup or uploads.
MODULE_DIR="/var/www/casino-module-roulette"
MODULE_RELEASES="${MODULE_DIR}/releases"
MODULE_CURRENT="${MODULE_DIR}/current"
MODULE_URL="https://roulette.nexus-foundry.ai/"
MODULE_MANIFEST_URL="https://roulette.nexus-foundry.ai/module.json"
MODULE_PLAY_URL="https://roulette.nexus-foundry.ai/play"
MODULE_VHOST="/etc/nginx/nvc-sites/roulette-nexus-foundry.conf"
MODULE_WEB_USER="www-data"
MODULE_LOCK="/var/lock/nexus-roulette-module-deploy.lock"
PAGES_REMOTE="public-pages"
RELEASE_BRANCH="main"

# The deployed artifact set — exactly these, nothing else (DEPLOYMENT-MAP.md).
ARTIFACTS=(index.html sw.js manifest.json version.json icon.svg)
MODULE_ARTIFACTS=(index.html sw.js manifest.json version.json icon.svg module.json)

# ---------------------------------------------------------------------- plumbing

DO_PROD=0 DO_MIRROR=0 DO_MODULE=0 CHECK_ONLY=0 ASSUME_YES=0

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
  --module       Deploy the Casino module (${MODULE_URL})
  --all          Existing paired release: staff surface, then public mirror
  --check        Run every preflight check and stop — ships nothing
  -y, --yes      Do not prompt for confirmation
  -h, --help     This text

Optional verification credential
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
    --module)     DO_MODULE=1 ;;
    --all)        DO_PROD=1; DO_MIRROR=1 ;;
    --check)      CHECK_ONLY=1 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ $DO_PROD -eq 0 ] && [ $DO_MIRROR -eq 0 ] && [ $DO_MODULE -eq 0 ]; then
  if [ $CHECK_ONLY -eq 1 ]; then
    :   # --check on its own is valid: preflight everything, target nothing
  else
    printf 'Nothing to do: pass --prod, --mirror, --module, --all or --check.\n\n' >&2
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
if [ $DO_PROD -eq 1 ] || [ $DO_MODULE -eq 1 ]; then
  for tool in ssh tar scp; do
    command -v "$tool" >/dev/null 2>&1 || die "Required tool not on PATH: $tool"
  done
fi
ok "Toolchain present"

for f in "${MODULE_ARTIFACTS[@]}"; do
  [ -f "$f" ] || die "Missing deploy artifact: $f"
done
ok "All ${#MODULE_ARTIFACTS[@]} module artifacts present"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "$RELEASE_BRANCH" ]; then
  if { [ $DO_PROD -eq 1 ] || [ $DO_MIRROR -eq 1 ] || [ $DO_MODULE -eq 1 ]; } && [ $CHECK_ONLY -eq 0 ]; then
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

if ! git fetch --quiet origin "$RELEASE_BRANCH" 2>/dev/null; then
  if [ $CHECK_ONLY -eq 1 ]; then
    warn "Could not fetch origin/$RELEASE_BRANCH; check mode leaves remote sync unverified."
  else
    die "Could not fetch origin/$RELEASE_BRANCH. A deploy cannot prove it is current."
  fi
fi
if git rev-parse --verify --quiet "origin/$RELEASE_BRANCH" >/dev/null; then
  LOCAL_SHA="$(git rev-parse HEAD)"
  REMOTE_SHA="$(git rev-parse "origin/$RELEASE_BRANCH")"
  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    if [ $CHECK_ONLY -eq 1 ] && git merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA" 2>/dev/null; then
      warn "HEAD is ahead of origin/$RELEASE_BRANCH; check mode continues, but push before deploy."
    else
      die "HEAD is not the exact origin/$RELEASE_BRANCH commit. Push or reconcile before deploying."
    fi
  else
    ok "In sync with origin/$RELEASE_BRANCH"
  fi
elif [ $CHECK_ONLY -eq 1 ]; then
  warn "origin/$RELEASE_BRANCH is absent; check mode leaves remote sync unverified."
else
  die "origin/$RELEASE_BRANCH is absent. A deploy has no authoritative release commit."
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

step "Tests"
node --test test/*.test.mjs
ok "Full repository test suite"

# --------------------------------------------------------- rebuild verification

step "Rebuild verification"

if [ ! -f node_modules/react/umd/react.production.min.js ]; then
  die "Build dependencies missing. Install the committed lockfile exactly:
    ${DIM}npm ci --ignore-scripts${RESET}"
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

# What gets tarred is the working tree, so it must equal the commit byte for byte.
# On Git for Windows without .gitattributes this is exactly where a CRLF checkout
# would otherwise ship 603,306 bytes of index.html against 589,736 committed.
for f in "${MODULE_ARTIFACTS[@]}"; do
  eol="$(git ls-files --eol -- "$f" | awk '{print $2}')"
  if [ "$eol" != "w/lf" ] && [ "$eol" != "w/none" ]; then
    die "$f is checked out as ${eol#w/} in the working tree, but the commit stores LF.
    ${DIM}The tar would ship bytes nobody committed. Ensure .gitattributes is present, then:
    git rm --cached -r -q . && git reset --hard${RESET}"
  fi
done
ok "Artifacts checked out LF — what ships is what was committed"

if [ $DO_MODULE -eq 1 ]; then
  step "Module vhost candidate"
  CANDIDATE_SHA="$(git rev-parse HEAD)"
  [[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "HEAD did not resolve to a full commit SHA."
  DEPLOY_TXN="${CANDIDATE_SHA}-$(date -u +%Y%m%dT%H%M%S)-$$-${RANDOM}"
  [[ "$DEPLOY_TXN" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]] \
    || die "Could not construct a safe deployment transaction id."
  scp -q deploy/roulette-nexus-foundry.conf "$SSH_HOST:/tmp/roulette-vhost.${DEPLOY_TXN}.conf" \
    || die "Could not copy the module vhost candidate to $SSH_HOST."
  ssh "$SSH_HOST" "cat > /tmp/roulette-nginx-candidate.conf <<NGINX_ROOT
events {}
http {
  include /etc/nginx/mime.types;
  include /tmp/roulette-vhost.${DEPLOY_TXN}.conf;
}
NGINX_ROOT
nginx -t -c /tmp/roulette-nginx-candidate.conf" \
    || die "nginx rejected the module vhost candidate; no live configuration was changed."
  ok "nginx accepts the candidate without installing it"
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
  # Sent over stdin as a literal script (quoted heredoc) rather than squeezed into a
  # nested-quoted ssh argument, and every read is tr -d '\r' first: deploys made from
  # a Windows clone before .gitattributes landed left CRLF files on the server, which
  # silently defeated a $-anchored match on the CACHE line.
  REMOTE_STATE="$(ssh "$SSH_HOST" "ROULETTE_DIR='$REMOTE_DIR' bash -s" 2>/dev/null <<'REMOTE_PROBE'
set -e
if [ ! -e "$ROULETTE_DIR" ]; then
  echo absent=1
  exit 0
fi
[ -d "$ROULETTE_DIR" ]
cd "$ROULETTE_DIR"
[ -f version.json ] && [ -f sw.js ] && [ -f index.html ]
tr -d '\r' < version.json | sed -n 's/.*"version":"\([^"]*\)".*/version=\1/p' | head -1
tr -d '\r' < sw.js | sed -n "s/^const CACHE = '\(.*\)';$/cache=\1/p" | head -1
md5sum index.html | sed 's/^\([0-9a-f]*\) .*/md5=\1/'
wc -c < index.html | sed 's/^[[:space:]]*/bytes=/'
REMOTE_PROBE
 )" || die "Could not read the existing production deployment; refusing to classify a probe failure as first deploy."
  REMOTE_ABSENT="$(printf '%s\n' "$REMOTE_STATE" | sed -n 's/^absent=//p' | head -1)"
  REMOTE_VERSION="$(printf '%s\n'  "$REMOTE_STATE" | sed -n 's/^version=//p' | head -1)"
  REMOTE_CACHE="$(printf '%s\n'    "$REMOTE_STATE" | sed -n 's/^cache=//p'   | head -1)"
  REMOTE_INDEX_MD5="$(printf '%s\n' "$REMOTE_STATE" | sed -n 's/^md5=//p'    | head -1)"
  REMOTE_BYTES="$(printf '%s\n'    "$REMOTE_STATE" | sed -n 's/^bytes=//p'   | head -1)"
  LOCAL_INDEX_MD5="$(md5_of index.html)"

  if [ "$REMOTE_ABSENT" = "1" ]; then
    warn "No readable deploy at $REMOTE_DIR yet — treating this as a first deploy."
  elif [ -z "$REMOTE_VERSION" ] || [ -z "$REMOTE_CACHE" ] || [ -z "$REMOTE_INDEX_MD5" ]; then
    die "The existing deployment is present but incomplete; refusing to treat missing evidence as a first deploy."
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
        die "index.html changed but $STALE.
    ${DIM}Clients cache by CACHE name and poll version.json — shipping new bytes under the old
    version means nobody gets the update. Bump all three before release.${RESET}"
      else
        ok "Version and cache name both moved with the content"
      fi
    fi
  fi

  confirm "Deploy $APP_VERSION ($SW_CACHE) to ${PROD_URL}"

  # Stage a complete release before touching the live directory. The only remote argument is a
  # constrained transaction id, so Git Bash cannot rewrite a leading-slash path on Windows.
  PROD_SHA="$(git rev-parse HEAD)"
  PROD_TXN="${PROD_SHA}-$(date -u +%Y%m%dT%H%M%S)-$$-${RANDOM}"
  [[ "$PROD_TXN" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]] \
    || die "Could not construct a safe production transaction id."
  tar -czf - -C "$ROOT" "${ARTIFACTS[@]}" \
    | ssh "$SSH_HOST" "cat > /tmp/roulette-prod-${PROD_TXN}.tar.gz" \
    || die "Production staging upload failed; the live directory was not touched."

  PROD_SWAP_STATE="$(ssh "$SSH_HOST" bash -s -- "$PROD_TXN" <<'REMOTE_PROD_SWAP'
set -euo pipefail
txn="$1"
[[ "$txn" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]
live=/var/www/html/roulette
staged="/var/www/html/roulette.incoming-$txn"
backup="/var/www/html/roulette.rollback-$txn"
archive="/tmp/roulette-prod-$txn.tar.gz"
generation=/var/www/html/.roulette-generation
generation_next="/var/www/html/.roulette-generation.next-$txn"
lock=/var/lock/nexus-roulette-prod-deploy.lock
had_live=0
previous_generation=""
old_moved=0
activated=0
exec 9>"$lock"
flock -x 9
[ -f "$archive" ]
rm -rf "$staged" "$backup"
mkdir "$staged"
tar -xzf "$archive" -C "$staged"
for file in index.html sw.js manifest.json version.json icon.svg; do [ -f "$staged/$file" ]; done
if [ "$(id -u)" -eq 0 ]; then
  chown -R www-data:www-data "$staged"
else
  sudo -n chown -R www-data:www-data "$staged"
fi
if [ -e "$live" ]; then
  [ -d "$live" ] && [ ! -L "$live" ]
  had_live=1
fi
if [ -f "$generation" ]; then
  previous_generation="$(cat "$generation")"
  [[ "$previous_generation" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]
fi
rollback() {
  trap - ERR
  if [ "$activated" -eq 1 ] || [ "$old_moved" -eq 1 ]; then
    rm -rf "$live"
    if [ "$had_live" -eq 1 ] && [ -d "$backup" ]; then mv "$backup" "$live"; fi
  fi
  if [ -n "$previous_generation" ]; then
    printf '%s\n' "$previous_generation" > "$generation_next"
    mv -Tf "$generation_next" "$generation"
  else
    rm -f "$generation" "$generation_next"
  fi
  rm -rf "$staged"
}
trap rollback ERR
if [ "$had_live" -eq 1 ]; then mv "$live" "$backup"; old_moved=1; fi
mv "$staged" "$live"
activated=1
printf '%s\n' "$txn" > "$generation_next"
mv -Tf "$generation_next" "$generation"
rm -f "$archive"
trap - ERR
printf 'had_live=%s\nprevious_generation=%s\n' "$had_live" "$previous_generation"
REMOTE_PROD_SWAP
  )" || die "Production swap failed; the remote transaction attempted the named rollback."
  PROD_HAD_LIVE="$(printf '%s\n' "$PROD_SWAP_STATE" | sed -n 's/^had_live=//p' | head -1)"
  PROD_PREVIOUS_GENERATION="$(printf '%s\n' "$PROD_SWAP_STATE" | sed -n 's/^previous_generation=//p' | head -1)"
  case "$PROD_HAD_LIVE" in 0|1) ;; *) die "Remote returned an invalid production rollback state." ;; esac
  if [ -n "$PROD_PREVIOUS_GENERATION" ] && [[ ! "$PROD_PREVIOUS_GENERATION" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]; then
    die "Remote returned an invalid production rollback generation."
  fi
  ok "Staged and atomically activated ${#ARTIFACTS[@]} artifacts, owned by $WEB_USER"

  rollback_production() {
    ssh "$SSH_HOST" bash -s -- "$PROD_TXN" "$PROD_HAD_LIVE" "$PROD_PREVIOUS_GENERATION" <<'REMOTE_PROD_ROLLBACK'
set -euo pipefail
txn="$1"; had_live="$2"; previous_generation="$3"
[[ "$txn" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]
[ "$had_live" = 0 ] || [ "$had_live" = 1 ]
if [ -n "$previous_generation" ]; then
  [[ "$previous_generation" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]
fi
live=/var/www/html/roulette
backup="/var/www/html/roulette.rollback-$txn"
failed="/var/www/html/roulette.failed-$txn"
generation=/var/www/html/.roulette-generation
generation_next="/var/www/html/.roulette-generation.rollback-$txn"
lock=/var/lock/nexus-roulette-prod-deploy.lock
exec 9>"$lock"
flock -x 9
[ "$(cat "$generation" 2>/dev/null || true)" = "$txn" ] || {
  echo "refusing rollback: production advanced after this transaction" >&2
  exit 3
}
rm -rf "$failed"
rollback_recovery() {
  trap - ERR
  if [ ! -e "$live" ] && [ "$had_live" = 1 ] && [ -d "$backup" ]; then
    mv "$backup" "$live" || true
  fi
  if [ ! -e "$live" ] && [ -d "$failed" ]; then
    mv "$failed" "$live" || true
  fi
}
trap rollback_recovery ERR
mv "$live" "$failed"
if [ "$had_live" = 1 ]; then mv "$backup" "$live"; fi
if [ -n "$previous_generation" ]; then
  printf '%s\n' "$previous_generation" > "$generation_next"
  mv -Tf "$generation_next" "$generation"
else
  rm -f "$generation" "$generation_next"
fi
rm -rf "$failed"
trap - ERR
REMOTE_PROD_ROLLBACK
  }

  PROD_BACKUP_ACTIVE=1
  prod_exit_cleanup() {
    rc=$?
    trap - EXIT
    if [ "$PROD_BACKUP_ACTIVE" -eq 1 ]; then
      warn "Production verification did not complete; restoring the release named before the swap."
      rollback_production || warn "Automatic production rollback failed or refused; inspect the named backup."
    fi
    exit "$rc"
  }
  trap prod_exit_cleanup EXIT

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

  ssh "$SSH_HOST" bash -s -- "$PROD_TXN" <<'REMOTE_PROD_FINALIZE' \
    || die "Production is proven, but its rollback directory could not be retired safely."
set -euo pipefail
txn="$1"
[[ "$txn" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]
live=/var/www/html/roulette
backup="/var/www/html/roulette.rollback-$txn"
generation=/var/www/html/.roulette-generation
lock=/var/lock/nexus-roulette-prod-deploy.lock
exec 9>"$lock"
flock -x 9
[ "$(cat "$generation" 2>/dev/null || true)" = "$txn" ] || {
  echo "refusing cleanup: production advanced after this transaction" >&2
  exit 3
}
[ -d "$live" ]
rm -rf "$backup"
REMOTE_PROD_FINALIZE
  PROD_BACKUP_ACTIVE=0
  trap - EXIT
  ok "Independent proof passed; production rollback directory retired"

  say ""
  ok "${BOLD}Production is live on $APP_VERSION${RESET} — ${PROD_URL}"
fi

# --------------------------------------------------------------- Casino module

if [ $DO_MODULE -eq 1 ]; then
  step "Casino module -> ${SSH_HOST}:${MODULE_DIR}"

  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" true 2>/dev/null \
    || die "Cannot reach $SSH_HOST over ssh with BatchMode."
  ok "ssh to $SSH_HOST"

  confirm "Deploy $APP_VERSION to ${MODULE_URL}"

  RELEASE_SHA="$(git rev-parse HEAD)"
  [[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "HEAD did not resolve to a full commit SHA."
  [ "$RELEASE_SHA" = "$CANDIDATE_SHA" ] || die "HEAD changed after the module candidate was checked."
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  say "    release: ${MODULE_RELEASES}/${RELEASE_SHA}"
  say "    transaction: ${DEPLOY_TXN}"
  say "    rollback: restore ${MODULE_CURRENT} to its previous release and ${MODULE_VHOST}.bak-${DEPLOY_TXN}"

  # Populate a commit-addressed incoming directory without touching the live symlink. The paths
  # below are fixed production literals and RELEASE_SHA is constrained to forty hex characters.
  tar -czf - -C "$ROOT" "${MODULE_ARTIFACTS[@]}" \
    | ssh "$SSH_HOST" "set -eu
        base='${MODULE_DIR}'
        releases='${MODULE_RELEASES}'
        incoming='${MODULE_DIR}/incoming-${DEPLOY_TXN}'
        mkdir -p \"\$base\" \"\$releases\"
        rm -rf \"\$incoming\"
        mkdir -p \"\$incoming\"
        tar -xzf - -C \"\$incoming\"
        if [ \"\$(id -u)\" -eq 0 ]; then
          chown -R '${MODULE_WEB_USER}':'${MODULE_WEB_USER}' \"\$incoming\"
        else
          sudo -n chown -R '${MODULE_WEB_USER}':'${MODULE_WEB_USER}' \"\$incoming\"
        fi" \
    || die "Module upload failed before the live-root swap."

  SWAP_STATE="$(ssh "$SSH_HOST" "bash -s -- '$RELEASE_SHA' '$DEPLOY_TXN'" \
    <<'REMOTE_MODULE_SWAP'
set -euo pipefail
sha="$1"
txn="$2"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$txn" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]] || exit 2

base=/var/www/casino-module-roulette
releases="$base/releases"
current="$base/current"
incoming="$base/incoming-$txn"
release="$releases/$sha"
next="$base/current.next-$txn"
generation="$base/current-generation"
generation_next="$base/current-generation.next-$txn"
vhost=/etc/nginx/nvc-sites/roulette-nexus-foundry.conf
candidate="/tmp/roulette-vhost.$txn.conf"
vhost_new="${vhost}.new-$txn"
backup="${vhost}.bak-$txn"
lock=/var/lock/nexus-roulette-module-deploy.lock
had_vhost=0
previous=""
previous_generation=""

exec 9>"$lock"
flock -x 9

[ -d "$incoming" ] || { echo "incoming release is missing" >&2; exit 1; }
[ -f "$candidate" ] || { echo "vhost candidate is missing" >&2; exit 1; }
[ ! -e "$current" ] || [ -L "$current" ] || {
  echo "$current exists but is not a symlink; refusing a destructive conversion" >&2
  exit 1
}

if [ -L "$current" ]; then
  previous="$(readlink "$current")"
  [[ "$previous" =~ ^releases/[0-9a-f]{40}$ ]] || {
    echo "current points outside the immutable release set" >&2
    exit 1
  }
fi
if [ -f "$generation" ]; then
  previous_generation="$(cat "$generation")"
  [[ "$previous_generation" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]] || {
    echo "current generation marker is invalid" >&2
    exit 1
  }
fi

if [ -f "$vhost" ]; then
  cp "$vhost" "$backup"
  had_vhost=1
fi

rollback() {
  trap - ERR
  rm -f "$next" "$vhost_new" "$generation_next"
  if [ -n "$previous" ]; then
    ln -s "$previous" "$next"
    mv -Tf "$next" "$current"
  else
    rm -f "$current"
  fi
  if [ "$had_vhost" -eq 1 ]; then cp "$backup" "$vhost"; else rm -f "$vhost"; fi
  if [ -n "$previous_generation" ]; then
    printf '%s\n' "$previous_generation" > "$generation_next"
    mv -Tf "$generation_next" "$generation"
  else
    rm -f "$generation"
  fi
  nginx -t && systemctl reload nginx || true
}
trap rollback ERR

if [ -e "$release" ]; then
  [ -d "$release" ] || { echo "release path exists but is not a directory" >&2; false; }
  diff -qr "$incoming" "$release" >/dev/null || {
    echo "existing immutable release differs from the complete committed artifact set" >&2
    false
  }
  rm -rf "$incoming"
else
  mv "$incoming" "$release"
fi

cp "$candidate" "$vhost_new"
mv -Tf "$vhost_new" "$vhost"

ln -s "releases/$sha" "$next"
mv -Tf "$next" "$current"
printf '%s\n' "$txn" > "$generation_next"
mv -Tf "$generation_next" "$generation"

nginx -t
systemctl reload nginx
trap - ERR
printf 'previous=%s\nprevious_generation=%s\nhad_vhost=%s\n' "$previous" "$previous_generation" "$had_vhost"
REMOTE_MODULE_SWAP
  )" || die "Module swap or nginx reload failed; the remote transaction attempted the named rollback."
  PREVIOUS_TARGET="$(printf '%s\n' "$SWAP_STATE" | sed -n 's/^previous=//p' | head -1)"
  PREVIOUS_GENERATION="$(printf '%s\n' "$SWAP_STATE" | sed -n 's/^previous_generation=//p' | head -1)"
  HAD_VHOST="$(printf '%s\n' "$SWAP_STATE" | sed -n 's/^had_vhost=//p' | head -1)"
  if [ -n "$PREVIOUS_TARGET" ] && [[ ! "$PREVIOUS_TARGET" =~ ^releases/[0-9a-f]{40}$ ]]; then
    die "Remote returned an invalid rollback target."
  fi
  if [ -n "$PREVIOUS_GENERATION" ] && [[ ! "$PREVIOUS_GENERATION" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]; then
    die "Remote returned an invalid rollback generation."
  fi
  case "$HAD_VHOST" in 0|1) ;; *) die "Remote returned an invalid vhost rollback state." ;; esac
  ok "Immutable release and vhost activated atomically"

  rollback_module() {
    warn "Verification failed; restoring the release and vhost named before the swap."
    ssh "$SSH_HOST" "bash -s -- '$PREVIOUS_TARGET' '$PREVIOUS_GENERATION' '$HAD_VHOST' '$DEPLOY_TXN' '$RELEASE_SHA'" \
      <<'REMOTE_MODULE_ROLLBACK'
set -euo pipefail
previous="$1"
previous_generation="$2"
had_vhost="$3"
txn="$4"
sha="$5"
base=/var/www/casino-module-roulette
current="$base/current"
next="$base/current.rollback-$txn"
generation="$base/current-generation"
generation_next="$base/current-generation.rollback-$txn"
vhost=/etc/nginx/nvc-sites/roulette-nexus-foundry.conf
backup="${vhost}.bak-$txn"
lock=/var/lock/nexus-roulette-module-deploy.lock
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$txn" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]
[ "$had_vhost" = 0 ] || [ "$had_vhost" = 1 ]
if [ -n "$previous" ]; then [[ "$previous" =~ ^releases/[0-9a-f]{40}$ ]]; fi
if [ -n "$previous_generation" ]; then [[ "$previous_generation" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}-[0-9]+-[0-9]+$ ]]; fi
exec 9>"$lock"
flock -x 9
active="$(readlink "$current")"
[ "$active" = "releases/$sha" ] || {
  echo "refusing rollback: current advanced from releases/$sha to ${active:-<missing>}" >&2
  exit 3
}
active_generation="$(cat "$generation" 2>/dev/null || true)"
[ "$active_generation" = "$txn" ] || {
  echo "refusing rollback: generation advanced from $txn to ${active_generation:-<missing>}" >&2
  exit 3
}
rm -f "$next"
if [ -n "$previous" ]; then
  [ -d "$base/$previous" ]
  ln -s "$previous" "$next"
  mv -Tf "$next" "$current"
else
  rm -f "$current"
fi
if [ "$had_vhost" = 1 ]; then cp "$backup" "$vhost"; else rm -f "$vhost"; fi
if [ -n "$previous_generation" ]; then
  printf '%s\n' "$previous_generation" > "$generation_next"
  mv -Tf "$generation_next" "$generation"
else
  rm -f "$generation"
fi
nginx -t
systemctl reload nginx
REMOTE_MODULE_ROLLBACK
  }

  abort_module() {
    local reason="$1"
    if rollback_module; then
      die "$reason The previous module release was restored."
    else
      die "$reason AUTOMATIC ROLLBACK ALSO FAILED. Restore ${MODULE_CURRENT} and ${MODULE_VHOST}.bak-${DEPLOY_TXN}."
    fi
  }

  step "Verify Casino module"
  REMOTE_MD5S="$(ssh "$SSH_HOST" "cd '$MODULE_CURRENT' && md5sum ${MODULE_ARTIFACTS[*]}")" \
    || abort_module "Could not read back the deployed module artifacts."
  MISMATCH=0
  for f in "${MODULE_ARTIFACTS[@]}"; do
    local_md5="$(md5_of "$f")"
    remote_md5="$(printf '%s\n' "$REMOTE_MD5S" | awk -v f="$f" '$2==f {print $1}')"
    if [ "$local_md5" = "$remote_md5" ]; then
      ok "$f  ${DIM}${local_md5}${RESET}"
    else
      warn "$f  local=${local_md5:-?}  remote=${remote_md5:-missing}"
      MISMATCH=1
    fi
  done
  [ $MISMATCH -eq 0 ] || abort_module "The installed module differs from the committed artifact set."

  ran=0 failed=0
  module_probe() {
    ran=$((ran + 1))
    if [ "$2" = "$3" ]; then
      printf '  ok   %-48s %s\n' "$1" "$3"
    else
      printf '  FAIL %-48s expected %s, got %s\n' "$1" "$2" "$3" >&2
      failed=$((failed + 1))
    fi
  }
  origin_code() {
    ssh "$SSH_HOST" "curl -sS -k --resolve roulette.nexus-foundry.ai:443:127.0.0.1 -o /dev/null -w '%{http_code}' 'https://roulette.nexus-foundry.ai$1'"
  }
  origin_headers="$(ssh "$SSH_HOST" "curl -sS -k --resolve roulette.nexus-foundry.ai:443:127.0.0.1 -D- -o /dev/null 'https://roulette.nexus-foundry.ai/play'" | tr -d '\r')"
  manifest_headers="$(ssh "$SSH_HOST" "curl -sS -k --resolve roulette.nexus-foundry.ai:443:127.0.0.1 -D- -o /dev/null 'https://roulette.nexus-foundry.ai/module.json'" | tr -d '\r')"

  module_probe "origin /play serves the app" 200 "$(origin_code /play)"
  module_probe "origin /module.json serves JSON" 200 "$(origin_code /module.json)"
  module_probe "missing named asset is a 404" 404 "$(origin_code /missing-${STAMP}.js)"
  module_probe "only Casino may frame the app" \
    "frame-ancestors https://casino.nexus-foundry.ai" \
    "$(printf '%s' "$origin_headers" | grep -io 'frame-ancestors [^;]*' | head -1)"
  module_probe "no X-Frame-Options blocks Casino" absent \
    "$(printf '%s' "$origin_headers" | grep -qi '^x-frame-options:' && echo present || echo absent)"
  module_probe "manifest CORS names Casino" "https://casino.nexus-foundry.ai" \
    "$(printf '%s' "$manifest_headers" | sed -n 's/^Access-Control-Allow-Origin: *//Ip' | head -1)"

  # The public edge is a different instrument from the origin. Every check below fails if it is
  # unreachable; an unreachable edge proves no absence and no successful deploy.
  edge_play="$(mktemp)"
  edge_manifest="$(mktemp)"
  edge_play_headers="$(mktemp)"
  edge_manifest_headers="$(mktemp)"
  trap 'rm -f "$edge_play" "$edge_manifest" "$edge_play_headers" "$edge_manifest_headers"' EXIT
  play_code="$(curl -sS --max-time 20 -D "$edge_play_headers" -o "$edge_play" -w '%{http_code}' "$MODULE_PLAY_URL" || true)"
  manifest_code="$(curl -sS --max-time 20 -D "$edge_manifest_headers" -o "$edge_manifest" -w '%{http_code}' "$MODULE_MANIFEST_URL" || true)"
  module_probe "public edge /play serves" 200 "$play_code"
  module_probe "public edge /module.json serves" 200 "$manifest_code"
  if [ "$play_code" = 200 ]; then
    module_probe "public play body matches index.html" "$(md5_of index.html)" "$(md5_of "$edge_play")"
  else
    module_probe "public play body matches index.html" "$(md5_of index.html)" unreachable
  fi
  if [ "$manifest_code" = 200 ]; then
    module_probe "public manifest matches module.json" "$(md5_of module.json)" "$(md5_of "$edge_manifest")"
  else
    module_probe "public manifest matches module.json" "$(md5_of module.json)" unreachable
  fi
  edge_play_headers_text="$(tr -d '\r' < "$edge_play_headers")"
  edge_manifest_headers_text="$(tr -d '\r' < "$edge_manifest_headers")"
  module_probe "edge preserves Casino frame ancestry" \
    "frame-ancestors https://casino.nexus-foundry.ai" \
    "$(printf '%s' "$edge_play_headers_text" | grep -io 'frame-ancestors [^;]*' | head -1)"
  module_probe "edge does not add X-Frame-Options" absent \
    "$(printf '%s' "$edge_play_headers_text" | grep -qi '^x-frame-options:' && echo present || echo absent)"
  module_probe "edge preserves manifest CORS" "https://casino.nexus-foundry.ai" \
    "$(printf '%s' "$edge_manifest_headers_text" | sed -n 's/^Access-Control-Allow-Origin: *//Ip' | head -1)"
  module_probe "edge denies camera and microphone" \
    "camera=(), microphone=(), geolocation=(), payment=()" \
    "$(printf '%s' "$edge_play_headers_text" | sed -n 's/^Permissions-Policy: *//Ip' | head -1)"
  rm -f "$edge_play" "$edge_manifest" "$edge_play_headers" "$edge_manifest_headers"
  trap - EXIT

  say "$((ran - failed)) of $ran module probes passed"
  [ "$failed" -eq 0 ] || abort_module "The public module did not prove the committed artifact and policy."
  ok "Casino module is live and proven at ${MODULE_URL}"
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
