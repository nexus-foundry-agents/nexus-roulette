// -- Spin application: the one implementation shared by a live tap, a ghost spin, and the replay that corrects a spin --
// Nothing in this file touches React, storage, the clock or the DOM. Every function returns a new session object and
// leaves its input unchanged. The caller decides what to do with the result (App.jsx writes it back into app state).
//
// What a replay can and cannot reproduce is the contract of replaySession and spinCorrectionBlock below. In short:
//   - Replayed: spins, droughts, each track's bets/wins/sequences/level/pnl and its closure by a losing spin,
//     the solution bet list (except its order after a correction that un-hits a bet), and bankrollCurrent from
//     bankroll plus the recorded buy-ins and cash-outs plus each tracked spin's pnl.
//   - Kept exactly as recorded: tracks that were parked or manually closed or reactivated (their history is not in
//     the record), and any money the record cannot place by spin index.
//   - Refused: a session whose recorded tracks do not reproduce when its own spins are replayed (for example a
//     spin logged without settling a track, which the record does not mark); and a spin played before the last edit
//     or the last Park button press (lastEditSpin, lastParkSpin), because a parked track's record is kept as it was and
//     cannot follow a correction. Undo last spin is refused (undoBlockReason) when an edit or park came after the spin.

// A spin index is a whole number from 0 up to, but not including, the count (or up to and including it when
// the count is the number of spins after the last one).
function isSpinIndex(i, count) { return Number.isInteger(i) && i >= 0 && i < count; }

