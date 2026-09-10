# Casino account synchronization function specification

Last Updated: 2026-09-09

Status: Implemented and locally verified on `feature/casino-module`; production deployment pending

## Function

Hydrate local Roulette state from the signed-in Casino account, retain local play when cloud state
is unavailable, and push later state changes without silently discarding another device's edits.

## Contract

- Standalone launch reads and writes the existing origin-global local-storage state and reports
  `Local only`. Moving that data into an account is an explicit JSON export/import; the first person
  who signs in on a shared browser never silently inherits prior standalone play.
- Embedded launch reads `readState` after the exact-origin Casino handshake.
- The read response includes an opaque, server-derived account scope. Embedded local application,
  UI and sync-metadata keys are partitioned by that scope before any account data is rendered or
  written. No raw account id or credential crosses the frame boundary.
- If the account has no snapshot, its scoped local snapshot is created at expected revision zero.
- If both exist, saved sessions merge by stable id and larger `modified`; active Game/Live slots and
  preferences come from the newer snapshot envelope. Factory-created session timestamps do not
  overrule real account state on a fresh device.
- Legacy local data with no sync metadata derives its age only from timestamps already in that data;
  opening an old device never fabricates a new timestamp that could overtake a reset tombstone.
- Once Casino supplies an account scope, changes remain saved beneath that account's opaque device
  key even when the database read is unavailable. Without an authenticated scope, the app remains
  usable but says plainly that changes are not saved.
- A reset advances a monotonic account epoch. A device that has not observed that epoch adopts the
  reset snapshot before any later offline edits can participate, preventing pre-reset history from
  returning merely because the stale device's wall clock is newer.
- Every local edit and reset advances a logical clock beyond the largest timestamp already observed,
  even when the device wall clock is behind. Equal-clock snapshots and same-id sessions use a
  canonical content tie-breaker, making the merge commutative rather than dependent on argument order.
- Local changes are debounced. `writeState` carries the last observed revision. A 409 merges the
  returned state with the latest local edit and retries; an older receipt never replaces an edit
  made while the request was in flight, and no failed write is labelled synchronized.
- The visible meter distinguishes loading, synchronized, local-only and unavailable states.

## Consumers and data

The main application supplies its whole persistent `appState` object and applies hydrated state.
Session history, current Live/Game sessions, tracks and settings are downstream consumers. The
snapshot is private user application data. It crosses only the postMessage bridge to the Casino
shell and the authenticated state API; no cookie or raw account id crosses into Roulette. The
opaque scope is a storage namespace, not an authentication capability.

## Intent versus built

Intent: the contract above. Built: scoped local storage, initial hydration gate, revisioned writes,
conflict merge, reset tombstone and visible device/cloud states implement that contract. Public
deployment and the authenticated two-browser exercise remain pending until promotion.

## Open questions

None.
