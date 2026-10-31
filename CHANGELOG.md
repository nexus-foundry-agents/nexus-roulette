# Changelog

Last Updated: 2026-10-31

Notable code and documentation changes are recorded here. Release versions are assigned only when
`develop` is promoted to `main`; feature-branch work remains under Unreleased.

## [Unreleased]

## [0.74.0] - 2026-10-31

### Fixed

- Restart Onboarding applies the wizard's Min Bet as given. "No minimum" clears an existing table minimum to none, and a number stores that number. `completeOnboarding()` in `nexus-src/src/components/onboarding-apply.jsx` wrote the minimum only when it was truthy, so a restart that left Min Bet at "No minimum" kept the old minimum. The minimum is now written through `tableMinimum()` in `nexus-src/src/session.js`. Max Bet and Max Total in the same function now store any finite number the wizard gives, instead of only truthy ones. The wizard's Max stepper never goes below $1, so the wizard does not change a Max value this way today.

### Tests

- Added `test/onboarding-clears-min.test.mjs`: a restart from a minimum of 10 with No minimum stores none; none to none, none to 5 and 5 to 5 are applied as given; a minimum that is not answered keeps the stored one; the wizard's No minimum reaches the restart as null; Max Bet and Max Total are stored as given, and kept when not answered.

### Open

- The version, `APP_VERSION` and the `sw.js` CACHE name are not bumped by this change; they move at promotion. The cache-bust question for the single-file bundle is still open as recorded under 0.73.0.

## [0.73.0] - 2026-10-31

### Changed

- Table minimum has no default. A new user has no table minimum until one is set in the startup wizard or in Settings. The wizard's Min Bet field starts at "No minimum" and may be left there. Settings shows "No minimum" when none is set, and its stepper returns to none from $0.25. Stored values are not rewritten: an existing user keeps the minimum they have. The migration in `nexus-src/src/session.js` (`loadApp()`) no longer fills $10 for a missing value; a missing value is none (`null`), and `defaultSettings()` stores `null`.
- A base bet below a table minimum that is set is refused, not noted. The base is not applied and the previous base stays. The reserved line under the field reads "This base bet is below your table minimum of $X. Change the bet size, or change the table limit in Settings." The refusal applies in the track setup and in Edit Config, which mount the one control, `nexus-src/src/components/BaseBetInput.jsx`. A preset below the minimum stays visible and shows the same message when tapped. The F16 "Below the table minimum" note is removed; a base already under a minimum that was raised later shows the same message.
- Every reader of `settings.tableMinBet` goes through `tableMinimum()` in `nexus-src/src/session.js`, which reads null, undefined and 0 as no minimum. The `||1` fallbacks are removed from the Live and Game chip filters (`nexus-src/src/App.jsx`, `nexus-src/src/components/GamePage.jsx`), from the track-panel props in both files, and from the Settings stepper (`nexus-src/src/components/SecondaryPages.jsx`).
- The startup wizard's Table Limits copy in `nexus-src/src/components/modals.jsx` describes the refusal and the empty default. Its Min Bet stepper steps from "No minimum" to $0.25, and back to none from $0.25.

### Fixed

- Undo last spin is refused after a track change made after the spin. Adding, closing or reactivating a track, moving a track, adding or removing a Solution bet, or any other change to a track after the spin now refuses Undo with "Undo is off after a track change. Fix the number instead." Undo used to revert those changes silently. The check is one comparison in `undoBlockReason()` (`nexus-src/src/spin-apply.js`): the session's tracks must equal the snapshot's tracks plus the tapped spin's own settlement. No action stamps the record, so an action added later is refused by the same comparison.
- The Undo snapshot records the number the tap recorded. Undo is refused when the session's last spin is not that number, so a same-session replace of that one number is refused with the changed-session reason. The number is held beside the snapshot in `undoBind` in `nexus-src/src/App.jsx`.
- The Undo button keeps its slot in the Add Track row. Its visibility changes and it is never removed, so the Add Track button no longer moves when Undo is offered, refused or gone. The Add Track button keeps its slot while the add panel is open. The Add Track row has the same slots whether or not Undo is available.

### Tests

- Added `test/table-min-rule.test.mjs`: a new user has no minimum and every preset applies; with a minimum of 5, base 2 is refused with the exact message and the base is unchanged, and base 5 applies; Settings clears the minimum to none; the wizard starts at none and may be left there; the migration keeps a stored minimum and gives none for a missing one; no `tableMinBet||` fallback remains in source.
- Updated `test/base-bet.test.mjs` (the warning-only tests, now the refusal and the reserved line) and `test/money-input.test.mjs` (the Table Limits copy assertion) to the new behaviour. The five Settings failures in `test/gold-coldest.test.mjs`, `test/number-drought.test.mjs` and `test/streak-percentiles.test.mjs` were `ReferenceError: tableMinimum is not defined` while the helper lived in `BaseBetInput.jsx`; it now lives in `session.js`, which those harnesses load. No expectation in them changed.
- `test/undo-track-edits.test.mjs`: each track action made after a spin (adding, closing or reactivating a track, moving a track, adding or removing a Solution bet) refuses Undo, and the action stays in place after an Undo press. A replace of the tapped number refuses Undo. The Add Track row has the same slots with Undo offered, refused, absent and while the add panel is open.
- `test/undo-snapshot-class.test.mjs`: a track added after the spin refuses Undo (it was allowed before). The `undoBlockReason()` assertions pass the tapped number, and a snapshot with no recorded number or another recorded number is refused.

### Open

- The visual checks of the wizard stepper, the Settings Min Bet row and the base-bet refusal line at 360 and 390 px are UNVERIFIED: no browser suite was run for this change.
- Settings "Restart Onboarding" can not clear an existing minimum: `nexus-src/src/components/onboarding-apply.jsx` writes the wizard's Min Bet only when it is truthy. The wizard then shows "No minimum" and the stored minimum is kept. That file is outside this change and needs its own item.
- The version and `APP_VERSION` (0.71.0) are not bumped; they move at promotion. The built `index.html` has no `?v=` stamp for this change to bump; the cache-bust question at promotion is open for the supervisor.

## [0.72.0] - 2026-10-31