// Settles one spin. fromTracker false logs the spin for droughts only (a ghost spin, or a live spin with no
// active track). Returns the next session, the total bankroll change, and the per-track lines the flash shows.
function applySpin(sess, val, fromTracker) {
  const s = JSON.parse(JSON.stringify(sess));
  const trackResults = []; let totalDelta = 0;
  s.spins.push(val);
  const nd = {...s.droughts}; Object.keys(nd).forEach(k => nd[k]++); nd[val] = 0; s.droughts = nd;
  if(!fromTracker) return {sess: s, totalDelta, trackResults};
  s.tracks.forEach(t => {
    if(t.state!=="active") return;
    const tbl=computeTableForTrack(t);
    if(t.type==="fibonacci") {
      const dts=t.config.dozenTargets||[], cts=t.config.colTargets||[], evts=t.config.evenTargets||[];
      const betMode=t.config.betMode||"progression";
      // Auto-martingale when even money targets selected
      const effectiveBetMode = betMode==="flat" ? "flat" : (evts.length>0 ? "martingale" : "progression");
      const row=tbl[Math.min(t.level,tbl.length-1)];
      const isZ=val==="0"||val==="00";

      // Determine hit
      let hitCount=0;
      if(!isZ) {
        if(evts.length>0) {
          evts.forEach(key=>{const em=EVEN_MONEY.find(e=>e.key===key);if(em&&em.pred(+val))hitCount++;});
        } else {
          if(dts.includes(dozenOf(val)))hitCount++;
          if(cts.includes(columnOf(val)))hitCount++;
        }
      }
      const isHit=hitCount>0;
      const payMult=evts.length>0?2:3;
      const numTargets=evts.length>0?evts.length:(dts.length+cts.length)||1;
      // Name every flash line by the bet it placed, not just the track type.
      const flashName=TRACK_ICONS[t.type]+" "+betTargetText(t.type,t.config)
        +" ("+(effectiveBetMode==="martingale"?"Martingale":effectiveBetMode==="flat"?"Flat":"Prog")+")";

      if(effectiveBetMode==="flat") {
        // No progression -- level stays 0
        if(isHit) {
          const profit=hitCount*payMult-numTargets;
          t.pnl+=profit; t.wins++;
          t.bets.push({spinIdx:s.spins.length-1,level:0,outcome:"win",profit,cat:"win"});
          totalDelta+=profit*(t.config.unit||1);
          trackResults.push({name:flashName,color:t.color,profit,unit:t.config.unit||1,outcome:"Win",cat:"win"});
        } else {
          t.pnl-=numTargets;
          t.bets.push({spinIdx:s.spins.length-1,level:0,outcome:"loss",profit:-numTargets,cat:"loss"});
          totalDelta-=numTargets*(t.config.unit||1);
          trackResults.push({name:flashName,color:t.color,profit:-numTargets,unit:t.config.unit||1,outcome:"Miss",cat:"loss"});
        }
      } else {
        // Progression or Martingale
        const cat=isZ?"loss":getCategory(val,dts,cts,row,evts);
        if(cat!=="loss") {
          const profit=hitCount*payMult*(row?row.c:1)-(row?row.totalInvest:0);
          const spinDelta=hitCount*payMult*(row?row.c:1)-(row?row.c:1)*numTargets;
          t.pnl+=spinDelta; t.wins++; t.sequences++; t.level=0;
          t.bets.push({spinIdx:s.spins.length-1,level:t.level,outcome:"win",profit,cat});
          totalDelta+=spinDelta*(t.config.unit||1);
          trackResults.push({name:flashName,color:t.color,profit,unit:t.config.unit||1,outcome:cat==="jackpot"?"Jackpot!":"Win",cat});
        } else {
          const betChips=(row?row.c:1)*numTargets;
          t.pnl-=betChips;
          t.bets.push({spinIdx:s.spins.length-1,level:t.level,outcome:"loss",profit:-betChips,cat:"loss"});
          const bc=betChips*(t.config.unit||1);
          totalDelta-=bc;
          if(t.level<tbl.length-1) t.level++; else{ t.state="closed"; t.closedAtSpin=s.spins.length-1; }
          trackResults.push({name:flashName,color:t.color,profit:-(row?row.c:1),unit:t.config.unit||1,outcome:"Miss",cat:"loss"});
        }
      }
    }
    if(t.type==="solution") {
      const bets=t.config.activeBets||[]; const resolved=[];
      bets.forEach(b => {
        if(b.number===val) {
          const row=tbl[Math.min(b.level,tbl.length-1)];
          const winDelta=row?(row.ret-row.c):0;
          const profit=row?row.profit:0;
          t.pnl+=winDelta; t.wins++; t.sequences++; resolved.push(b.number);
          totalDelta+=winDelta*(t.config.unit||1);
          t.bets.push({spinIdx:s.spins.length-1,level:b.level,outcome:"win",profit,cat:"win"});
          trackResults.push({name:TRACK_ICONS[t.type]+" #"+b.number,color:t.color,profit,unit:t.config.unit||1,outcome:"Win",cat:"win"});
        } else {
          const lossCost=(tbl[Math.min(b.level,tbl.length-1)]?tbl[Math.min(b.level,tbl.length-1)].c:1);
          t.pnl-=lossCost;
          b.level=Math.min(b.level+1,tbl.length-1);
          trackResults.push({name:TRACK_ICONS[t.type]+" #"+b.number,color:t.color,profit:-lossCost,unit:t.config.unit||1,outcome:"Miss",cat:"loss"});
          totalDelta-=lossCost*(t.config.unit||1);
        }
      });
      t.config.activeBets=bets.filter(b=>!resolved.includes(b.number));
    }
    if(t.type==="custom") {
      const positions=t.config.positions||[];
      const row=tbl[Math.min(t.level,tbl.length-1)];
      const mult=row?row.c:1;
      const baseTotalBet=positions.reduce(function(sum,p){return sum+p.baseAmount;},0);
      var payout=0;
      positions.forEach(function(p){
        var covered=betCoveredNumbers(p.type,p.target);
        if(covered.indexOf(val)>=0) payout+=p.baseAmount*betPayoutMult(p.type);
      });
      var totalReturn=payout*mult;
      var betMode=t.config.betMode||"flat";
      var customName="🃏 "+betTargetText(t.type,t.config,false,3);
      if(payout>0) {
        var spinDelta=totalReturn-baseTotalBet*mult;
        if(betMode==="flat") {
          t.pnl+=spinDelta; t.wins++;
          t.bets.push({spinIdx:s.spins.length-1,level:0,outcome:"win",profit:spinDelta,cat:"win"});
          totalDelta+=spinDelta*(t.config.unit||1);
          trackResults.push({name:customName+" (Flat)",color:t.color,profit:spinDelta,unit:t.config.unit||1,outcome:"Win",cat:"win"});
        } else {
          var seqProfit=totalReturn-(row?row.totalInvest:baseTotalBet);
          t.pnl+=spinDelta; t.wins++; t.sequences++; t.level=0;
          t.bets.push({spinIdx:s.spins.length-1,level:t.level,outcome:"win",profit:seqProfit,cat:"win"});
          totalDelta+=spinDelta*(t.config.unit||1);
          trackResults.push({name:customName+" (Prog)",color:t.color,profit:seqProfit,unit:t.config.unit||1,outcome:"Win",cat:"win"});
        }
      } else {
        var lossCost=baseTotalBet*mult;
        t.pnl-=lossCost;
        t.bets.push({spinIdx:s.spins.length-1,level:t.level,outcome:"loss",profit:-lossCost,cat:"loss"});
        totalDelta-=lossCost*(t.config.unit||1);
        if(betMode!=="flat") {
          if(t.level<tbl.length-1) t.level++; else{ t.state="closed"; t.closedAtSpin=s.spins.length-1; }
        }
        trackResults.push({name:customName+(betMode!=="flat"?" (Prog)":" (Flat)"),color:t.color,profit:-lossCost,unit:t.config.unit||1,outcome:"Miss",cat:"loss"});
      }
    }
  });
  s.bankrollCurrent = Math.round((s.bankrollCurrent + totalDelta)*100)/100;
  return {sess: s, totalDelta, trackResults};
}

