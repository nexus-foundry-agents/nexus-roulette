# nexus-roulette
Nexus Roulette Tracker

Last Updated: 2026-09-09

Staff URL (Connect login required): https://nexus-foundry.ai/roulette/
Public friend mirror (GitHub Pages): https://nexus-foundry-agents.github.io/nexus-roulette/
Nexus Casino module: https://roulette.nexus-foundry.ai/

Build, deploy surfaces, branch flow: docs/DEPLOYMENT-MAP.md

## Strategy tracks read out their own bets

Every strategy track states exactly which bets it places — `1st Dozen 1-12`,
`2nd Col 2,5..35`, `Red`, `#17` — as colour-coded chips, so a track never has to
be identified by cross-referencing a coloured dot against the table.

- The chip colours are the same palette the dozen/column pickers and the drought
  cards use, so a track's colour already matches the dozen or column it bets on.
- A new track is automatically coloured after its first target; when that colour
  is already taken by another live track it falls back to the generic rotation so
  two tracks stay tellable apart.
- The read-out appears on Game and Live track cards, the Full Table header and
  its track tabs, Abandon Progression and Resume Closed Track buttons, Session
  Stats, every Experimental strategy row, and the result flash after each spin.
- Add Track and Edit Config show a live **This Track Will Bet** preview before
  you commit, and say `⚠ No bet selected` when nothing is picked.

All of it derives from `betTargetList()` / `betTargetText()` / `pickTrackColor()`
in `nexus-src/src/constants.js` — add a bet type there and every surface picks it
up. The `BetTargets` chip component lives in `nexus-src/src/components/ui.jsx`.

## Build

```
npm ci --ignore-scripts
node nexus-src/build.js      # concatenates nexus-src/src/* -> index.html at repo root
node nexus-src/module-manifest.mjs --write  # deterministic Casino declaration
```

`node_modules` is gitignored. `package.json` and `package-lock.json` pin the build inputs so a clean
CI checkout and a release workstation generate the same artifact.

Serve the repo root with any static server to run it locally.

Every release must bump all three in lockstep, or the update poller loops:
`APP_VERSION` in `nexus-src/src/constants.js` (plus a `CHANGELOG` entry),
`version.json`, and `CACHE` in `sw.js`.

## Deploy

```
./deploy.sh --check      # every preflight, ships nothing — run this first
./deploy.sh --prod       # staff-gated nexus-foundry.ai/roulette/
./deploy.sh --mirror     # public GitHub Pages friend mirror
./deploy.sh --module     # dedicated Nexus Casino module origin
./deploy.sh --all        # established staff surface + public mirror
./deploy.sh --module     # separately transacted Casino module surface
```

Run from the repo root on `main` with a clean tree. The script enforces the version lockstep
above, runs the full test suite, refuses to ship an `index.html` or `module.json` that does not
rebuild deterministically, refuses to ship changed app bytes under an unchanged version, and
verifies each deployed artifact on the server and through the public edge. Production destinations
are fixed in the script; `--help` names the optional authenticated verification credential.

Surfaces, the auth gate and the branch flow: `docs/DEPLOYMENT-MAP.md`.
