// -- Number drought count --
// The count printed small under a number on the roulette board and the progression grid. ONE
// implementation for both boards. The slot is always rendered and `on` only changes its visibility, so a
// cell is the same size with the count on or off (rule 82). The text is fixed-height and nowrap, so a
// longer count such as ~99 cannot wrap onto a second line and grow the cell.

// The text a number's count shows. Pure and display only: it reads droughts and never writes them.
//   - A number that has come up this session (it is in spins) shows its true drought, head start or not.
//   - An unseen number shows its true drought, or, with the head start on, its drought plus the wheel
//     size, marked "~" as an estimate (for example ~41).
// `wheelSize` is the length of the wheel's own number list (getWheelNumbers), never a constant.
function displayDrought(num, droughts, spins, wheelSize, headStart) {
  const plain = (droughts && droughts[num]) || 0;
  const unseen = !(spins || []).some(s => String(s) === String(num));
  if (headStart === true && unseen) return "~" + (plain + wheelSize);
  return String(plain);
}

// `view` carries the board's shared inputs once: droughts, spins, wheelSize, headStart and on.
function NumberDrought({num, view}) {
  return (
    <div
      aria-hidden={view.on ? undefined : true}
      style={{fontSize:7,fontWeight:400,lineHeight:"8px",height:8,color:"#aab6c6",textAlign:"center",whiteSpace:"nowrap",visibility:view.on?"visible":"hidden"}}>
      {displayDrought(num, view.droughts, view.spins, view.wheelSize, view.headStart)}
    </div>
  );
}
