// -- Number drought count --
// The count printed small under a number on the roulette board and the progression grid. ONE
// implementation for both boards. The slot is always rendered and `on` only changes its visibility, so a
// cell is the same size with the count on or off (rule 82). The text is fixed-height and nowrap, so a
// longer count such as ~99 cannot wrap onto a second line and grow the cell.

// The length a number's count measures, and whether it is the head-start estimate. Pure.
// An unseen number with the head start on counts its drought plus the wheel size; every other number counts its drought.
function counterLength(num, droughts, spins, wheelSize, headStart) {
  const plain = (droughts && droughts[num]) || 0;
  const unseen = !(spins || []).some(s => String(s) === String(num));
  const estimate = headStart === true && unseen;
  return {length: estimate ? plain + wheelSize : plain, estimate};
}

// The text a number's count shows in Spins mode. Pure and display only: it reads droughts and never writes them.
//   - A number that has come up this session (it is in spins) shows its true drought, head start or not.
//   - An unseen number shows its true drought, or, with the head start on, its drought plus the wheel
//     size, marked "~" as an estimate (for example ~41).
// `wheelSize` is the length of the wheel's own number list (getWheelNumbers), never a constant.
function displayDrought(num, droughts, spins, wheelSize, headStart) {
  const c = counterLength(num, droughts, spins, wheelSize, headStart);
  return (c.estimate ? "~" : "") + String(c.length);
}

// The text in Percentile mode: where the same count sits among that number's completed losing streaks on this
// wheel, as P96 (percentTag). The estimate keeps its "~", and its percentile is that of the estimated count.
// A view that names no wheel, or no "percentile" counter, shows the Spins text.
function displayCounter(num, view) {
  if (view.counter !== "percentile" || !view.wheel) return displayDrought(num, view.droughts, view.spins, view.wheelSize, view.headStart);
  const c = counterLength(num, view.droughts, view.spins, view.wheelSize, view.headStart);
  const tag = percentTag(streakPercentile("straight:" + num, view.wheel, c.length));
  return tag === "" ? "" : (c.estimate ? "~" : "") + tag;
}

// A percentile beside a count (the drought cards). Always rendered: a null percentile is hidden with visibility, and
// its width is still reserved, so the row never changes size with the value (rule 82). "P99" is the widest text the
// tag can hold, so the hidden tag reserves the width of a shown one.
function PercentTag({pct}) {
  const tag = percentTag(pct);
  return (
    <span
      aria-hidden={tag === "" ? true : undefined}
      style={{fontSize:8,fontWeight:600,color:"#64748b",marginLeft:3,visibility:tag === "" ? "hidden" : "visible"}}>
      {tag === "" ? "P99" : tag}
    </span>
  );
}

// `view` carries the board's shared inputs once: droughts, spins, wheelSize, headStart and on. The Percentile
// counter also reads `counter` ("percentile") and `wheel`; without them the counter shows Spins.
function NumberDrought({num, view}) {
  return (
    <div
      aria-hidden={view.on ? undefined : true}
      style={{fontSize:7,fontWeight:400,lineHeight:"8px",height:8,color:"#aab6c6",textAlign:"center",whiteSpace:"nowrap",visibility:view.on?"visible":"hidden"}}>
      {displayCounter(num, view)}
    </div>
  );
}
