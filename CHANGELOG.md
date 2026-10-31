# Changelog

Last Updated: 2026-10-31

Notable code and documentation changes are recorded here. Release versions are assigned only when
`develop` is promoted to `main`; feature-branch work remains under Unreleased.

## [Unreleased]

### Fixed

- After a board photo's numbers are added, the recent-numbers strip on the Live page shows every number that Add entered, including a repeated number at the oldest end of the list (for example 2, 2, 2). The strip showed only its newest 30 spins, so the oldest entries of a longer list were hidden. The entries were already kept in the session, the saved state and the recording.

## [0.56.0] - 2026-10-31

### Added

- `solutionInRange()` and `solutionInRangeMember()` in `nexus-src/src/engine.js` are the one definition of which numbers are in range for The Solution: a straight number whose miss count is at or above the track's entry threshold, never a zero, listed coldest first. `test/solution-pick.test.mjs` pins the rule from first principles.

### Changed

- The Experimental simulation's The Solution enrols and resolves numbers through `solutionInRangeMember()` in `nexus-src/src/simulation.js`, the same predicate the live Solution uses. The enrolment order and the results are unchanged.
- The Solution picker (`nexus-src/src/components/SolutionPicker.jsx`) lists the six coldest numbers, each with its miss count and single-number percentile tier (P75 green, P95 yellow, P98 red). It appears in the track setup, on the Solution panel and in the candidate card. Numbers at or past the entry threshold are marked "in range"; ties keep wheel order. One tap on a number makes it the chased number and adds its bet. Every bet the track already holds stays, with its level, until its × removes it. A number below the entry threshold enters at once, and the card says "below entry (misses/threshold)". In the track setup nothing is held yet, so a tap there replaces the pending choice; with exactly one number in range, the setup preselects it. A live track does not place a bet on its own.
- The Solution track card and the panel header read "Chasing 33 - 92 misses", recounted after every spin. After the chased number hits they read "33 hit - pick the next number", even if other bets are still held. Active Bets lists every held bet with its level and ×; the chased one is marked CHASING. Adding several bets from the in-range list is still an explicit tap, and it does not change the chased number.
- The Solution's Tap Winning Number grid marks the chased number with the track's colour ring and a CHASE label. Every held bet keeps its level badge. The last hit keeps its JUST HIT colouring. The number just tapped flashes, as it does on the progression grid.
- Edit Config on a Solution track has an Entry Threshold stepper, the same control the track setup uses. Saving it changes that track in place: its held bets, levels and chased number are kept, the in-range list and the picker update at once, and the threshold never changes how a bet settles, so it takes effect from the next spin. Before this change, saving any edit on a Solution track parked it and started a new track with no bets; a Solution edit no longer does that. Progression and Custom Bet edits are unchanged.
- The live in-range list and candidate list in `nexus-src/src/App.jsx` call `solutionInRange()`, the same predicate the simulation uses.

### Fixed

- Changing the roulette type in Settings, or restarting onboarding, kept the spin history but reset every drought count to zero. The counts are now recounted from the kept spins (`droughtsFromSpins()` in `nexus-src/src/engine.js`), so the board matches the history at once.
- The Solution's default entry threshold was a literal 120 wherever it was used. The candidate card and every new Solution track ignored any other value, so a default of 90 set in the track setup was not applied there and was back at 120 the next time the setup opened. The default is now one setting, `settings.solEntryDefault`, read by `solEntryDefault()` and `solDefaultCfg()` in `nexus-src/src/engine.js`. The setup's Entry Threshold stepper saves it, and new Solution tracks, the candidate card and the picker read it. A Solution track keeps the threshold it was created with.

### Open