### Fixed

- Account sync: a change made before the account state has loaded (a spin or a settings change) is no longer dropped when the state loads. It is merged over the loaded account state and pushed. Repeated spin numbers stay separate spins. The rule is in `nexus-src/src/casino-sync.mjs`.
- Account sync: a session change made before the account state has loaded takes the account's active session slot whenever that slot holds work. The choice does not compare the clocks of the two devices. The account session it displaces is kept in saved sessions. A displaced Game session is kept with its Game mode, so it does not appear in the Live list.
- Account sync: a change made before the account state loads that holds no session work (a label or a stamp on an empty session) changes no session. It neither takes the active slot nor adds an empty session to saved sessions.

### Open

- CASINO-SYNC-PRERESET: a reset or clear made before the account state has loaded is not recorded. `markRouletteAccountReset` in `nexus-src/src/casino-sync.mjs` writes its reset marker only once the account storage scope is open, so before that it writes nothing, and the account keeps its history. A clear that leaves a session with no work is ignored by the rule above.
- The same-id branch of `placeEditedSession` in `nexus-src/src/casino-sync.mjs` still compares the two stamps when the pre-load change and the account session share an id. Session ids are random per session (`generateId` in `nexus-src/src/constants.js`), so the branch needs an id collision to run. It is left unchanged and recorded here.

## [0.71.0] - 2026-10-31

### Fixed

- Undo last spin is offered only while the session and mode it was taken from are still current. The snapshot now records the session id and the mode, and Undo reads as unavailable once either differs. Resuming a saved session, a JSON import, a Game/Live mode switch and a Restart Onboarding that changes the wheel no longer leave an Undo that restores the replaced session. A mode switch also drops the snapshot for good. The snapshot is held as `undoBind` (with its session id and mode) in `nexus-src/src/App.jsx`, and `prevSessState` is that snapshot only while it matches the current session and mode.
- Undo last spin is refused when the session changed after the spin in a way Undo would undo too: a changed wheel, name, label or venue, a spin list that is not the snapshot plus the tapped spin, or any other session field a tap does not change. The note reads "Undo is off: the session was changed after the spin it would reverse. Undo would drop that change." The check is `undoBlockReason()` in `nexus-src/src/spin-apply.js`. A venue recorded after the spin (Save on the Where are you playing? sheet) now refuses Undo; Skip does not. Save of the session still leaves Undo offered, as before.

### Tests

- `test/undo-snapshot-class.test.mjs`: the Undo snapshot is not offered or applied after resume, a JSON import, Restart Onboarding with a new wheel, a Game/Live mode switch, or a venue recorded after the spin; a snapshot whose session id does not match is never applied; `undoBlockReason()` refuses a changed wheel, label or id, and a spin list that is not the snapshot plus the tapped spin, and allows the tapped spin, a Save and a track change.

## [0.70.0] - 2026-10-31

### Changed

- The photo review names the provider that answered the read. A `;by=<provider id>` field after the numbers of a photo return shows as one factual line under the heading, in the same reserved slot as before. An id is lowercase letters, digits and hyphens, 1 to 32 characters. `gemini` reads "Read by Google Gemini", `openai` reads "Read by OpenAI", `cloud` keeps "Read by the cloud model" for returns that predate the field, and `pc` reads "Read by your PC". Any other id that matches the pattern reads "Read by <id>". An id that does not match, or an empty one, shows no line, and the numbers parse as before. The reader map and the id check are in `nexus-src/src/components/BoardPhoto.jsx`, and the return contract comment above `parseBoardReturn()` states the new shape.

### Tests

- `test/reader-label.test.mjs`: each known id reads its provider's line; an unknown valid id reads "Read by <id>", including a 32-character id; invalid ids (uppercase, too long, a space, markup) and the empty value show no line; `__proto__` shows no line and `constructor` is treated as a plain id; repeated numbers parse the same with the field; the reader slot stays reserved in every state. Updated: the cases that expected `gizmo` and `constructor` to be ignored now expect them as valid ids, and the contract-comment assertion now checks the `;by=<id>` shape.

## [0.69.0] - 2026-10-31

### Fixed

- Undo last spin is refused after an Abandon Progression made after the spin it would reverse. The Undo button is disabled and the note beneath the track cards reads "Undo is off after a track was abandoned. Fix the number instead." Undo used to restore the session from before the spin and drop the abandon without a word. The check is in `undoBlockReason()` in `nexus-src/src/spin-apply.js`, beside the other Undo refusals. An abandon made before the spin is kept, as before.
- Clear History on the Spin Log tab (its confirm reads "Clear all spins from session history?") clears the Undo snapshot with the spins, so Undo is not offered after it. Undo used to bring the cleared spins back. The handler is `SpinPage` in `nexus-src/src/components/SecondaryPages.jsx`, and App.jsx passes it `onClearHistory`.
- End Session, Tear session and New session clear the Undo snapshot when they replace the current session, so Undo is not offered after them. Undo used to restore the replaced session from before the last spin whenever the money records matched. The handlers are `endSession()`, `tearSession()` and `newEmptySession()` in `nexus-src/src/App.jsx`.

### Tests

- `test/undo-other-gaps.test.mjs`: Undo after an Abandon Progression is refused with its reason and the abandon stays; an abandon made before a spin is kept by Undo; Clear History, End Session, Tear and New session each leave no Undo offered; the abandon refusal's wording lives in spin-apply.js only.

## [0.68.0] - 2026-10-31

### Changed

- Undo last spin is refused after a buy-in, cash-out or bankroll change made after the spin. The Undo button is disabled and the note beneath the track cards reads "Undo is off after a buy-in, cash-out or bankroll change. Fix the number instead." A money move made before the spin is kept by Undo, as before.
- Undo last spin is refused after a ghost spin, or a spin no track settled, recorded after the spin it would reverse. The note reads "Undo is off after a ghost spin or an untracked spin. Fix the number instead."
- A bankroll edit made with the Bank button is recorded on the session as `bankrollEdits` (when, the bankroll before and the bankroll after), so Undo can see it. A save that leaves the bankroll as it was records nothing.

### Fixed

