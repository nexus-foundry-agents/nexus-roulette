# Nexus Casino module surface

Last Updated: 2026-09-09

Status: Implemented and locally verified on `feature/casino-module`; production deployment pending

## Purpose

Publish the existing Roulette application as a Nexus Casino remote module without forking its UI,
state model or simulation logic. The same committed static application is served at a dedicated
origin so the browser, rather than a naming convention, enforces separation from Casino sessions.

This compatibility port retains the deterministic legacy bundle for gameplay parity while consuming
the pinned shared UI package for every control added by the Casino integration. ADR-0004 records the
bounded migration decision and its exit condition.

## Deploy origin

| Item | Value |
|---|---|
| Repository/path | Repository root static artifacts plus `module.json` |
| Artifact | `index.html`, `sw.js`, `manifest.json`, `version.json`, `icon.svg`, `module.json` |
| Module host | `roulette.nexus-foundry.ai` on the shared application host |
| Server root | `/var/www/casino-module-roulette/current` (an atomic symlink to an immutable release) |
| Durable site config | `deploy/roulette-nexus-foundry.conf` |
| Pipeline | The repository's sole `deploy.sh`, module target |

Production deploys only from `main`. The script copies the committed artifact set, installs the
committed site configuration, validates nginx before reload, verifies every deployed hash, then
probes the public manifest and play surface without a cache-buster.

## Manifest contract

The generated `module.json` publishes identity `roulette`, play surface `/play`, 38 equal-weight
American-wheel outcomes and all 161 controls rendered on its table. This describes the
application's default. The application retains its existing American/European wheel selector.

The manifest is generated deterministically from `nexus-src/module-manifest.mjs`. A test compares
the committed document byte-for-byte with fresh output so source and deploy artifact cannot drift.

## Data touched and privacy class

| Data | Class | Owner/path | Failure behavior |
|---|---|---|---|
| Manifest and static application | Public application data | Dedicated module origin | Deployment or health check fails closed |
| Roulette sessions/settings | Private user data | Browser storage plus account/game-scoped Casino state | Local recovery remains; remote failure is visible |
| Casino recording events | Private user play data | Exact-origin message bridge to Casino | Refused unless Casino introduces itself and recording is enabled |
| Casino session cookie | Confidential credential | Casino origin only | Not sent to or readable by module origin |

## Browser and host policy

Casino alone may frame the production module. The host permits the existing inline application,
denies every third-party script and connection, denies framing by other origins, sends no Casino
credentials, and does not enable camera, microphone, geolocation or payment. The Casino frame grants
modal dialogs, downloads and a still-sandboxed same-origin notification popup.

## Upstream and downstream

Upstream producers are Roulette source, the deterministic builders and the `main` commit selected by
`deploy.sh`. Downstream consumers are the module manifest fetch in Casino, the `/play/roulette`
frame, Roulette service-worker updates, browser local storage and the authenticated Casino state
bridge. A stale manifest leaves the Casino tile unavailable; a stale application artifact
is caught by local-versus-remote hashes and the public body comparison.

The module accepts the Casino recording handshake only from the literal Casino origin and only from
its parent window. Live and Game keep separate central sessions. Each captured/generated spin sends
its exact pocket, stake map, total staked and gross return; only a spin with no wager is marked as
watched. The first spin waits for the settings handshake, sequences are one-based, and ambiguous
writes retry the identical payload before another spin can pass. If a mode changes with a spin in
flight, the first follow-up request records that idempotent spin and banks the pause in one database
transaction; duration never waits behind the retry queue. Automatic resume does not override a
user's manual pause. A server refusal because collection is off clears the rejected retry payload;
re-enabling collection cannot write an off-period spin retroactively. Simulation runs are not Casino
play sessions.

The same pinned bridge reads and conditionally writes one Roulette snapshot for the signed-in
account. Local and server snapshots merge saved sessions by id and modification time. Active-session
slots and preferences follow the newer envelope, and a reset tombstone prevents another device from
resurrecting deleted history. Revision conflicts are merged and retried rather than overwritten.

Cross-origin frames cannot request browser notification permission. When embedded, the existing
completion-notification control therefore opens this dedicated surface in a normal tab; the user can
grant notification permission there. The simulation itself remains fully usable inside Casino.

## Intent versus built

Intent: the whole existing application is launchable from Casino and keeps its present standalone
surfaces and features.

Built: the deterministic application, manifest, bounded host policy, recording bridge, per-account
sync and atomic deploy path are implemented and locally verified. This section will carry the
deployed commit and observed public probes after promotion.

## Verification

- Deterministic build of `index.html` and `module.json`.
- Manifest shape, counts, bet coverage, uniqueness and payout checks.
- Nginx syntax and policy assertions, with a planted-control test.
- Full repository test suite and deploy-script check mode.
- Public manifest and play-surface body matches.
- Authenticated browser launch from Casino, modal, export and two-device sync exercises.
- Browser: Live and Game spins reach separate Casino recording sessions with exact financial totals;
  pause, resume and stop change the server record and are visibly reflected in the module.

## Open questions

None. Wheel variants remain selected inside Roulette; the shell declaration represents the default
American wheel until the shared module contract introduces variants.