- A live report says The Solution showed the last number to hit rather than the coldest. The picker and the chase line (see Changed) show the chosen number. The on-device check is UNVERIFIED: no browser suite was run for this change.
- The default entry threshold has no Settings row. `nexus-src/src/components/SecondaryPages.jsx` is outside this change's lines, so the stepper in the track setup is the only place that sets it. `defaultSolCfg()` in `nexus-src/src/session.js` still holds a literal 120; the app overrides it with `solDefaultCfg()`.
- The picker's tier colours are the operator's ruling (green P75, yellow P95, red P98), which he states match the F10 board outlines. The F10 outline code is not in this tree, so that match is not verified here. The drought tiles use `TIER_COLORS` in `nexus-src/src/components/SectionTile.jsx` (amber P75, orange P95, red P98). Aligning the tiles is a separate later change.
- A bet placed partway through a session (a chase tap, or a + in the in-range list) replays from the track's creation spin at level 0, so a spin correction on that track is refused. The refusal changes nothing, but its message says a ghost spin was logged, which is not the cause. Reproduced: a track holding 17 from spin 0 is corrected at spin 2 with 33 chased from spin 5, and the correction is refused; without the 33 tap it is accepted. The cause is `startingSolutionBets` in `nexus-src/src/spin-apply.js`, outside this change's files. A ruling is needed: record the spin each bet was placed, and replay each bet from that spin.
- The brief asked that the American 00 be a Solution target only on the American wheel. The current rule, in both the live panel and the simulation, never offers either zero as a Solution target. The current rule is kept; a ruling is needed.
- Head start for unseen numbers is a display estimate only. The in-range list uses the stored miss count, not the head-start estimate. A ruling is needed on whether the Solution should use the estimate.

## [0.55.0] - 2026-10-31

### Added

- A live session can record its venue: the casino, and either a machine (maker, model and version) or a table (table label and dealer). Every field is optional, and a session without a venue behaves exactly as before, including sessions saved by earlier versions.
- When a Live session starts, a "Where are you playing?" step opens in its own sheet. Each field is a list of values used before, most recent first, with "Add new..." for a value not yet listed. Skip leaves the venue empty.
- The venue can be edited at any time from the Live header, from the current session on the stats page, and from each saved session. Ending a Live session without a venue asks for one first, and Skip ends the session as before.
- A dealer change during a live session is recorded with the spin it starts from (`dealerChanges`, each entry `{fromSpin, dealer}`), so spins can later be split by dealer. A dealer on a saved session that already has a later change is shown and kept as recorded.
- The value lists (casinos, makers, models, versions, tables and dealers) are built from saved sessions and from values entered by hand. Entered values are stored in the device settings, synced with them, and kept across reloads.
- Export and import carry the venue and the dealer changes unchanged.
- The session list and the stats page show the venue line. The stats page adds "Spins logged by venue": spin counts per casino, per machine and per table and dealer across saved sessions, with spins that have no venue counted on their own line. These are counts only.
- Dealer names stay in the account's own sessions, on the device and in the account's own sync. They are not sent to analytics, logs, feedback reports or any shared output.

### Changed

- Clearing the numbers of a session restarts its dealer record at spin 0, with the dealer still at the table, and Undo puts the record back. Clearing the spin history on the stats page does the same.

## [0.54.0] - 2026-10-31

### Added

- Each number square on the roulette board, on the Live page and the Game page, 0 and 00 included, gets a subtle outline from its current losing streak's percentile on the wheel in use: green from the 75th percentile, yellow from the 95th and red from the 98th, the highest tier reached winning. The outline is a 2 px ring drawn outside the square, so the board's layout, its borders and the tap area are unchanged.
- Settings has a "Percentile outlines" switch, next to "Counter shows". It is on by default and is saved with the other settings.

## [0.53.0] - 2026-10-31

### Added

- Each dozen and column tile on the drought panel, on the Live page and the Game page, shows six readings at once with no tap. The section's current losing streak is the largest number, with a corner badge for the highest percentile tier it has reached (P25, P50, P75, P95 or P98) and its exact percentile in a small label. Below it: the section's total loss level (TLV) with a small sparkline of TLV since the current losing streak began (the last 50 spins when there is no streak); the average loss level, which is TLV divided by 12 to one decimal, with its tier; the maximum single-number loss level in the section, which is its coldest number, with its single-number tier; the count of the section's numbers at or above their single-number P95; and the TLV's own tier. TLV is the sum of the loss levels of the section's 12 numbers.
- Tapping a dozen or column tile opens the app's shared modal as a detail view of that section: a TLV chart for the whole session with the current losing streak shaded and reference lines at the TLV P50, P75, P95 and P98; the streak, TLV, average and maximum, each with its exact percentile; the section's 12 numbers with their loss levels and single-number percentiles, coldest first; and the count at or above P95. It closes from the backdrop or its Close button.
- The percentile set for every bet, every single number and both section distributions is P25, P50, P75, P90, P95 and P98. The generator also records, for both wheels, the TLV distribution of the dozen and the column sections, sampled after every spin of the 1,000 sessions of 1,000,000 spins, and the distribution of the average loss level (TLV / 12, to one decimal). The generator prints its own speed.
- `nexus-src/src/tlv.js` holds the pure functions for the section readings: the TLV update for one spin, the section TLV, average, maximum and count at P95, the TLV history for the sparkline and the detail chart, and the percentile tier mapping.

