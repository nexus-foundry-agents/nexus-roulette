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

## 2026-10-29 spin tools round (feature/roulette-spin-tools)

Agent-active time per worker run (Haiku 5.5, xhigh; Opus supervisor):

| Item | Run | Start | Done | Elapsed | Outcome |
|---|---|---|---|---|---|
| F1 clear all | 1 | 08:53 | 08:56 | 3m 09s | rework (stopped before editing; scope gaps found) |
| F4 no text selection | 1 | 08:57 | 08:59 | 2m 42s | accepted (2fa3be7) |
| B1 modal backdrop | 1 | 08:57 | 09:01 | 4m 21s | rework (closing on pointerup lets the click fall through) |
| B1 modal backdrop | 2 | 09:02 | 09:03 | 6m 50s | accepted |
| N0 split App.jsx | 1 | 09:00 | 09:14 | 14m 11s | accepted |
| F1 clear all | 2 | 09:15 | 09:23 | 7m 54s | rework (overlay toast over the grid; strip reflow) |
| F1 clear all | 3 | 09:23 | 09:32 | 17m 33s worker | accepted |
