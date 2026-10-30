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
| F2 long-press correction | 1 | 09:33 | 12:52 | about 20 min active (paused 09:33-12:30 by the usage limit) | accepted |
| F3.2 photo button + review | 1 | 12:58 | 13:08 | 12m 34s | accepted (held until the server is live) |
| F3.1 NF route | 1 | 12:56 | 13:16 | 21m 28s | accepted (stopped correctly at the relay) |
| F3.1 NF route | 2 | 13:17 | 13:31 | 13m 14s | rework (missing the identity headers the PC requires) |
| F3.1a VP read-board op | 1 | 09:45 | 13:43 | about 70 min active (paused 09:33-12:30 by the usage limit) | accepted after 3 in-run corrections |
| F3.1a review round 2 | 1 | 13:52 | 14:20 | 28m 30s | accepted |
| F3.1a review round 3 | 1 | 14:34 | 17:30 | stopped by the usage limit before any edit | rejected (nothing to commit) |
| F3.1 review round 2 (with F3.1b) | 1 | 14:39 | 17:30 | stopped by the usage limit before any edit | rejected (nothing to commit) |
| F3.1a review round 3 | 2 (Codex Sol 6.1 high) | 18:33 | 18:46 | about 13 min | rework (2 failures once Pillow present) |
| F3.1a review round 3 | 3 (Codex Sol 6.1 high) | 19:13 | 19:16 | about 3 min | accepted (5156d302) |
| F3.1 review round 2 (with F3.1b) | 2 (Codex Sol 6.1 high) | 19:23 | 19:31 | about 8 min | accepted (d574d839) |
| F3.1a review round 4 | 1 (Codex Sol 6.1 high) | 19:31 | 19:48 | about 17 min | accepted (3656eb3f) |
| F3.1d PC frame rule | 1 (Codex Sol 6.1 high) | 20:12 | 20:17 | about 5 min | accepted (709b72a8) |
| F3.1c Pillow pin | 1 (Codex Sol 6.1 high) | 20:12 | 20:17 | about 5 min | accepted with a seat fix: manifest line reverted (709b72a8) |
| F3.3b Casino shell | 1 (Codex Sol 6.1 high) | 20:30 | 20:34 | about 8 min | accepted (ec568b9) |
| F3.3c Roulette framed branch | 1 (Codex Sol 6.1 high) | 20:36 | running | | |
| F3.1 review round 4 | 1 (Codex Sol 6.1 high) | 20:34 | 20:38 | about 4 min | accepted (fc010d6b) |
| F3.1e PC frame set | 1 (Codex Sol 6.1 high) | 20:34 | 20:38 | about 4 min | accepted (b611d096) |
| F3.1 review round 3 | 1 (Codex Sol 6.1 high) | 20:05 | 20:09 | about 12 min | accepted (423010a1) |
| F3.1 NF route | 3 | 13:33 | 14:27 | about 55 min (incl. 503 fix) | accepted |