### Changed

- The dozen and column cards on the drought panel are replaced by the section tiles described above. The panel is taller: its reserved height is recalculated from the tile's fixed row heights.
- The Stats page's "Streak percentiles" table gains a P25 column, so it lists P25, P50, P75, P90, P95 and P98.
- The Game page renders the drought panel from the start, with zero values before the first spin, instead of adding it after the first spin, so nothing below it moves.

### Fixed

- While picking the winning number on the Live table, a tap anywhere inside a number's square selects that number. The loss counter under each number sits in the square's lower edge, which the table reads as a split or corner when placing bets, so those taps were silently ignored when picking a hit. Placing bets still reads the tap position as before.
- The progression grid's zero row shows the wheel's own zeros. A European wheel shows a single 0 and no 00 cell; it was showing 0 and 00 on both wheels.

## [0.52.0] - 2026-10-30

### Added

- Streak percentiles for every bet, both wheels. `tools/gen-streak-percentiles.mjs` runs a seeded simulation of 1,000 sessions of 1,000,000 spins per wheel and writes `nexus-src/src/streak-percentiles.js`. For each even-money bet, dozen, column, group-bet shape (split, street, corner, six-line, and the basket on American) and single number, it records the streak length at P50, P75, P90, P95 and P98, and the cumulative distribution up to the 99.99% length. A completed losing streak is a run of consecutive spins a bet loses before its next win.
- `streakPercentile()` in `nexus-src/src/percentile.js` places a current losing streak on that distribution and returns its percentile to one decimal, rounded down.
- Stats page: a "Streak percentiles" table lists the P50 to P98 streak lengths for every bet on the current wheel, with the simulation size and seed in small print.
- The even-money, dozen and column drought cards show each count's percentile beside it, for example `P96`, in a reserved row that keeps the same size whether or not a percentile is shown.
- Settings: a "Counter shows" row, directly under Head start for unseen numbers, chooses Spins (the default, unchanged) or Percentile. In Percentile, the small count under each number on the roulette board and the progression grid shows that number's percentile on the current wheel, for example `P96`. An unseen number with the head start on keeps its `~`.
- Custom Bet tracks on the Full Table page show a per-spot card above the levels list. It shows the selected level: for each spot its label, the bet on that spot this spin, the payout if that spot hits and the net if it hits. The payout is the gross return of every position that covers the spot's worst number, with overlapping positions counted together. The net is that payout less the bankroll the level needs. Tapping a level row selects it, and the selected row is outlined. The card opens on the track's current level. Its height depends only on the number of positions, so selecting another level moves nothing. Flat-mode Custom Bet tracks, which have one level, show that level in the same card.
- The per-spot arithmetic is one pure function, `computeSpotBreakdown` in `nexus-src/src/engine.js`. Its hand-computed cases are in `test/progression-planner.test.mjs`.

### Changed

- On Custom Bet tracks, the Full Table column headed "Invested" is headed "Bankroll needed", and the legend says it is the cumulative stake needed to play up to that level. The legend for "Bet" on these tracks says it covers all spots this spin. Other track types keep their existing headings and legend.
- The selected Custom Bet level is kept in the app, beside the selected track. Choosing a different track, or a track being selected from the Game tab, clears the level pick back to the track's current level.

## [0.51.0] - 2026-10-30

### Added

- A "Spins Since Last Hit" setting in Settings, beside Vibration, on by default. When it is on, a small muted count under each number shows the spins since that number last hit, the same count the drought panel uses. It covers 0 and 00 on the roulette board and on the progression grid. Off hides the count but keeps its space, so no number moves or resizes. Settings saved before this setting existed read as on.
- A "Head start for unseen numbers" setting, directly under Spins Since Last Hit, off by default. When it is on, a number that has not come up yet this session shows its count plus the wheel size (38 on an American wheel, 37 on a European one), marked with a leading "~", for example ~41. Once a number hits, it shows its true count again, whether the setting is on or off. This changes only what is displayed: the session's drought counts and every strategy that reads them are unchanged. Settings saved before this setting existed read as off.

### Changed

