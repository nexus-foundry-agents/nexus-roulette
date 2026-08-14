# nexus-roulette
Nexus Roulette Tracker

Staff URL (Connect login required): https://nexus-foundry.ai/roulette/
Public friend mirror (GitHub Pages): https://nexus-foundry-agents.github.io/nexus-roulette/

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
npm install --no-save --prefix . react@18 react-dom@18 @babel/core @babel/preset-react @babel/preset-env
node nexus-src/build.js      # concatenates nexus-src/src/* -> index.html at repo root
```

`node_modules` is gitignored and there is no `package.json` by design, which has
two consequences worth knowing before you build:

- Pass `--prefix .` or npm walks up and installs into a parent directory, and the
  build then fails on a missing `node_modules/react/umd/react.production.min.js`.
- List every package in one `--no-save` command. A second `--no-save` install
  prunes the packages from the first one (there is no manifest to remember them),
  which silently breaks the next build.

Serve the repo root with any static server to run it locally.

Every release must bump all three in lockstep, or the update poller loops:
`APP_VERSION` in `nexus-src/src/constants.js` (plus a `CHANGELOG` entry),
`version.json`, and `CACHE` in `sw.js`.
