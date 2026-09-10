# ADR-0002: Adapt Roulette to the Casino recording bridge

Last Updated: 2026-09-09

Status: Accepted

## Context

Nexus Casino offers per-game central recording and wraps installed remote modules in a narrow
message bridge. The standalone Roulette application predates that contract and keeps sessions only
in browser storage. Loading it unchanged would make Casino's Roulette recording switch claim that
spins were being written while the framed application sent none.

The application's main component was already beyond the 1,500-line source ceiling. Adding bridge
logic there before splitting it would deepen the monolith and make the integration harder to test.

## Decision

Move the secondary Live-mode pages into their own source module before changing the main component.
Add a dedicated Roulette-side bridge client that accepts a hello only from the literal Casino origin
and the parent window, uses the Casino operation vocabulary, and fails closed when a reply is absent
or refused.

Live and Game maintain separate recording sessions. The first actual spin waits for the handshake,
then starts or rejoins the appropriate session. Every recorded spin carries the exact outcome,
stake map, staked total, gross return and whether it had no wager. Sequences are one-based. An
ambiguous write retries the identical sequence and payload before any later spin may pass, so a
lost response cannot become a lost spin. Simulation runs do not enter Casino recording. Switching
modes pauses central duration; pause, resume and stop remain explicit user controls in the frame.

## Consequences

Roulette retains its existing local sessions and standalone behavior. When launched by Casino and
recording is enabled, it additionally writes a server-side record through the shell without ever
receiving a Casino cookie or token. If the bridge is absent, recording is visibly unavailable; if
recording is disabled, the application says so. A rejected write never advances the client sequence.

The published message protocol is duplicated across repositories by necessity. Contract tests in
both repositories must assert the same message kinds and operation names whenever that interface
changes.
