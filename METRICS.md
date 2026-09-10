# Nexus Roulette delivery metrics

Last Updated: 2026-09-09

Only agent-active work is counted. Review, operator response time, and unattended waits are not.

## Casino module port

| Measure | Value |
|---|---:|
| Started | 2026-09-09 15:45 PDT |
| Agent-active time | In progress (245 minutes through full verification) |
| First-pass quality | 5/10 before operator testing |
| Automated tests | 42 passed, 0 skipped |
| Public verification probes | Pending |

This ledger measures the module repository. The Casino shell keeps its own record for registry,
frame-boundary and shell deployment work.

The first-pass score records what review actually found: the initial declaration omitted one rendered
zero-sector wager, wagered Live spins were marked as observations, and the first retry/deploy designs
could lose a spin or overwrite a newer release. Those defects were corrected before commit rather
than hidden by the later green run.

Two independent GPT-5 review contexts completed after the fixes. The contract-focused pass found
clock-skew and equal-timestamp convergence defects; the adversarial pass found recording-boundary,
queue-bounding and rollback gaps across the two repositories. Each finding was repaired and both
fresh final passes reported clean.
