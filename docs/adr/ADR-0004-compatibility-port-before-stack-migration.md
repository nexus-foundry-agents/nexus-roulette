# ADR-0004: Preserve the Roulette engine during the compatibility port

Last Updated: 2026-09-09

Status: Accepted

## Context

Roulette is an existing React application compiled by a deterministic static build. Nexus Casino is
a Next.js App Router product. Rebuilding Roulette in a different application stack during its first
Casino installation would combine two independent changes: moving the complete gameplay engine and
changing the runtime around it. A gameplay regression would then have no isolated cause.

The legacy application also predates the shared `@nexus-foundry/nf-ui` component package and still
contains local controls and browser confirmation dialogs. Deepening those patterns is not acceptable.

## Decision

Ship the first Casino module as a compatibility adapter around the existing Roulette application.
Keep its engine, session model, simulation worker and established controls unchanged. Consume the
exact vendored `@nexus-foundry/nf-ui` package in the build, and use its public control classes for
every interactive control introduced by this integration.

Do not add another local dialog or control implementation. The existing browser dialogs and legacy
control markup are migration debt, not precedent.

## Consequences

The port can be compared directly with the existing application and deployed as an isolated static
module. The repository remains outside the target web-product stack temporarily, and existing local
controls are not yet unified with other Nexus products.

The constraint owner is the product engineering role. The deterministic build, complete suite and
authenticated browser exercise verify the compatibility boundary for this release.

## Exit condition

Before the next Roulette feature that adds an interactive control, route or dialog, migrate the
application to Next.js App Router with strict TypeScript, replace legacy duplicate controls with
shared components, and add any missing dialog primitive to `@nexus-foundry/nf-ui` first. Record that
migration in a superseding ADR and re-run the gameplay and module-contract suites against the new
runtime.