// A buy-in or cash-out, recorded with the number of spins that stood before it. Same bankroll rounding as the live path.
function applyBuyIn(sess, amount, at) {
  const s = JSON.parse(JSON.stringify(sess));
  s.bankrollCurrent=Math.round((s.bankrollCurrent+amount)*100)/100;
  s.totalBuyIn=(s.totalBuyIn||0)+amount;
  if(!s.buyIns) s.buyIns=[];
  s.buyIns.push({amount,at,spin:s.spins.length});
  return s;
}

function applyCashOut(sess, amount, at) {
  const s = JSON.parse(JSON.stringify(sess));
  s.bankrollCurrent=Math.round((s.bankrollCurrent-amount)*100)/100;
  s.totalCashOut=(s.totalCashOut||0)+amount;
  if(!s.cashOuts) s.cashOuts=[];
  s.cashOuts.push({amount,at,spin:s.spins.length});
  return s;
}

// A track's history can be replayed when every bet carries a spin index (a manual entry such as an abandon does not)
// and its state is one a settlement can explain:
//   active, never closed or reactivated (closedAtSpin is null); or
//   closed by a losing spin, where the last bet is that loss and closedAtSpin is its spin.
// Parked tracks, manually closed tracks, and reactivated tracks are not replayable: the record does not say when they
// changed state, so they are kept exactly as recorded.
function trackReplayable(t, spinCount) {
  const bets = t.bets || [];
  if(!bets.every(b => isSpinIndex(b.spinIdx, spinCount))) return false;
  const closedAt = t.closedAtSpin == null ? null : t.closedAtSpin;
  if(t.state==="active") return closedAt===null;
  if(t.state==="closed") {
    const last = bets[bets.length-1];
    return closedAt!==null && !!last && last.outcome==="loss" && last.spinIdx===closedAt;
  }
  return false;
}

// The starting bet list of a solution track: the bets it holds now, plus the number each recorded win removed.
// A hit removes its bet from the list, so the removed numbers are read back from the spins the wins point at.
// Every starting bet has level 0, as addSolBet and the candidate flow create them. The order of removed bets is not
// recorded, so a removed bet is placed last; after a replay that keeps the bet removed, the order is the same as live.
function startingSolutionBets(track, spins) {
  const bets = (track.config.activeBets || []).map(b => ({...b, level: 0}));
  const held = new Set(bets.map(b => b.number));
  (track.bets || []).forEach(b => {
    if(b.outcome!=="win" || !isSpinIndex(b.spinIdx, spins.length)) return;
    const n = spins[b.spinIdx];
    if(held.has(n)) return;
    held.add(n);
    bets.push({number: n, level: 0, invest: 0});
  });
  return bets;
}