- A track parked by an Edit Config save records its park point at the edit's spin count (`updateTrackConfig()` in `nexus-src/src/App.jsx`), so the load migration no longer moves it and a correction after the edit stays accepted after a reload.
- An import that parks active tracks gives each parked track a park point at the imported session's spin count (`parkImportedSession()` in `nexus-src/src/components/session-files.jsx`). Corrections to spins before the import are refused, as they are after a Park button press.
- A parked track with no park point gets one on load: the session's spin count at load. This covers parks made before 0.66.0, in the live sessions and in every saved session. The rule is conservative, so no spin before the load can be corrected into a record the park has already fixed. A park point already stamped is never moved, so later loads change nothing (`migrateParkPoints()` in `nexus-src/src/session.js`).
- Undo last spin no longer silently reverts a buy-in, cash-out, bankroll edit, currency conversion or ghost spin made after the spin. It used to restore the whole session from before the spin.

### Tests

- `test/track-edit-park.test.mjs`: Undo after a spin and then a buy-in, cash-out, bankroll edit or ghost spin is refused with its reason and changes nothing; a money move made before a spin does not block Undo of it; a buy-in made before Clear numbers does not block Undo of a later spin; a bankroll save of the same amount records nothing and refuses nothing; an import parks its active tracks with park points at the imported spin count and keeps an existing one; the load migration gives a parked track with no park point the spin count at load, for the live and saved sessions, and never moves a park point it already has.

### Open

- Undo last spin still reverts an Abandon Progression made after the spin. It changes a track's P&L but not the bankroll, so the money check does not see it. Found by reading the code; not run. Outside this change.
- Settings' "Clear all spins from session history" removes the spins without clearing the Undo snapshot, so Undo can bring the cleared spins back. Found by reading the code; not run. Outside this change.
- End Session, Tear session and New session replace the current session without clearing the Undo snapshot. Undo can then restore the replaced session's state from before the last spin; the money check refuses it only when the new session's starting bankroll or money records differ. Found by reading `App.jsx`; not run. Outside this change.

## [0.67.0] - 2026-10-31

### Fixed

- A Stop whose call to Casino throws now restores the pause owner it replaced, as a refused Stop already does. The owner stayed "manual", so the next spin was sent with a pause. `discardAndStop()` in `nexus-src/src/casino-recording.mjs`.
- A Pause, or an automatic pause, whose call to Casino throws clears the pause owner and states the failure in the problem line. A Pause that threw before this change left the same pause owner behind. `pauseImmediately()` in `nexus-src/src/casino-recording.mjs`.
- A session check that throws (`refresh()`) states the failure in the problem line and does not overturn a recording state it has already reached. A check that could not establish the state moves it to not connected, and the next spin checks again. A pause that the check sends and that throws clears the pause owner.
- A start or a session read that throws (`resolveSession()`, `rereadSession()`) holds the queue with the failure in the problem line. The queue retries it as it does for a refusal.
- Every link appended to the recording chain (a spin, a Resume or Stop, a Pause) catches its own error, states it in the problem line, and resolves. The chain is no longer rejected, so a later spin is recorded. Before, a link that threw left every later spin silently unrecorded. `appendLink()` in `nexus-src/src/casino-recording.mjs`.
- A browser without `crypto.randomUUID` (a page outside a secure context) records its spins. The request id falls back to `crypto.getRandomValues()`, then to a time-plus-counter value, in the same UUID shape and unique per spin. Before, `enqueue()` threw and the chain was rejected, so every later spin was silently unrecorded. `newRequestId()` in `nexus-src/src/casino-spin-queue.mjs`. This resolves the L3 note under 0.65.0 Open.

### Tests

- `test/recording-throws.test.mjs`: a Stop, Pause, session check or start that throws is stated in the problem line; the pause owner is restored; a later spin is recorded and carries no pause; a link that throws does not stop the next one; a request id is unique per spin without `crypto.randomUUID`.

### Open

- The automatic pause and automatic resume in `useCasinoRecording()` are re-sent on each render while the view stays in that state after Casino refuses them. A throw now does the same, where it used to leave the transition stuck. Not changed here.

## [0.66.0] - 2026-10-31

### Changed

- A correction to a spin played before a track was parked with its Park button is refused. The number picker shows "This spin was played before a track was parked. Corrections can only change spins after the last park.", the same kind of refusal as a spin before an edit, with its own note, and nothing changes. Corrections to spins from the park onward are unchanged.
- Undo last spin is refused while a track was edited or parked after the spin it would reverse. The Undo button is disabled and the reason "Undo is off: a track was edited or parked after the spin it would reverse, and Undo would drop that change." shows beneath the track cards. Undo stays available once a new spin is tapped, and when nothing has changed since the spin.

### Fixed

- A correction from before a Park button press no longer leaves the parked track's record and the bankroll stale. The track records the spin count of its park, and corrections before that count are refused.
- Undo last spin no longer silently removes a track edit or a park made after the spin. It used to restore the whole session from before the spin, so the new track disappeared and the parked track came back active.
- Clear numbers resets the park point with the spins, and Undo of Clear restores it, so a park does not refuse corrections to spins played after the clear.

### Tests

- `test/track-edit-park.test.mjs`: a Park button press refuses a correction to a spin before it with the picker note, and nothing changes; corrections from the park onward still work; a session without a park corrects as before; Clear numbers and Undo of Clear carry the park point correctly; the Undo after a spin then an edit or a park is refused and changes nothing; Undo still works when nothing changed after the spin, and an edit made before a spin survives Undo of that spin.

### Open

- Parks made before this release carry no park point, so corrections to spins before them are still accepted and the parked track's record can still go stale. Those parks need a decision from the operator on how to treat them.
- Importing a session parks its active tracks in `nexus-src/src/components/session-files.jsx` without a park point. The same stale-record gap applies to imported sessions. That file is outside this change.
- Undo last spin still reverts a buy-in, cash-out, bankroll edit or ghost spin made after the spin it reverses. Those are not track edits or parks, so they are outside this change.

## [0.65.0] - 2026-10-31

### Fixed