- The progression grid's number cells use 5px top and bottom padding (was 8px) and its 0 and 00 buttons use 7px (was 11px). This leaves room for the new count, and for the overlay dots on a number a track is on, inside the cell's 42px minimum height, so a cell does not grow when a track lands on it.

### Fixed

- `deploy.sh` no longer references `$TAR`, a variable left over from the old tarball upload and never set. After a successful production deploy it printed "TAR: unbound variable" from its exit trap, and on the failure path the same line would have replaced the deploy's exit code with 1 after the rollback ran.

## [0.50.0] - 2026-10-30

### Changed

- The photo reader's "busy" line now reads "Reader busy or warming up, try in 1 min". A cold load can take about a minute. The PC loads its reading model in the background on a cold read and answers busy straight away, so this line also covers the warm-up.

### Added

- Inside Nexus Casino, "Read board photo" asks the Casino shell to open the photo reader instead of trying to leave the frame. It works only from a real tap. When you come back, Roulette asks the shell for the result once, switches to live mode, checks every number again (0-36, and 00 only on an American wheel), and shows the same review screen. Nothing is added until you press Add.
- A board-photo review is tied to the session and wheel it was read for. If the session or its wheel changes before you press Add (for example a Casino sync restores a different session), the review is dropped. The whole list is checked again when you press Add, so a 00 can never be added to a European session.
- "Read board photo" in live mode opens the photo reader on the Nexus Foundry app. The numbers it reads come back only as an untrusted list in the address fragment, which is cleared at once and validated (0-36, 00 only on American wheels, at most 40). They open a review screen, most recent first, where each can be corrected with the same picker as long-press. Nothing is added until Add, which enters them oldest first exactly as taps would. A plain line explains when reading is unavailable (for example, the PC is offline).

## [0.49.0] - 2026-10-29

### Added

- Long-press any number in the live recent-numbers strip (half a second, ignored while scrolling) to correct it. A number picker (0, 00 on American wheels, 1-36) replaces that spin and replays the session from its spins, so every tracker, bet, win, progression level, drought, profit and the bankroll come out exactly as if the right number had been entered. Sessions whose history cannot be replayed exactly (for example older sessions with tracks added mid-way) are refused with a reason rather than guessed. A correction does not re-send the spin to Casino recording.

## [0.48.0] - 2026-10-29

### Added

- "Clear numbers" in live mode empties the recent numbers and the tracking derived from them (droughts, bets, wins, progression levels), after an in-app confirm. The bankroll, buy-ins, cash-outs, each track's profit and the session record are kept. An inline "Numbers cleared · Undo" takes the button's place for 15 seconds, or until the next spin. Undo restores only what the clear changed, so a buy-in made in between survives. The recent-numbers strip and drought panel keep their space, so clearing moves nothing on screen.

### Changed

- Tapping and long-pressing anywhere in the app no longer selects or highlights text or opens the copy menu, so fast number taps at the table are not interrupted. Text fields still allow selection.

### Refactored

- `App.jsx` was split into page and helper components (1488 to 970 lines) with no behaviour change, to make room for the spin tools. The duplicated drought grid is now one component.

### Fixed

- Dialogs now close only when a press both starts and ends on the dark backdrop. A drag that begins inside a dialog and ends outside it no longer dismisses it.

### Changed

- The official Nexus Roulette icon, which is also its module icon in Nexus Casino, is now the crystal wheel on an aurora-glass tile. The pockets are drawn in code in true American wheel order (0 and 00 green, red pockets in NF magenta, black pockets in NF blue), with the Nexus Foundry fox mark at the hub. Master: `images/Nexus_Roulette_App_Icon.png` (1024 px, rounded-tile alpha, no cyan).
- `icon.svg` keeps its name, so the favicon, the PWA manifest, the service worker, the Simulation-complete notification and the deploy ship list all pick up the new art unchanged. It now embeds the new icon (512 px), clipped to the rounded tile.
- The module declaration's icon changed from the glyph `◉` to an image (`https://roulette.nexus-foundry.ai/icon.svg`), which the Casino gallery draws. The service-worker cache is now `nexus-roulette-v134`, so installed copies fetch the new icon. The release version still changes only at promotion.

## [0.47.0] - 2026-09-09

### Added

- A Casino module declaration and dedicated module deployment target, preserving the complete
  existing Roulette application on a separate origin.
