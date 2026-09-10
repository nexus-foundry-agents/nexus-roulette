# ADR-0001: Serve Roulette to Casino from a dedicated origin

Last Updated: 2026-09-09

Status: Superseded by [ADR-0003](ADR-0003-first-party-account-sync.md)

## Context

Casino loads independently maintained game modules in sandboxed cross-origin frames. The Roulette
application already ships as a standalone static product, with local storage, service-worker and
optional Google Drive behavior that should not be reimplemented in the shell. Serving it under the
Casino host would give script and same-origin privileges access to Casino state. Framing the public
repository mirror would provide no controllable security headers.

## Decision

Serve the committed Roulette artifacts at `roulette.nexus-foundry.ai` with a repository-owned nginx
configuration. Publish a deterministic `module.json` at the origin root and map `/play` to the same
application entry point. Permit framing only by the Casino origin.

## Consequences

Roulette keeps one implementation and its existing storage model while Casino credentials remain on
the Casino origin. Deployment gains one target in the repository's existing deploy script and one
DNS/TLS hostname. Google OAuth must recognize the dedicated origin for Drive sign-in; deployment is
not complete until the popup reaches the provider from an embedded browser exercise.