- A spin recorded while an earlier spin's send to Casino is still unconfirmed is no longer dropped from the Casino recording. The new spin queues behind the earlier one in `useCasinoRecording()` in `nexus-src/src/casino-recording.mjs`, takes the next sequence number in spin order, and is sent once the earlier spin confirms. Every retry of a send reuses that spin's sequence and request id. A send that keeps failing shows how many spins are waiting to send to Casino.
- The spin queue moves from `nexus-src/src/casino-recording.mjs` into `nexus-src/src/casino-spin-queue.mjs` (`createSpinQueue()` and its send helpers). The build includes it ahead of the recording hook.
- A definitive refusal of the head spin no longer retries every 10 seconds forever. A 4xx refusal, or a sequence Casino already holds, makes the queue read the session again. If the session has ended, the queued spins are dropped and the problem line says how many were not saved. If the session is live, the spin is renumbered from Casino's count and keeps its request id.
- Turning recording off and on again no longer lets a later spin reuse the sequence of an earlier spin that may already be in Casino's record.
- While the queue is held, a new spin only joins the queue, and Pause records its intent at once instead of waiting for the retries; the pause applies when the queue drains. Stop on a held queue asks for a second press that names the number of unsent spins it will discard, and states the count once they are discarded.
- A spin's pause is decided at each send from the current intent, and only the last queued spin can carry it, so two spins no longer both pause the session.
- Leaving the Roulette view stops the retry loop. No retry is scheduled, and no problem line or session change is written, after it closes.
- Stop on a held queue changes nothing but the offer on its first press. The pause owner is set only after the second press has discarded the queued spins, and it is cleared again when Casino confirms the stop. A discarded queue therefore no longer sends its last spin with a pause, and a pause intent no longer outlives a stopped session. `stopNow()` and `discardAndStop()` in `nexus-src/src/casino-recording.mjs`.
- A second Stop waits for a send that is already in flight. If Casino records that spin, it is confirmed and is not counted as discarded. A spin whose send may have been recorded is counted and stated as "may have been saved to Casino", never as "not saved". `discard()` in `nexus-src/src/casino-spin-queue.mjs` now resolves with the count and how many of it may have been saved.
- A head that was sent ambiguously keeps its sequence and request id on every retry, including a retry after a definitive refusal. Only a head that was never sent ambiguously is renumbered from Casino's count, so Casino cannot record one spin under two numbers.
- A paused session holds the queue without renumbering it. The problem line says "Casino recording is paused. Resume it to send N waiting spins." For a live session, a head refused three times in a row is dropped on its own, and the line says "1 spin could not be saved to Casino: <reason>." The spins behind it are sent in order. The line stays on screen until the next spin is made. A dropped head that may have been saved is stated as "may have been saved to Casino".
- A queue held behind a paused session sends no spin and arms no retry while it is paused. A Resume on that queue sends Casino the resume first, then the held spins. Flushing first would send them to the paused session, be refused, and the resume would never be sent. `lifecycle()` in `nexus-src/src/casino-recording.mjs`.
- The recording hook's dispose no longer ends its queue for good. A remount reopens the queue (`reopen()`) and its queued spins are sent, so React StrictMode or a page remount does not kill the recorder.
- A spin confirmed by a reconciled answer keeps its pause. If that spin carried a pause and Casino reports the session as not paused, the pause is applied when the queue drains, unless the pause was withdrawn in the meantime.
- Spins still queued when the Casino recording view unmounts are counted. The next mount of that mode says "N spins were not sent to Casino before the page closed." The count is kept in `localStorage` (with a try/catch, as `casino-sync.mjs` does) and is updated as the queue changes. Where `localStorage` is unavailable the count is not kept. The spins themselves are not persisted; that is CASINO-QUEUE-PERSIST.
- A spin made while Casino recording is paused says "1 spin was not saved to Casino: recording is paused. Resume it before the next spin." It was refused before, with no count. Spins made while recording is off or Casino is not connected are never queued and are not counted; the recording bar says nothing is being recorded.
- A send still in flight when the Casino recording view closes no longer lets its spin be recorded twice. A send abandoned by unmount or dispose marks its head ambiguous when Casino may hold the spin, so the next mount resends the same sequence and request id. Casino answers `recorded:false`, the spin is confirmed once, and it is never renumbered. `drain()` in `nexus-src/src/casino-spin-queue.mjs`.
- A second Stop during the discard wait shows "Discarding unsent spins…" in the problem line, and the queue's own problem lines do not replace it until the discard finishes. `discardAndStop()` in `nexus-src/src/casino-recording.mjs`.
- Resume and Pause pressed during the discard wait do nothing and say nothing: they return false, and no "cannot resume" or "will pause after" line is written. `lifecycle()` and `pauseImmediately()` in `nexus-src/src/casino-recording.mjs`.
- A spin made while the queue is discarding is refused. It is not queued, not counted as discarded, and never sent to a stopping session. The problem line says "1 spin was not saved to Casino: recording is stopping." and stays on screen after the discard, with the discard's own count. `record()` in `nexus-src/src/casino-recording.mjs`.
- An abandoned send that Casino refused definitively, such as a stale sequence, no longer marks its head ambiguous. Casino did not record that send, so on reopen the next `recorded:false` is read as a refusal and the spin is renumbered from Casino's count. It is no longer read as proof of an earlier record and dropped as confirmed. A send that succeeded, timed out or failed with a 5xx still marks the head. `drain()` in `nexus-src/src/casino-spin-queue.mjs`.
- A Stop whose call to Casino throws shows the failure in the problem line, with any spins refused while the discard waited, instead of leaving "Discarding unsent spins…" on screen. The count of refused spins is cleared in every case, so a later discard does not state it again. `discardAndStop()` in `nexus-src/src/casino-recording.mjs`.

### Open

