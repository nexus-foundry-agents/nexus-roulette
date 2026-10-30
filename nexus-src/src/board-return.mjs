// Bind photo input and the Add queue to the live session, including account-sync replacements.
function boardMatchesSession(bound, session) {
  return !!bound && bound.sessionId === session.id && bound.wheel === session.roulette;
}

function legalBoardList(numbers, wheel) {
  return Array.isArray(numbers) && numbers.length > 0 && numbers.length <= BOARD_MAX_NUMBERS &&
    numbers.every(number => getWheelNumbers(wheel).includes(number));
}

function useBoardPhotoReturn(session, appMode, setAppMode, syncStatus, tapNumber) {
  const live = React.useRef(session);
  live.current = session;
  const bind = result => result && ({result, sessionId:session.id, wheel:session.roulette});
  const [review, setReview] = React.useState(() => bind(takeBoardReturn(window.location, window.history, session.roulette)));
  const [queue, setQueue] = React.useState(null);
  const scope = React.useRef({id:session.id, wheel:session.roulette});
  const setBoardReturn = React.useCallback(result => setReview(bind(result)), [session.id, session.roulette]);
  const setBoardAdd = numbers => setQueue({numbers, sessionId:session.id, wheel:session.roulette});
  const boardReturn = boardMatchesSession(review, session) ? review.result : null;
  useCasinoBoardReturn(session.roulette, setAppMode, setBoardReturn, syncStatus, session.id);

  React.useEffect(() => {
    if(scope.current.id !== session.id || scope.current.wheel !== session.roulette) {
      if(review || queue) reject("changed");
      setQueue(null);
      scope.current = {id:session.id, wheel:session.roulette};
    }
  }, [session.id, session.roulette]);

  React.useEffect(() => {
    if(!queue) return;
    if(appMode !== "live" || !boardMatchesSession(queue, live.current) || !legalBoardList(queue.numbers, live.current.roulette)) {
      setQueue(null);
      return;
    }
    const [val, ...rest] = queue.numbers;
    tapNumber(val, true);
    setQueue(rest.length ? {...queue, numbers:rest} : null);
  }, [queue, appMode, session.id, session.roulette]);

  function reject(status) {
    setReview({result:{kind:"status", status}, sessionId:live.current.id, wheel:live.current.roulette});
  }
  function addBoardNumbers(listBoardOrder) {
    if(appMode !== "live" || !boardMatchesSession(review, live.current)) { reject("changed"); setQueue(null); return; }
    if(!legalBoardList(listBoardOrder, live.current.roulette)) { reject("unreadable"); return; }
    setReview(null);
    setBoardAdd(boardAddOrder(listBoardOrder));
  }
  return {boardReturn, setBoardReturn, setBoardAdd, addBoardNumbers};
}
