# ADR-0003: Keep the dedicated origin and use first-party account sync

Last Updated: 2026-09-09

Status: Accepted

Supersedes: [ADR-0001](ADR-0001-dedicated-casino-module-origin.md)

## Context

The dedicated Roulette origin remains the browser isolation boundary for the complete standalone
application. Google Drive backup was a workaround for cross-device storage before Roulette could use
the authenticated Casino application. It required third-party identity code and a sandbox escape for
its OAuth popup.

## Decision

Keep the dedicated origin and local-first state. Remove Google identity and Drive code completely.
When Casino frames Roulette, synchronize the app snapshot through two additional operations on the
existing exact-origin, source-pinned, game-pinned bridge. The shell owns the authenticated database
call and never gives Roulette a credential. Use optimistic revisions and deterministic session
merging so concurrent devices cannot overwrite unseen state silently.

Return a stable opaque scope derived by the shell for the authenticated account. Roulette uses it
only to partition local application, UI and synchronization keys on shared browsers. Embedded mode
does not read or display the legacy origin-global keys before that scope arrives.

## Consequences

Standalone Roulette continues to save locally and to export/import JSON files. Moving standalone
data into an account is explicit import, not an automatic claim by the first signed-in account on a
shared browser. Inside Casino, saved sessions and preferences follow the signed-in account across
devices. Once an account scope is known, a cloud outage retains scoped device-local saving. Without
that authenticated scope, play remains available but the interface states that it is not saved. The
host policy needs no Google allowlist and the Casino frame no longer needs popup escape.