- The unconfirmed spins are held in memory, and the queue has no bound. If the page closes or reloads before Casino confirms them, the spins are missing from the Casino record. Their count is kept (see Fixed) and the local session still has them. Persisting the queue is CASINO-QUEUE-PERSIST.
- `recorded:false` after an ambiguous attempt is accepted as this client's spin without an owner check. A sequence another device wrote can be read as ours.
- L1 (LOW): A mode change on a shared hook instance sends its queued spins to the new mode's session. The app holds one instance per mode (`gameRecording` and `liveRecording` in `nexus-src/src/App.jsx`), so this is not reached today; the hook does not guard it.
- L2 (LOW): The recording-off count (`recordingOff`) can include an ambiguous head that Casino may already have saved, and it says that spin was not saved.
- L3 (LOW): `crypto.randomUUID()` in `enqueue()` needs a secure context. Where it is missing, `enqueue()` throws. That rejects `queue.current` in `record()`, and every later spin waits on the rejected chain, so nothing after it is recorded and nothing says so. Not reproduced here.
- L4 (LOW): `nextSequenceForSession()` never lowers the cursor for the same session. If Casino's spin count for that session moves backwards, the next spin is numbered above the gap. Whether Casino accepts a gap is not verified.
- Resume on a held queue waits behind a live retry round in flight (up to about 39 seconds). A queue held behind a paused session does not wait (see Fixed). Pause, once the queue is held, does not wait; Stop waits for a send in flight (see below).
- The first round of an outage runs before the queue is held, so Pause and Stop pressed during that round still wait for it to end (up to about 39 seconds).
- An ambiguous head is never renumbered (see Fixed). Its retry reuses its sequence and request id. The reconcile path already relies on Casino answering a repeated sequence with `recorded:false`; that is not verified against Casino.
- A second Stop waits for a send already in flight before the discard and the stop run. That wait can take up to about 39 seconds.
- A spin queued behind a spin whose pause is in flight is sent after that pause. How Casino answers a spin on a paused session is not verified.
- A live session that refuses a spin keeps that spin for three refusals, then drops it (see Fixed). How Casino answers a spin sent to a paused session is not verified.
- The session check reads the running session for the mode from Casino's history. Whether that list includes a paused session is not verified; if it does not, a paused session would be reported as ended and its queued spins dropped with that count. The paused hold (see Fixed) depends on the same check.
- Account sync (`nexus-src/src/casino-sync.mjs`) may replace a spin made before the account sync has loaded the saved state. This is not reproduced by a test here and is not changed by this fix.
- No browser suite was run. The problem lines and the Stop confirmation are UNVERIFIED on a device.
- The version number is not bumped and the service worker cache name is unchanged; both move at promotion.
- The refusal counter resets on a non-definitive failure. A head refused with a 409 or 4xx, then failing with a 5xx or a network error, starts again at zero, so a server that alternates 409 and 5xx never reaches the three refusals that drop the head. `drain()` sets `head.refusals=0` on that path in `nexus-src/src/casino-spin-queue.mjs`. Not changed here.
- Two tabs of one mode share one unsent-count key (`nexus-roulette.casino-unsent.<mode>` in `localStorage`). Each tab writes the count of its own queue to the same key, so the next mount can report another tab's count. Not changed here.

## [0.64.0] - 2026-10-31

### Changed

- Every Edit Config save that changes anything parks the track it came from and starts a new active track with the saved config. This holds for every track type and every field, the base included. It reverses the in-place edits of The Solution (0.56.0) and of a base-only change to a Progression Bet or Custom Bet (0.58.0). The parked track keeps its full record: P&L, spins, levels and history. The new track starts a fresh record: P&L 0, no bets, no wins. A save that changes nothing does nothing.
- The Solution: the new Solution track takes over the held bets, their current levels and the chased number, so a chase in progress continues without a break. The new track's P&L and spin record start fresh from the edit. The parked track keeps its record up to the edit and holds no bets from then on, so resuming it cannot put the same bets on the board twice.
- An Edit Config panel that stays open while a held bet is tapped is not a change. The held bets and the chased number are always the live ones, so a save with nothing else changed does nothing.
- `updateTrackConfig()` in `nexus-src/src/App.jsx` is the one save path. A Solution's save reads its held bets through `editedTrackConfig()` in `nexus-src/src/engine.js`, which now serves only that carry-over.
- A correction to a spin played before the last edit is refused in the number picker, with the reason "This spin was played before you edited a track. Corrections can only change spins after the last edit." Nothing changes. Corrections to spins from the last edit onward work as before. The edit's spin count is recorded on the new track (`createdAtSpin`, with `startedByEdit` set by `updateTrackConfig()` in `nexus-src/src/App.jsx`). `spinCorrectionBlockAt()` in `nexus-src/src/spin-apply.js` makes the decision for both the picker and `correctSpin()`.

### Removed

- `canEditInPlace()`, `rebaseTrackPnl()` and `rebaseChips()` in `nexus-src/src/components/BaseBetInput.jsx`, and the in-place branches of `updateTrackConfig()` in `nexus-src/src/App.jsx`. No other code called them.

### Fixed

- The Game page, the Live tracker, the Full Table page and the Edit Bankroll sheet no longer reset when the app updates. Each was declared inside `App` in `nexus-src/src/App.jsx`, so every App render created a new component type and remounted it. A bet, a chip tap or each spin-animation tick therefore returned the recent-numbers strip to its newest 40 chips at scroll position 0, and cleared a bankroll amount being typed. The Game page and the Full Table page now mount their module-scope views directly (`GamePageView` in `nexus-src/src/components/GamePage.jsx`, `TablePageView` in `nexus-src/src/components/TablePage.jsx`). The Live tracker body stays in `App` as `renderTrackerPage()`, and `App` mounts it through a module-scope `TrackerPage` component that receives it as a prop, so the element type no longer changes on each render. Edit Bankroll is a module-scope component in `nexus-src/src/App.jsx` that takes its starting amount and saves through a prop. Nothing else changes: the page bodies are the same, and only the state they hold now survives an App render. `nexus-src/src/App.jsx` goes from 891 to 890 lines. The regression test is `test/page-remount.test.mjs`, which also holds the list of the nested components that remain (three board chips in `nexus-src/src/components/ui.jsx`, kept because they hold no state). No version or service worker cache change; both move at promotion.

### Tests

- `test/track-edit-park.test.mjs` (new): a base-only Progression edit and a Custom Bet edit park the track and leave its record unchanged; a Solution edit parks, carries the held bets and the chase with their levels, and starts a fresh P&L; a save with no change does nothing, including a Solution panel left open while a bet was tapped.
- `test/base-bet.test.mjs`: the in-place tests for a Progression base change, a Solution base change and the canEditInPlace checks are replaced by the park tests above. The App wiring assertion that pinned the in-place branches now checks that the in-place helpers are gone.
- `test/solution-pick.test.mjs`: the source assertion that a Solution edit is saved in place is replaced by the park wiring assertion.

