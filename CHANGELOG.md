# Changelog

Last Updated: 2026-10-29

Notable code and documentation changes are recorded here. Release versions are assigned only when
`develop` is promoted to `main`; feature-branch work remains under Unreleased.

## [Unreleased]

### Changed

- Tapping and long-pressing anywhere in the app no longer selects or highlights text or opens the copy menu, so fast number taps at the table are not interrupted. Text fields still allow selection.

### Refactored

- `App.jsx` was split into page and helper components (1488 to 970 lines) with no behaviour change, to make room for the spin tools. The duplicated drought grid is now one component.

### Fixed

- Dialogs now close only when a press both starts and ends on the dark backdrop. A drag that begins inside a dialog and ends outside it no longer dismisses it.

### Planned on this branch (not yet built)

- "Clear all" for the recent numbers, keeping the session, bankroll, buy-ins, cash-outs and history.
- Long-press any recent number to correct it, with the session's statistics recalculated as if the right number had been entered.
- Read recent numbers from a photo of the table's history board, always through a review screen before anything is added.

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
