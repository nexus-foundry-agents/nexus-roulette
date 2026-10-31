// -- The one confirm (NO-NATIVE-DIALOGS) --
// Every confirmation in Roulette is this dialog, never the browser's window.confirm: a native dialog looks the same as one a
// page draws, so getting people used to it gets them used to the shape a phishing page uses. The dialog is the shared Modal
// (ui.jsx), so its backdrop rule is the one Modal applies: a press that begins and ends on the backdrop cancels, and a drag
// that leaves the dialog does not.

// One dialog: a title, an optional body, Cancel and a confirm button. onAnswer(true) is the confirm button; onAnswer(false) is
// Cancel and a backdrop dismiss. With notice set it is a message with one button and no Cancel. Nothing here runs the action. The caller awaits the answer and then acts, or does not.
function ConfirmDialog({title, body, confirmLabel="Confirm", danger, notice, onAnswer}) {
  return (
    <Modal onClose={() => onAnswer(false)}>
      <div role={notice?"dialog":"alertdialog"} aria-label={title}>
        <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",lineHeight:1.35,marginBottom:body?8:16}}>{title}</div>
        {body && <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.5,marginBottom:16,whiteSpace:"pre-line"}}>{body}</div>}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {!notice && <button onClick={() => onAnswer(false)} style={{flex:"1 1 120px",padding:"12px 0",borderRadius:10,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:14,fontWeight:700,cursor:"pointer"}}>Cancel</button>}
          <button onClick={() => onAnswer(true)} style={{flex:"1 1 120px",padding:"12px 0",borderRadius:10,border:danger?"1px solid #f87171":"none",background:danger?"#991b1b":"#16a34a",color:"white",fontSize:14,fontWeight:800,cursor:"pointer"}}>{confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

// App calls this once: const [confirm, confirmDialog] = useConfirm(). confirm(options) opens the dialog and returns a promise of
// true (the confirm button) or false (Cancel, or a backdrop dismiss). App draws confirmDialog where it draws its other modals.
// It is a hook App calls, not a context: App cannot read a provider it renders itself, so the hook hands App the element to draw.
// The pages that confirm receive confirm as a prop. A call made while a dialog is open refuses the earlier call, so no question
// is answered by a press nobody saw.
function useConfirm() {
  const [request, setRequest] = React.useState(null);
  const pending = React.useRef(null);
  const confirm = React.useCallback(opts => new Promise(resolve => {
    if(pending.current) pending.current(false);
    pending.current = resolve;
    setRequest(opts);
  }), []);
  const answer = React.useCallback(ok => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    if(resolve) resolve(ok);
  }, []);
  return [confirm, request ? <ConfirmDialog {...request} onAnswer={answer}/> : null];
}