### Open

- The visual checks of the strip, the Live page and the Edit Bankroll sheet at 360 and 390 px are UNVERIFIED: no browser suite was run for this change.
- Open question for the operator: should a Solution edit carry the held bets into the new track (current) or leave them on the parked one?
- A Solution edit that carries a bet above level 0 leaves that session unable to spin-correct: the replay starts carried bets at level 0 (`startingSolutionBets()` in `nexus-src/src/spin-apply.js`), so the replay does not reproduce the record and the correction is refused with its reason. Nothing is changed. Checked: a threshold-only edit with a held bet at level 3 is refused on this change; the original code accepted the same correction. Fixing this needs spin-apply.js, which this change does not edit.
- Resolved by the ruling in Changed: a correction to a spin from before an edit is refused, so an edit of the base or of any other field no longer leaves the parked track's P&L and the bankroll stale. A park from the Park button is not an edit and is outside that ruling, and it keeps the stale gap: a Progression parked by its Park button, with its third spin (a hit) corrected to a miss, was accepted, and its P&L stayed at +2 and the bankroll stayed at 502 (checked on this change). This needs a ruling: refuse a correction before any park, or let `spin-apply.js` replay a parked track up to its park point.
- The Edit Config panel is UNVERIFIED in a browser: no browser suite was run for this change.
- The version number is not bumped and the service worker cache name is unchanged; both move at promotion.

## [0.63.0] - 2026-10-31

### Added

- Real vs simulated (F12): a Real vs simulated button on the Stats page opens a sheet that compares what was logged at each casino, machine or table, and dealer with the simulated wheel. For the chosen venue it shows the spins observed, a number grid of observed counts against a simulated reference (the spins on that wheel divided by its pockets), and a dozen and column table with hits, the reference hits, the longest completed losing streak and its percentile against the simulated streak distribution in `nexus-src/src/streak-percentiles.js`. A completed losing streak is consecutive spins without a hit, ended by a hit, counted within one session and, for a table, within one dealer's spins; a streak still running at the end is not counted. The venue picker offers casino, then machine or table, then dealer, and lists only the values logged sessions hold. A venue with fewer than 100 spins says how many were logged. The logic is pure, in `nexus-src/src/real-vs-sim.js`; the sheet is `nexus-src/src/components/RealVsSimPage.jsx`, mounted from `nexus-src/src/components/SecondaryPages.jsx`; the tests are in `test/real-vs-sim.test.mjs`.
- Added tests `test/session-flows.test.mjs` for the session flows through the real App: resuming a saved session saves the unsaved current session first and then makes the saved one current exactly as saved, and survives a save and reload; a session's label persists through save and reload and survives the account-sync merge by its modified stamp; the typed catch-up `2 2 2 24 4` adds five spins in that order and settles the active tracks through `commitBoardAdd`. Tests only: no source, version or cache change.

### Changed

- Catch up card (`nexus-src/src/components/SessionsPage.jsx`): its "Read board photo" button is the shared `ReadBoardPhotoButton` in `nexus-src/src/components/SpinTools.jsx`, the same component the Live spin tools mount, with the same handler from `nexus-src/src/App.jsx`. The card defines no photo button of its own.
- Catch up for Game sessions: the card offers the bulk entry for a Game session as it does for a Live one, and the Game-mode note is removed. The board-add path `commitBoardAdd()` in `nexus-src/src/board-return.mjs` takes the session kind (live or game) as a parameter and writes that session, so "2 2 2 24" enters four spins oldest first and settles the Game tracks. The add is recorded to the recorder for its mode.
- The card offers Read board photo for Live sessions only. A photo return opens the Live review, so the button would lead nowhere for a Game session.

### Open

- The visual checks of the sheet at 360 and 390 px (no horizontal scroll, and no layout movement as the venue changes) are UNVERIFIED: no browser suite was run for this change.
- The venue chip rows are laid out again in `RealVsSimPage.jsx`, next to the Sessions sheet's chip rows in `SessionsPage.jsx`, which use the same `SessionsChip`. The shared row belongs in one component; `SessionsPage.jsx` is outside this change, so it is not edited here.
- Each chip row holds two lines and scrolls inside them when more chips do not fit, so the sheet's height does not change with the venue. The applied choice stays in its row, shown pressed, rather than leaving the list (a filter that hides its own applied value gives no sign of what is applied); tapping it changes nothing.
- The version number is not bumped and the service worker cache name is unchanged; both move at promotion.
- A Game catch-up cannot be reached from the screen yet. The sessions sheet is mounted only in the Live Stats tab (`nexus-src/src/App.jsx`, `nexus-src/src/components/SecondaryPages.jsx`), and resuming a Game session switches the app to Game mode, which unmounts the sheet before the card shows. Opening the card for a Game session needs a change to where the sheet is mounted, or an entry on the Game page (`nexus-src/src/components/GamePage.jsx`). Both are outside this item and need their own item and a ruling.
- The visual checks of the card are UNVERIFIED: no browser suite was run for this change. They cover the single photo button in a Live card and the Add button's width in a Game card, where there is no photo button.
- The version number is not bumped and the service worker cache name is unchanged; both move at promotion.
- The Game page's recent-numbers ticker is now the shared recent-numbers strip the Live page uses, `RecentNumbersStrip` in `nexus-src/src/components/SpinTools.jsx`. The separate 30-chip row in `nexus-src/src/components/GamePage.jsx` is removed. The Game page reaches every spin of the session with no limit: it draws the newest 40 chips first, loads the next 40 as the reader scrolls toward the oldest chip drawn, and has the same Newer and Older pager buttons and hidden scrollbar as the Live page.
- The shared strip takes a `correctable` prop, on by default. The Game page passes `correctable={false}`, so a long-press on a number there does not open the Live spin correction, as before. The Game page passes no track overlays, as before, so the track colour borders stay on the Live page.
- The Game page's strip reserves its 40 px row from the first render, with no numbers in it, so the spin result and the drought panel below it do not move when the first spin lands. Before this change the ticker appeared only after the first spin.
- The visual checks of the Game page strip (the hidden scrollbar, the pager buttons, and the scroll at 360 and 390 px) are UNVERIFIED: no browser suite was run for this change.
- The strip's loaded pages and scroll position reset whenever `App` re-renders, because `GamePage` and `TrackerPage` are declared inside `App` in `nexus-src/src/App.jsx` and so remount on every render. A bet, a chip tap or a spin animation tick in Game mode therefore returns the strip to its newest 40 chips. The Live page has the same reset on each Live update. The fix is in `App.jsx`, which this change does not edit.
- The version number is not bumped and the service worker cache name is unchanged; both move at promotion.

