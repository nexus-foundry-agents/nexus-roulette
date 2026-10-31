// Bind photo input and the Add action to the session actually being mutated.
function boardMatchesSession(bound, session) {
  return !!bound && bound.sessionId === session.id && bound.wheel === session.roulette;
}

function legalBoardList(numbers, wheel) {
  return Array.isArray(numbers) && numbers.length > 0 && numbers.length <= BOARD_MAX_NUMBERS &&
    Array.from(numbers).every(number => getWheelNumbers(wheel).includes(number));
}

// The session a board add writes, by its kind: the Live session or the Game session (their keys in app state).
const BOARD_SESSION_KEY = {live:"currentSession", game:"gameSession"};

// Keep the decision beside app state, outside the persisted/synced app object. React may replay an
// updater: it only computes state here; recording and UI effects consume the committed receipt below.
function useBoardPhotoState(load) {
  const [state, setState] = React.useState(() => ({appState:load(), decision:null}));
  const setAppState = React.useCallback(update => setState(previous => {
    const appState = typeof update === "function" ? update(previous.appState) : update;
    return Object.is(appState, previous.appState) ? previous : {...previous, appState};
  }), []);
  // One add path for both modes. The kind (live or game) is a parameter: it names the session the add writes. A missing
  // or unknown kind, a session the action is not bound to, or an illegal number, is refused.
  const commitBoardAdd = React.useCallback((action, kind) => setState(previous => {
    const key = BOARD_SESSION_KEY[kind];
    const session = key ? previous.appState[key] : null;
    if(!session || !boardMatchesSession(action, session) || !legalBoardList(action.numbers, session.roulette)) {
      return {...previous, decision:{action, kind, accepted:false}};
    }
    let next = session;
    const spins = action.numbers.map(val => {
      const before = next;
      const wager = summarizeTrackWagers(before.tracks, val);
      const outcome = applySpin(before, val, true);
      next = {...outcome.sess, sessionStartedAt:before.sessionStartedAt || action.at, modified:action.at};
      return {val, before, outcome, record:{segment:val, ...wager, watched:wager.staked===0}};
    });
    return {appState:{...previous.appState, [key]:next}, decision:{action, kind, accepted:true, spins}};
  }), []);
  return [state.appState, setAppState, state.decision, commitBoardAdd];
}

function useBoardPhotoReturn(session, appMode, setAppMode, syncStatus, decision, commitBoardAdd, ui) {
  const bind = result => result && ({result, sessionId:session.id, wheel:session.roulette});
  const [review, setReview] = React.useState(() => bind(takeBoardReturn(window.location, window.history, session.roulette)));
  const [queue, setQueue] = React.useState(null);
  const scope = React.useRef({id:session.id, wheel:session.roulette});
  const handled = React.useRef(null);
  const setBoardReturn = React.useCallback(result => setReview(bind(result)), [session.id, session.roulette]);
  // The catch-up card passes the session it is catching up. Its kind is the mode it resumes into, as resumeSavedSession decides.
  const setBoardAdd = (numbers, target) => { if(target) setQueue({numbers:numbers.slice(), kind:savedSessionMode(target), sessionId:target.id, wheel:target.roulette, at:Date.now()}); };
  const boardReturn = boardMatchesSession(review, session) ? review.result : null;
  useCasinoBoardReturn(session.roulette, setAppMode, setBoardReturn, syncStatus, session.id);

  React.useEffect(() => {
    if(scope.current.id !== session.id || scope.current.wheel !== session.roulette) {
      if(review || queue) reject();
      setQueue(null);
      scope.current = {id:session.id, wheel:session.roulette};
    }
  }, [session.id, session.roulette]);

  React.useEffect(() => {
    if(!queue) return;
    if(queue.kind === appMode) commitBoardAdd(queue, queue.kind);
    else reject();
    setQueue(null);
  }, [queue, appMode]);

  React.useEffect(() => {
    if(!decision || handled.current === decision) return;
    handled.current = decision;
    if(!decision.accepted) { reject(); return; }
    const last = decision.spins[decision.spins.length - 1];
    ui.setPrevSessState(last.before);
    // Each add is recorded by the recorder of the session it wrote, as a tapped spin is.
    const recording = recordingForMode(decision.kind, ui.gameRecording, ui.liveRecording);
    decision.spins.forEach(spin => recording.record(spin.record));
    const {trackResults, totalDelta} = last.outcome;
    if(trackResults.length) { ui.setResult({val:last.val, trackResults, totalDelta}); ui.setLastSpinDelta(totalDelta); }
    ui.setFlashNum(last.val);
    setTimeout(() => ui.setFlashNum(null), 400);
    if(ui.vibration !== false && navigator.vibrate) navigator.vibrate(totalDelta>0 ? [30,20,80] : totalDelta<0 ? 40 : 20);
  }, [decision]);

  function reject() { setReview(bind({kind:"status", status:"changed"})); }
  function addBoardNumbers(listBoardOrder) {
    if(appMode !== "live" || !boardMatchesSession(review, session)) { reject(); setQueue(null); return; }
    setReview(null);
    // Preserve the review's identity even when this callback is invoked after a sync replacement.
    setQueue({numbers:Array.isArray(listBoardOrder) ? boardAddOrder(listBoardOrder) : null, kind:"live",
      sessionId:review.sessionId, wheel:review.wheel, at:Date.now()});
  }
  // The photo reader, bound to this session's wheel. Every control that opens it calls this one function.
  const readBoardPhoto = () => openBoardPhoto(window.location, session.roulette, setBoardReturn);
  return {boardReturn, setBoardReturn, setBoardAdd, addBoardNumbers, readBoardPhoto};
}