// Replays spins over the starting state of sess. sess is the recorded session: its tracks, money and bankroll are
// the starting point and its recorded spins are read where a starting bet list needs them. spins is what to replay.
// The result is a new object; sess is not changed.
function replaySession(sess, spins) {
  const recordedCount = sess.spins.length;
  const frozen = {};
  const recorded = JSON.parse(JSON.stringify(sess));
  const work = JSON.parse(JSON.stringify(sess));
  work.spins = [];
  work.droughts = initDroughts(work.roulette);
  work.bankrollCurrent = work.bankroll;
  // Money is rebuilt from the placeable records below; the recorded lists and totals are restored afterwards.
  work.buyIns = []; work.totalBuyIn = 0; work.cashOuts = []; work.totalCashOut = 0;
  work.tracks = sess.tracks.map(t => {
    const copy = JSON.parse(JSON.stringify(t));
    if(!trackReplayable(t, recordedCount)) {
      frozen[t.id] = copy;
      return {...copy, state: "frozen"};
    }
    const config = {...(t.config || {})};
    if(t.type==="solution") config.activeBets = startingSolutionBets(t, sess.spins);
    const startsLater = (t.createdAtSpin || 0) > 0;
    return {...copy, config, state: startsLater ? "pending" : "active", pnl: 0, level: 0, wins: 0,
      sequences: 0, bets: [], closedAtSpin: null, createdAtSpin: t.createdAtSpin || 0};
  });
  // A replayable track starts settling at its creation spin. Tracks created after the last spin start there.
  const activate = (index) => {
    work.tracks = work.tracks.map(t => (t.state==="pending" && (t.createdAtSpin||0) <= index)
      ? {...t, state: "active"} : t);
  };

  const money = [];
  (sess.buyIns || []).forEach(b => money.push({kind: "buy", amount: b.amount, at: b.at, spin: b.spin}));
  (sess.cashOuts || []).forEach(c => money.push({kind: "cash", amount: c.amount, at: c.at, spin: c.spin}));
  const placed = money
    .filter(m => isSpinIndex(m.spin, spins.length + 1))
    .sort((a, b) => (a.spin - b.spin) || ((a.at || 0) - (b.at || 0)));

  let m = 0;
  for(let i = 0; i <= spins.length; i++) {
    activate(i);
    while(m < placed.length && placed[m].spin === i) {
      const ev = placed[m];
      const next = ev.kind === "buy" ? applyBuyIn(work, ev.amount, ev.at) : applyCashOut(work, ev.amount, ev.at);
      Object.assign(work, next);
      m++;
    }
    if(i < spins.length) Object.assign(work, applySpin(work, spins[i], true).sess);
  }
  activate(Infinity);

  work.tracks = work.tracks.map(t => frozen[t.id] || t);
  work.buyIns = recorded.buyIns || []; work.totalBuyIn = recorded.totalBuyIn || 0;
  work.cashOuts = recorded.cashOuts || []; work.totalCashOut = recorded.totalCashOut || 0;
  return work;
}

