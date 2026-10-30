// Bind photo input and the Add action to the session actually being mutated.
function boardMatchesSession(bound, session) {
  return !!bound && bound.sessionId === session.id && bound.wheel === session.roulette;
}

function legalBoardList(numbers, wheel) {
  return Array.isArray(numbers) && numbers.length > 0 && numbers.length <= BOARD_MAX_NUMBERS &&
    Array.from(numbers).every(number => getWheelNumbers(wheel).includes(number));
}

// Keep the decision beside app state, outside the persisted/synced app object. React may replay an
// updater: it only computes state here; recording and UI effects consume the committed receipt below.
function useBoardPhotoState(load) {
  const [state, setState] = React.useState(() => ({appState:load(), decision:null}));
  const setAppState = React.useCallback(update => setState(previous => {
    const appState = typeof update === "function" ? update(previous.appState) : update;
    return Object.is(appState, previous.appState) ? previous : {...previous, appState};
  }), []);
  const commitBoardAdd = React.useCallback(action => setState(previous => {
    const session = previous.appState.currentSession;
    if(!boardMatchesSession(action, session) || !legalBoardList(action.numbers, session.roulette)) {
      return {...previous, decision:{action, accepted:false}};
    }
    let next = session;
    const spins = action.numbers.map(val => {
      const before = next;
      const wager = summarizeTrackWagers(before.tracks, val);
      const outcome = applySpin(before, val, true);
      next = {...outcome.sess, sessionStartedAt:before.sessionStartedAt || action.at, modified:action.at};
      return {val, before, outcome, record:{segment:val, ...wager, watched:wager.staked===0}};
    });
    return {appState:{...previous.appState, currentSession:next}, decision:{action, accepted:true, spins}};
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
  const setBoardAdd = numbers => setQueue({numbers:numbers.slice(), sessionId:session.id, wheel:session.roulette, at:Date.now()});
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
    if(appMode === "live") commitBoardAdd(queue);
    else reject();
    setQueue(null);
  }, [queue, appMode]);

  React.useEffect(() => {
    if(!decision || handled.current === decision) return;
    handled.current = decision;
    if(!decision.accepted) { reject(); return; }
    const last = decision.spins[decision.spins.length - 1];
    ui.setPrevSessState(last.before);
    decision.spins.forEach(spin => ui.liveRecording.record(spin.record));
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
    setQueue({numbers:Array.isArray(listBoardOrder) ? boardAddOrder(listBoardOrder) : null,
      sessionId:review.sessionId, wheel:review.wheel, at:Date.now()});
  }
  return {boardReturn, setBoardReturn, setBoardAdd, addBoardNumbers};
}