- A durable nginx site definition with frame ancestry restricted to Nexus Casino and no third-party
  identity or storage endpoints.
- Contract, deployment and browser-capability tests for the module surface.
- Casino recording-bridge support for Live and Game spins, including exact wager/return totals,
  first-spin session start, visible pause/resume/stop controls and fail-closed bridge errors.
- An embedded-notification fallback that opens the dedicated Roulette surface, where browsers allow
  notification permission to be requested directly.
- A ratcheted file-size guardrail that blocks new or growing source files at 1,500 lines while
  reporting unchanged legacy debt.
- Lossless first-spin and retry handling for Casino recording, with one-based sequence numbers and
  automatic duration pauses while another application mode is active.
- Mode changes now send an in-flight spin and pause together on the first request, so central
  duration does not keep running while an ambiguous spin exhausts its retry window.
- A spin definitively refused because recording is off is discarded from the retry slot and turns
  recording availability off, so it cannot be written retroactively after collection resumes.
- Casino recording assigns each spin a stable idempotency UUID, preventing a competing browser tab
  at the same sequence from being mistaken for this tab's successful retry.
- The complete rendered American zero sector, including the `0/00/2` three-number control.
- A locked build manifest so CI and local release builds compile the committed app with identical
  React and Babel versions.
- First-party, per-account Casino synchronization for Roulette sessions and preferences, with local
  operation when standalone, revision-aware conflict merging, visible sync state, and JSON
  download/import retained as manual backup and restore.
- The pinned `@nexus-foundry/nf-ui` package and its shared tokens/control styles, consumed from a
  committed vendor artifact by the deterministic Roulette build.

### Changed

- Casino-specific recording and notification controls now use the shared UI package. Existing
  gameplay controls remain unchanged during the compatibility port and are explicitly bounded by
  the application-stack migration decision.
- The single deployment script can deploy and verify the existing staff surface, public mirror and
  Casino module surface without creating a second deployment path.
- A release now fails closed when the remote branch cannot be fetched or the local commit is not
  the exact pushed release commit; check-only mode reports the unverified condition without shipping.
- Secondary Live-mode pages are separated from the legacy application component so bridge work does
  not grow a source file beyond the repository ceiling.
- Production destinations are fixed literals, and rollback refuses to overwrite a newer release.
- The existing staff deployment now stages and swaps the whole artifact directory atomically,
  retains a conditional rollback through edge verification, and refuses to call an unreadable live
  copy a first deployment.
- A reused module release must match the fresh candidate as a complete directory, so an extra public
  file cannot hide inside a supposedly immutable commit-addressed release.
- Staff deployment and verification rollback now track the moment the old live directory moves
  aside and restore either the prior release or the known candidate on every intermediate failure.

### Fixed

- The complete American table hit rules are now shared, directly tested rules used by the rendered
  table, so every one of the 161 bets declared to Casino is demonstrably selectable in Roulette.
- Starting a second central recording session in the same browser now resets its next sequence to
  that session's own spin count instead of inheriting the stopped session's counter.
- Legacy account-scoped data no longer receives a fabricated current timestamp on first launch,
  while real device-local changes advance sync metadata, so an account reset cannot be resurrected
  merely by opening an older device; work made after that device observes the reset participates in
  later merges under the new reset epoch.
- Reset timestamps now act as monotonic account epochs: a device that has not observed the epoch
  adopts the reset before its later offline edits can merge, so old history stays deleted.
- Fresh-device factory sessions no longer displace real remote active sessions, and a conflict now
  merges the newest in-flight local edit without applying a stale receipt over it.
- Account sync clocks now advance beyond every timestamp already adopted from another device, and
  equal-clock conflicts use a canonical tie-breaker, so clock skew or same-tick edits still converge.
- Offline copy now distinguishes account-scoped device saving from the no-scope case where changes
  cannot be persisted safely; standalone data enters an account only through explicit export/import.
- Device-save copy now follows an observed successful browser-storage write and turns unhealthy when
  a quota or security refusal occurs; a failed write can no longer be described as saved.
- Deterministic builds normalize the generated application to LF, and release deployment no longer
  has a flag that can skip rebuilding and comparing committed application bytes or bypass the
  required application-version/cache change.
- CI enforces the source-file ceiling on every branch, including production.

### Removed

- Google Drive sign-in and cloud backup. Backups now use the existing JSON download and file-import
  controls, keeping session data local and removing the external OAuth dependency.