## [0.62.0] - 2026-10-31

### Added

- Photo review says which reader read the numbers. A board-photo return may carry an optional reader field after the numbers: `#readboard=ok:8,31,3;by=cloud` (the hosted cloud model) or `#readboard=ok:8,31,3;by=pc` (the user's PC). The review shows "Read by the cloud model" or "Read by your PC" in a reserved line above the numbers, and that line's space is kept whether or not it has text. A return without the field, or with an unknown value, parses exactly as before and shows no line. The shape is stated in the parser comment of `nexus-src/src/components/BoardPhoto.jsx`, where the Nexus Foundry reader side must match it. The parse and the review's `reader` prop are in that file; the field is accepted on numbers returns only.

### Open

- The Nexus Foundry side that sends `;by=` is a separate item.
- The visual check of the reader line at 360 and 390 px is UNVERIFIED: no browser suite was run for this change.

## [0.61.0] - 2026-10-31

### Fixed

- Cash Out: an amount typed above the bankroll was quietly cut to the bankroll. It is now refused with its reason ("The highest cash out is $X.") and the amount already set stays. Cash Out passes its range, 0.01 up to the bankroll, to the shared money field (`nexus-src/src/components/modals.jsx`).

## [0.60.0] - 2026-10-31

### Added

- Gold for the coldest number in each dozen and column. On the board, the number with the highest loss level in each of the six sections is gold: gold number text and a small gold corner pip. The F10 outline is unchanged, so gold and the outline read separately. Each section tile shows its coldest number or numbers and their loss level in gold, in a row with a reserved slot, and its detail view lists the section's numbers coldest first with the coldest in gold. The rule is `sectionColdest()` in `nexus-src/src/tlv.js`: ties return every tied number, and nothing is gold when the highest loss level is 0. 0 and 00 are never in a section.
- Settings: "Gold for the coldest number in each dozen and column", on by default, beside Percentile outlines and saved with the other settings (`nexus-src/src/components/SecondaryPages.jsx`).

### Changed

- The recent-numbers strip on the Live page shows every spin of the session, newest first, with no limit. It draws the newest 40 chips first, and loads the next 40 when the reader scrolls to within one strip width of the oldest chip drawn, until every spin is shown. A new spin still appears at the front at once. The strip's scrollbar is hidden; two pager buttons, Newer at the left and Older at the right, scroll it by about one strip width. Their space is reserved and only their visibility changes. The long-press correction and the track colour borders work on every chip, including the ones loaded later. The strip's height is unchanged. Before this change it showed only its newest 40 spins (`RECENT_STRIP_LIMIT` in `nexus-src/src/components/SpinTools.jsx`).
- Clearing the numbers returns the strip to its first page of 40 chips.

### Open

- The visual checks of the strip (the hidden scrollbar, the pager buttons and the scroll at 360 and 390 px) are UNVERIFIED: no browser suite was run for this change.
- The Game-mode recent-numbers ticker in `nexus-src/src/components/GamePage.jsx` still shows only its newest 30 spins. It is outside this change's files.
- The toggle governs the board on the Live page only. Tile gold shows regardless of the toggle, and the Game page board shows no gold until `nexus-src/src/components/GamePage.jsx` passes `coldestGold`. Wiring the toggle into the tiles needs a prop through `nexus-src/src/components/DroughtPanel.jsx`. `GamePage.jsx` and `DroughtPanel.jsx` are outside this change, so neither is edited here.
- The visual checks for the gold board cell and the tile's coldest row at 360 and 390 px are UNVERIFIED: no browser suite was run for this change.

## [0.59.0] - 2026-10-31

### Fixed

- `MoneyInput` (the bankroll, buy-in and cash-out fields in `nexus-src/src/components/ui.jsx`) no longer changes what was typed without a message. It used to strip non-numeric characters, read `-5` as `5` and round to cents on blur. It now keeps the text as typed. On blur or Enter a valid amount applies. An amount that cannot be read, is negative, has more than 2 decimal places, is outside its range or has cents in a currency with no minor unit shows its reason under the field and keeps the amount already applied. A 3-decimal entry is refused, never rounded.
- The Table Limits copy in `nexus-src/src/components/modals.jsx` said "This controls which unit bet sizes are valid" and "warns when a progression would exceed the max". Both were stale. A base below the Min Bet is allowed and shows a note, and no max-bet warning exists in the code. The copy now states only the Min Bet behaviour.

### Changed

- The amount parser is one shared module, `nexus-src/src/money-parse.js` (`parseMoneyAmount(text, currCode, range)`), used by `BaseBetInput.jsx` and `MoneyInput`. `parseBaseAmount()` is removed. The base is read with `baseRange()`, which keeps the base's limits (0.01 to 10,000, or 1 to 10,000 in a currency with no minor unit) and its messages.
- `MoneyInput` takes an optional `range` ({min, max, noun}). Its default is the range every current caller has: 0 or more, no upper bound. Its field is a text field, so "1,000" and "$5" are read rather than emptied.
- Callers and their ranges, unchanged: Cash Out (`modals.jsx`), 0 or more, capped at the bankroll by the parent (see Open); Starting Bankroll, Default Buy In and the Buy In amount (`modals.jsx`); Default Buy In (`SecondaryPages.jsx`); Starting Bankroll (`SimModePage.jsx`); Current Bankroll (`App.jsx`). All are 0 or more with no upper bound.

### Open

- The visual checks are UNVERIFIED: no browser suite was run for this change.
- Cash Out: `modals.jsx` clamps a typed amount above the bankroll to the bankroll with no message (`setAmount(Math.min(v,maxAmount))`). That is outside this change's files. It needs its own item so the field can show the cap.
- The Buy In modal accepts 0 into the field, and its button does nothing at 0, because `handleBuyIn` requires more than 0. Not changed here.
- The version number is not bumped and the service worker cache name is unchanged; both move at promotion. The rebuilt `index.html` therefore has new bytes under the current version, which `deploy.sh` refuses until that step.
- The in-app release notes list in `nexus-src/src/constants.js` is not updated; it belongs to the release step.

## [0.58.0] - 2026-10-31

### Added

- Sessions browser (`nexus-src/src/components/SessionsPage.jsx`), opened from Stats with Browse sessions. It lists saved sessions newest first, grouped Today, Yesterday, then the date, with the venue line (or "No venue"), start time, duration, spin count, P&L and a current mark. One-tap filters for casino, machine or table, dealer, and This week or All; each filter offers only the values saved sessions hold. The grouping, filter and bulk-entry logic is pure, in `nexus-src/src/sessions-browse.js`, and is tested by `test/session-browser.test.mjs`.
- Resume: a saved session becomes current with its tracks, levels, bets, droughts and venue exactly as saved (`resumeSavedSession()` in `nexus-src/src/session.js`). The session that was current is saved first. Switching away from a session with unsaved spins asks first, in the shared Modal. A Game session resumes into Game mode; a Live session resumes into Live mode.
- Catch up after a resume: a card in the sessions sheet enters the numbers that came while the table was unwatched, in two ways. Type them in bulk (spaces or commas, oldest first; each number is checked for the wheel; repeats are kept as separate spins; one Add enters them through the board-add path `commitBoardAdd` in `nexus-src/src/board-return.mjs`), or read a board photo with the existing board-photo button. The card serves Live sessions only, because the board-add path writes the current Live session.
- Session labels: a saved session can be renamed with an optional label of up to 60 characters. The label shows in the sessions list and on the Stats saved list. `renameSavedSession()` in `nexus-src/src/session.js` sets the label and stamps `modified`, so the sync merge keeps the renamed copy.

### Changed

- Stats: Resume on a saved session opens the sessions browser focused on that session. It no longer loads the session without saving the current one first. `loadSession()` in `nexus-src/src/App.jsx` is replaced by `resumeSaved()` and `renameSaved()`.
- `migrateSessionVenue()` in `nexus-src/src/session.js` also normalises a saved session's label on load.
- The quick presets are 0.25, 0.50, 1.00, 2, 5 and 10. One tap applies a preset.
- A preset below the table minimum is no longer disabled. It is still shown, with the warning above. Before, the check compared the base multiplied by the number of targets; the check now compares the base alone.
- Edit Config on a Progression Bet or Custom Bet track whose only change is the base now edits the track in place, as The Solution already did. Its level, held bets and history are kept, and the new base applies from the next bet. The track is not parked and recreated. A save that also changes another field (ROI, stop loss, targets, bet mode) still parks the track and starts a new one, as before.
- An in-place base change rebases the track's stored P&L (`pnl`, held in chips) by old base over new base, so the money already recorded for the track does not change. This applies to every track type edited in place, including The Solution.

### Fixed

- A base change on a The Solution track, which has been edited in place since 0.56.0, re-priced the P&L the track had already recorded, because P&L is held in chips and multiplied by the current base. The stored P&L is now rebased when the base changes (`rebaseTrackPnl()` in `nexus-src/src/components/BaseBetInput.jsx`, called from `updateTrackConfig()` in `nexus-src/src/App.jsx`), so the money recorded so far does not move.

### Open

- The visual checks at 360 and 390 px are UNVERIFIED: no browser suite was run for this change.
- Catch up is not offered for Game sessions. The board-add path writes only the Live session; a Game catch-up needs a ruling and a change to `nexus-src/src/board-return.mjs`.
- The catch-up card's Read board photo button calls the same action as the spin tools' button, but it is a second button. One shared component needs `nexus-src/src/components/SpinTools.jsx`, outside this change.
- A resume now stays on Stats with the sessions sheet open. The old Resume jumped to the Tracker. Where a resume should land is a ruling.
- The base bet is exact. The track setup and Edit Config (every track type: progression, Custom Bet and The Solution) take a Custom amount from 0.01 to 10,000 with up to 2 decimals, in the session's currency. Commas separate thousands and a currency symbol at either end is ignored. A value that cannot be read, is zero or negative, has more than 2 decimals or is over 10,000 shows its reason beside the field and keeps the amount already applied; nothing is clamped or truncated. The Custom field applies on blur or Enter. The control is `nexus-src/src/components/BaseBetInput.jsx`, one component mounted by both panels in `nexus-src/src/components/TrackPanel.jsx`.
- The base bet preview under the presets shows, for each level of the track's table at the applied amount: bet per spin, total invested and bankroll needed, through `formatChips()`. It updates as soon as an amount is applied, and it honours the track's stop loss, which caps the ladder at stop loss divided by the base.
- The base bet shows "Below the table minimum (X)" beside the field when it is under `settings.tableMinBet`. The warning does not block the amount; the operator decides.
- Bankroll needed and total invested are the same figure in the engine for every level (the cumulative stake through that level). The preview shows both columns, as the brief asked. A single column is a follow-on choice.
- The shared money input in `nexus-src/src/components/ui.jsx` (`MoneyInput`) strips non-numeric characters and rounds on blur without a message. It is not changed here, because it is used by bankroll, buy-in and cash-out surfaces outside this change. The base bet field copies its styling but not its commit logic.
- The Settings copy in `nexus-src/src/components/modals.jsx` ("This controls which unit bet sizes are valid") describes the old gating and is stale. It is outside this change's files.
- The in-app release notes list in `nexus-src/src/constants.js` is not updated; it belongs to the release step.
- A base change saved together with another field on a Progression or Custom track still parks the track, so its level restarts. Moving that case in place is a separate ruling.
- The base bet preview is a sample of the table, UNVERIFIED on a device: no browser suite was run for this change.

## [0.57.0] - 2026-10-31

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