// Deep equality that ignores key order. The app stores plain JSON, so this is enough for the comparisons below.
function sameValue(a, b) {
  if(a===b) return true;
  if(typeof a!=='object' || typeof b!=='object' || a===null || b===null) return false;
  if(Array.isArray(a)!==Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if(ka.length!==kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}

// Solution bet order is not semantic and is not always recoverable, so comparisons sort it by number.
function canonicalTracks(tracks) {
  return tracks.map(t => {
    if(!t.config || !Array.isArray(t.config.activeBets)) return t;
    const bets = t.config.activeBets.slice().sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    return {...t, config: {...t.config, activeBets: bets}};
  });
}

// Compares a replay of the recorded spins with the record. Returns the parts that differ (empty when it reproduces).
function replayMismatches(sess, replayed) {
  const problems = [];
  if(!sameValue(replayed.droughts, sess.droughts)) problems.push("droughts");
  if(!sameValue(canonicalTracks(replayed.tracks), canonicalTracks(sess.tracks))) problems.push("tracks");
  return problems;
}

// Why a correction cannot be applied to this session, or null when it can. The record must reproduce from its own
// spins; otherwise a correction would be a guess about which tracks acted on which spins.
function spinCorrectionBlock(sess, replayed) {
  const problems = replayMismatches(sess, replayed || replaySession(sess, sess.spins));
  if(problems.length===0) return null;
  return "This session can't be corrected. Replaying its recorded spins does not reproduce its track history. "
    + "This happens when a ghost spin was logged while a track was active. Nothing has been changed.";
}

// The spin count at which the latest edit parked a track. App.jsx's updateTrackConfig starts the edit's new track at that
// count and marks it startedByEdit, so this is the largest createdAtSpin among the marked tracks, and 0 when no edit has
// been made. It is read from the new track, not stamped on the parked one: clearSpins resets createdAtSpin on every track
// when it removes the spins, so the boundary falls back to 0 with them, and Undo of a clear restores it.
function lastEditSpin(sess) {
  let at = 0;
  (sess.tracks || []).forEach(t => { if(t.startedByEdit && (t.createdAtSpin || 0) > at) at = t.createdAtSpin; });
  return at;
}

// The reason a spin played before the last edit cannot be corrected. The parked track keeps its record as it was, so a
// correction to that spin could not reach its P&L or the bankroll: the refusal is the only honest answer.
const EDIT_BOUNDARY_REASON = "This spin was played before you edited a track. Corrections can only change spins after the last edit.";

// The spin count at which the latest park happened. parkToggle (the Park button), updateTrackConfig (an edit), an import
// and the load migration (a park saved before park points existed) all stamp parkedAtSpin; clearSpins resets it to 0 with
// createdAtSpin, so Clear numbers removes the boundary with the spins.
function lastParkSpin(sess) {
  let at = 0;
  (sess.tracks || []).forEach(t => { if((t.parkedAtSpin || 0) > at) at = t.parkedAtSpin; });
  return at;
}

// The reason a spin played before the last Park button press cannot be corrected. Same boundary as an edit, for a park.
const PARK_BOUNDARY_REASON = "This spin was played before a track was parked. Corrections can only change spins after the last park.";

// Why the spin at index cannot be corrected, or null. This is the one refusal: correctSpin applies it and the number picker
// shows it. A spin before the latest edit or park gets that boundary's reason (the edit's when both are the same count); any
// other refusal is spinCorrectionBlock's, for the session.
function spinCorrectionBlockAt(sess, index, replayed) {
  const edit = lastEditSpin(sess), park = lastParkSpin(sess);
  if(index < Math.max(edit, park)) return edit >= park ? EDIT_BOUNDARY_REASON : PARK_BOUNDARY_REASON;
  return spinCorrectionBlock(sess, replayed);
}

// Undo last spin restores the session as it was before the last tapped spin (prevSess). Anything recorded after that spin
// would go with it, so Undo is refused for each kind, with its reason: a track edit or park (a boundary above the spin count
// prevSess holds), money that moved (a buy-in, cash-out, bankroll edit or currency conversion), an abandon (Abandon
// Progression, which moves a track's P&L and writes a record into its bets, so the money check cannot see it), and a spin
// recorded after it (a ghost spin, or a spin no track settled), a replace of the tapped number, and any other track change: a
// track added, closed, reactivated or moved, a Solution bet added or removed, a chase changed (any difference from the tracks the
// tap leaves). Returns the reason, or null when Undo may run (and when there is nothing to undo). tapped is the number the tap recorded.
const UNDO_BLOCK_REASON = "Undo is off: a track was edited or parked after the spin it would reverse, and Undo would drop that change.";
const UNDO_MONEY_REASON = "Undo is off after a buy-in, cash-out or bankroll change. Fix the number instead.";
const UNDO_ABANDON_REASON = "Undo is off after a track was abandoned. Fix the number instead.";
const UNDO_SPIN_REASON = "Undo is off after a ghost spin or an untracked spin. Fix the number instead.";
const UNDO_CHANGED_REASON = "Undo is off: the session was changed after the spin it would reverse. Undo would drop that change.";
const UNDO_TRACK_REASON = "Undo is off after a track change. Fix the number instead.";
// The fields a tapped spin changes, and the fields a Save stamps (mode, metrics, modified). Any other field of the session that
// differs from the snapshot was changed after the spin, so Undo would undo that change too. The list is closed: a field added
// later is refused until it is named here.
const TAP_CHANGED_KEYS = ["spins", "droughts", "tracks", "bankrollCurrent", "modified", "sessionStartedAt", "metrics", "mode"];
// The money records a spin never changes, so a difference from prevSess is money that moved after the spin. Compared by
// value, not by spin index: Clear numbers keeps the money and its spin indices and resets only the spin count.
const MONEY_RECORD_KEYS = ["bankroll", "totalBuyIn", "totalCashOut", "buyIns", "cashOuts", "bankrollEdits"];
// The tracks the tap leaves when it is applied to the snapshot: the snapshot's tracks plus the tapped spin's own settlement.
// A track that differs from them was changed after the spin, by an action rather than by the tap.
function tracksAfterTap(prevSess, tapped) { return applySpin(prevSess, tapped, true).sess.tracks; }
function undoBlockReason(sess, prevSess, tapped) {
  if(!prevSess) return null;
  if(Math.max(lastEditSpin(sess), lastParkSpin(sess)) > prevSess.spins.length) return UNDO_BLOCK_REASON;
  if(MONEY_RECORD_KEYS.some(k => !sameValue(sess[k], prevSess[k]))) return UNDO_MONEY_REASON;
  // An abandon is a bets record with type "abandon" (it has no spin index). An abandon recorded after the spin is one more here.
  const abandons = s => (s.tracks || []).reduce((n, t) => n + (t.bets || []).filter(b => b.type === "abandon").length, 0);
  if(abandons(sess) > abandons(prevSess)) return UNDO_ABANDON_REASON;
  // A tapped spin adds exactly one spin to prevSess, so any spin beyond that was recorded after it.
  if((sess.spins || []).length > prevSess.spins.length + 1) return UNDO_SPIN_REASON;
  // Otherwise the spin list must be the snapshot's plus one spin, with the snapshot's spins unchanged: a list that changed
  // earlier, or kept its length, was not made by this tap (the session was replaced, or another copy of it was merged in).
  const spins = sess.spins || [], was = prevSess.spins || [];
  if(spins.length !== was.length + 1 || !was.every((v, i) => spins[i] === v)) return UNDO_CHANGED_REASON;
  // The last spin must be the number the tap recorded, so a replace of that number is refused. A snapshot with no recorded number is refused too.
  if(spins[spins.length - 1] !== tapped) return UNDO_CHANGED_REASON;
  // The tracks must be what the snapshot's tracks become under the tapped spin. Any track action after the spin (added, closed,
  // reactivated, moved, a Solution bet changed) leaves a difference here, so no action has to be stamped to be refused.
  if(!sameValue(canonicalTracks(tracksAfterTap(prevSess, tapped)), canonicalTracks(sess.tracks || []))) return UNDO_TRACK_REASON;
  // Every other field must be as the snapshot left it, apart from what a tap and a Save change.
  if(Object.keys({...sess, ...prevSess}).some(k => !TAP_CHANGED_KEYS.includes(k) && !sameValue(sess[k], prevSess[k]))) return UNDO_CHANGED_REASON;
  return null;
}

// Replaces the spin at index with value and replays the session. Refuses (ok false) when the index or number is not
// valid for the wheel, or when the record cannot be replayed. Bankroll that the record cannot explain (a bankroll
// edit, a live manual-bet settlement, a currency change) is kept as a fixed amount on top of the replay.
// Returns {ok, changed, session}; session is a new object, and the input is not changed.
function correctSpin(sess, index, value, now) {
  const v = String(value);
  if(!isSpinIndex(index, sess.spins.length)) return {ok: false, reason: "That spin is not in this session."};
  if(!getWheelNumbers(sess.roulette).includes(v)) return {ok: false, reason: "That number is not on this wheel."};
  const recorded = replaySession(sess, sess.spins);
  const block = spinCorrectionBlockAt(sess, index, recorded);
  if(block) return {ok: false, reason: block};
  if(sess.spins[index]===v) return {ok: true, changed: false, session: JSON.parse(JSON.stringify(sess))};
  const spins = sess.spins.slice();
  spins[index] = v;
  const offset = Math.round((sess.bankrollCurrent - recorded.bankrollCurrent)*100)/100;
  const next = replaySession(sess, spins);
  next.bankrollCurrent = Math.round((next.bankrollCurrent + offset)*100)/100;
  next.modified = now;
  return {ok: true, changed: true, session: next};
}
