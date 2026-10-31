// -- Game Engine: Math, Droughts, Table Calculations --

function countDrought(spins, predicate) {
  let count=0;
  for(let i=spins.length-1;i>=0;i--){
    const v=spins[i];
    if(v==="0"||v==="00"){count++;continue;}
    if(predicate(+v)) return count;
    count++;
  }
  return count;
}

// -- The Solution's in-range numbers --
// A straight number is in range when its miss count, droughts[n] (the count the board and the Solution grid show), is at
// or above the track's entry threshold. Zeros are never Solution targets. Pure: reads droughts and writes nothing.
// The simulation (simulation.js), the live in-range list and candidate list (App.jsx) and the Solution picker all use these.
function solutionInRangeMember(droughts, num, threshold) {
  if(num==="0"||num==="00") return false;
  return ((droughts&&droughts[num])||0) >= threshold;
}

// The in-range numbers of a wheel, coldest first: the largest miss count first, equal counts in wheel order.
function solutionInRange(droughts, wheelNums, threshold) {
  const d = droughts||{};
  return wheelNums
    .filter(n => solutionInRangeMember(d, n, threshold))
    .sort((a, b) => (d[b]||0) - (d[a]||0));
}

// The Solution's default entry threshold: the value a new Solution track starts at, and the value the candidate card and
// the picker use when no Solution track is shown. It is the founder's setting, settings.solEntryDefault (the setup's Entry
// Threshold stepper saves it), when that is a whole number of at least 20; otherwise 120. A track keeps the threshold it
// was created with (config.entryThreshold). Changing the default never changes a track that already exists.
const SOL_ENTRY_DEFAULT = 120;
function solEntryDefault(settings) {
  const v = settings ? settings.solEntryDefault : undefined;
  return typeof v === "number" && Math.floor(v) === v && v >= SOL_ENTRY_MIN ? v : SOL_ENTRY_DEFAULT;
}

// A new Solution track's config, at the default entry threshold. Pure.
function solDefaultCfg(settings) {
  return {...defaultSolCfg(), entryThreshold: solEntryDefault(settings)};
}

// The Solution picker's cold list: the `count` coldest straight numbers on a wheel, coldest first. Zeros are never targets
// and are left out. Equal miss counts keep wheel order, which for 1 to 36 is numeric order.
function solutionColdest(droughts, wheelNums, count) {
  const d = droughts||{};
  return wheelNums
    .map((n, i) => ({n, i}))
    .filter(x => x.n!=="0"&&x.n!=="00")
    .sort((a,b) => ((d[b.n]||0)-(d[a.n]||0)) || (a.i-b.i))
    .slice(0, count)
    .map(x => x.n);
}

// One picker row: the number, its miss count, whether it is in range, and its single-number percentile tier on the wheel
// (streakPercentile in percentile.js, read only; percentileTier in tlv.js). The tier is null below P25 or with no table. Pure.
function solutionPickRow(droughts, wheel, threshold, n) {
  const misses = (droughts&&droughts[n])||0;
  return {
    number: n,
    misses,
    inRange: solutionInRangeMember(droughts, n, threshold),
    tier: percentileTier(streakPercentile("straight:"+n, wheel, misses)),
  };
}

// The one number a track setup preselects: the only in-range number, or null when there are none or several. Pure.
function solutionPreselect(droughts, wheelNums, threshold) {
  const inR = solutionInRange(droughts, wheelNums, threshold);
  return inR.length===1 ? inR[0] : null;
}

// The miss counts of every number on a wheel, recounted from kept spins. A wheel change or an onboarding restart keeps the
// spin history, so the counts come from it rather than from zero. They are the counts applySpin keeps: a number's misses are
// the spins since it last came up, or every spin when it never has. countDrought never reads a zero (it counts every 0 and 00
// as a miss), so a zero counts back to its own last spin.
function droughtsFromSpins(spins, wheel) {
  const sp = spins||[];
  const d = {};
  getWheelNumbers(wheel).forEach(n => {
    d[n] = (n==="0"||n==="00") ? sp.length-1-sp.lastIndexOf(n) : countDrought(sp, v => v===+n);
  });
  return d;
}

// The number a Solution track chases, read from the track as it stands. Pure.
//   config.chaseNumber is the number the operator tapped to chase; the track holds its bet. The chase is that number, and
//   no other held bet can take it over. Held bets are never dropped by a tap.
//   state "chasing": the chased number is held; number is it.
//   state "hit":     the chased number has come up and is no longer held; number is null, hit is that number.
//   state "none":    nothing is chased (chaseNumber is null, or the operator removed the chased bet with ×).
//   A track made before chaseNumber existed (undefined) chases its first held bet, as it did before.
function solutionChase(track, spins) {
  const cfg = (track && track.config) || {};
  const bets = cfg.activeBets || [];
  if(cfg.chaseNumber === undefined) {
    if(bets.length) return {state: "chasing", number: bets[0].number, hit: null};
    const wins = (track.bets || []).filter(b => b.outcome === "win");
    const last = wins.length ? (spins||[])[wins[wins.length-1].spinIdx] : undefined;
    return last !== undefined ? {state: "hit", number: null, hit: last} : {state: "none", number: null, hit: null};
  }
  if(cfg.chaseNumber === null) return {state: "none", number: null, hit: null};
  if(bets.some(b => b.number === cfg.chaseNumber)) return {state: "chasing", number: cfg.chaseNumber, hit: null};
  return {state: "hit", number: null, hit: cfg.chaseNumber};
}

// The line that names the number a Solution track chases. Pure: reads the track, the miss counts and the kept spins.
//   "Chasing 33 - 92 misses"                         the chased number
//   "Chasing 33 - 90 misses · below entry (90/120)"  the same, while the number is below the track's threshold
//   "Chasing 33 - 92 misses (+1 more)"               when the track holds other bets as well
//   "33 hit - pick the next number"                  the chased number has come up
//   "Not chasing a number"                           nothing is chased
function solutionChaseText(track, droughts, spins) {
  const c = solutionChase(track, spins);
  if(c.state === "chasing") {
    const n = c.number, misses = (droughts&&droughts[n])||0, thr = track.config.entryThreshold;
    const others = ((track.config.activeBets||[]).length) - 1;
    let text = "Chasing " + n + " - " + misses + " misses";
    if(others > 0) text += " (+" + others + " more)";
    if(misses < thr) text += " · below entry (" + misses + "/" + thr + ")";
    return text;
  }
  if(c.state === "hit") return c.hit + " hit - pick the next number";
  return "Not chasing a number";
}

// The Solution's entry threshold, one stepper step at a time. Steps of 5, never below 20 (the setup and the Edit Config
// stepper share this). Pure.
const SOL_ENTRY_MIN = 20;
function nextEntryThreshold(value, step) {
  return Math.max(SOL_ENTRY_MIN, value + step);
}

// The config after a tap that chases a number. The number becomes the chased one; its bet is added only if it is not
// already held. Every other held bet stays with its level. Pure.
function chaseSolConfig(config, number) {
  const bets = (config && config.activeBets) || [];
  const held = bets.some(b => b.number === number);
  return {...config, activeBets: held ? bets : [...bets, {number, level: 0, invest: 0}], chaseNumber: number};
}

// The config after an explicit × or + on one bet (the in-range list and the Active Bets ×). Removing the chased bet clears
// the chase; adding a bet leaves the chase as it is. Pure.
function toggleSolBetConfig(config, number) {
  const bets = (config && config.activeBets) || [];
  if(bets.some(b => b.number === number)) {
    const chase = config.chaseNumber === number ? null : config.chaseNumber;
    return {...config, activeBets: bets.filter(b => b.number !== number), chaseNumber: chase};
  }
  return {...config, activeBets: [...bets, {number, level: 0, invest: 0}]};
}

// The config to save from the Edit Config panel. The panel's copy was taken when it opened, so the held bets, their levels
// and the chased number are always the live ones; only the fields the panel edits come from the copy. Pure.
function editedTrackConfig(live, edited) {
  const out = {...edited};
  if(live && "activeBets" in live) out.activeBets = live.activeBets;
  if(live && "chaseNumber" in live) out.chaseNumber = live.chaseNumber;
  else delete out.chaseNumber;
  return out;
}

function formatElapsed(ms) {
  const s=Math.floor(ms/1000);
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h>0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

// Builds the betting progression table. Each row is one level of the ladder:
//   level        — 1-based rung number
//   c            — chips bet PER TARGET at this level
//   totalBet     — chips placed this spin (c × number of targets)
//   totalInvest  — cumulative chips sunk since the sequence started
//   ret          — chips returned if this level hits
//   profit       — ret − totalInvest (net for the whole sequence on a hit)
//   roi          — profit / totalInvest × 100
// The `c` key is a persisted schema field (saved sessions reference it) — do not rename.
function computeTable(subsets, payoutMult, roiPct, maxChips) {
  const r=roiPct/100, denom=payoutMult-subsets*(1+r);
  if(denom<=0) return [];
  const rows=[]; let invest=0;
  for(let lvl=1;lvl<=500;lvl++) {
    const c=invest===0?1:Math.ceil(invest*(1+r)/denom);
    const tb=c*subsets;
    if(maxChips!==undefined&&invest+tb>maxChips) break;
    invest+=tb;
    const ret=c*payoutMult, profit=ret-invest;
    if(profit<=0) break;
    rows.push({level:lvl,c,totalBet:tb,totalInvest:invest,ret,profit,roi:profit/invest*100});
  }
  return rows;
}

function computeTableForTrack(t) {
  if(t.type==="custom") {
    var positions = t.config.positions||[];
    if(positions.length===0) return [];
    var baseTotalBet = positions.reduce(function(s,p){return s+p.baseAmount;},0);
    if(baseTotalBet===0) return [];
    var minWinPayout = Infinity;
    var nums = ["0","00"];
    for(var i=1;i<=36;i++) nums.push(String(i));
    nums.forEach(function(numStr){
      var payout = 0;
      positions.forEach(function(p){
        var covered = betCoveredNumbers(p.type, p.target);
        if(covered.indexOf(numStr)>=0) payout += p.baseAmount * betPayoutMult(p.type);
      });
      if(payout>0 && payout<minWinPayout) minWinPayout=payout;
    });
    if(minWinPayout===Infinity) return [];
    var betMode = t.config.betMode||"flat";
    var maxChips = t.config.stopLoss/(t.config.unit||1);
    if(betMode==="flat") {
      return [{level:1,c:1,totalBet:baseTotalBet,totalInvest:baseTotalBet,ret:minWinPayout,profit:minWinPayout-baseTotalBet,roi:(minWinPayout-baseTotalBet)/baseTotalBet*100,flat:true}];
    }
    return computeTable(baseTotalBet, minWinPayout, t.config.roi, maxChips);
  }
  if(t.type==="fibonacci") {
    const dts=t.config.dozenTargets||[], cts=t.config.colTargets||[], evts=t.config.evenTargets||[];
    const betMode=t.config.betMode||"progression";
    const effectiveBetMode = betMode==="flat" ? "flat" : (evts.length>0 ? "martingale" : "progression");
    const maxChips=t.config.stopLoss/(t.config.unit||1);
    if(effectiveBetMode==="flat") {
      const payMult=evts.length>0?2:3;
      const subs=evts.length>0?evts.length:(dts.length+cts.length)||1;
      return [{level:1,c:1,totalBet:subs,totalInvest:subs,ret:payMult,profit:payMult-subs,roi:(payMult-subs)/subs*100,flat:true}];
    }
    if(evts.length>0) {
      if(effectiveBetMode==="martingale") return computeMartingaleTable(maxChips);
      return computeTable(evts.length,2,t.config.roi,maxChips);
    }
    const subs=dts.length+cts.length, hasMix=dts.length>0&&cts.length>0;
    return computeTable(subs||1,hasMix?6:3,t.config.roi,maxChips);
  }
  return computeTable(1,36,t.config.roi,t.config.stopLoss/(t.config.unit||1));
}

// Per-spot breakdown for one level of a Custom Bet track: one entry per position, in the order given.
// Money is in currency (chips × unit), the same units as the Return and Profit columns.
//   betPerSpot — the stake on this spot this spin: baseAmount × c × unit
//   payout     — what the spot pays if it hits: on its WORST covered number, the gross return of every
//                position covering that number (overlaps count). Gross includes the stake.
//   net        — payout − totalInvest × unit: what is left after the bankroll the level needs is paid back.
// Pure: reads positions and levelRow and never writes to either.
function computeSpotBreakdown(positions, levelRow, unit) {
  const u = unit||1, c = levelRow.c;
  const round = x => Math.round(x*1e6)/1e6; // clears floating-point noise so a zero net never shows as −0
  const grossOn = {}; // number → chips returned if that number hits
  positions.forEach(p => {
    const gross = p.baseAmount*c*betPayoutMult(p.type);
    betCoveredNumbers(p.type, p.target).forEach(n => {
      const k = String(n);
      grossOn[k] = (grossOn[k]||0) + gross;
    });
  });
  const invested = levelRow.totalInvest*u;
  return positions.map(p => {
    const covered = betCoveredNumbers(p.type, p.target).map(String);
    const worst = covered.length ? Math.min(...covered.map(n => grossOn[n])) : 0;
    const payout = worst*u;
    return {betPerSpot: round(p.baseAmount*c*u), payout: round(payout), net: round(payout-invested)};
  });
}

function getCategory(val, dts, cts, row, evts) {
  if(val==="0"||val==="00") return "loss";
  const n=+val;
  if(evts&&evts.length>0) {
    const hits=evts.filter(key=>{const em=EVEN_MONEY.find(e=>e.key===key);return em&&em.pred(n);}).length;
    if(hits===0) return "loss";
    if(hits>=2) return "jackpot";
    return "win";
  }
  const inD=dts.includes(dozenOf(val)), inC=cts.includes(columnOf(val));
  if(!inD&&!inC) return "loss";
  if(inD&&inC) return "jackpot";
  if(!row) return "win";
  const profit=3*row.c-row.totalInvest, pct=profit/row.totalInvest;
  if(pct>0.04) return "win";
  if(pct>-0.04) return "breakeven";
  return "partial-loss";
}

function droughtBadge(d) {
  if(d===0) return{t:"JUST HIT",c:"#4ade80"};
  if(d<=3)  return{t:"WARM",c:"#86efac"};
  if(d<=7)  return{t:"COOLING",c:"#fbbf24"};
  if(d<=12) return{t:"COLD",c:"#f97316"};
  return{t:"FROZEN",c:"#f87171"};
}

function numDroughtStyle(d, entry, maxLvl, isAct) {
  if(isAct) return{bg:"#0d2a0d",bd:"#4ade80",tx:"#4ade80"};
  if(d===0) return{bg:"#0a1a0a",bd:"#166534",tx:"#22c55e"};
  if(d<entry-30) return{bg:"#080808",bd:"#111827",tx:"#1f2937"};
  if(d<entry) { const p=(d-(entry-30))/30; return{bg:"#1a1000",bd:"rgba(245,158,11,"+(0.2+p*0.5)+")",tx:"rgba(251,191,36,"+(0.3+p*0.7)+")"}; }
  if(d<=entry+maxLvl) return{bg:"#1c1000",bd:"#f59e0b",tx:"#fbbf24"};
  return{bg:"#200505",bd:"#dc2626",tx:"#f87171"};
}

// One cell of The Solution's Tap Winning Number grid. Pure. A held bet takes numDroughtStyle's held colours. The chased
// number takes the track's colour as its ring and shows the CHASE label. The number just tapped (flashed) takes a white ring
// and a light fill, as the progression grid's flash does. A last hit (zero misses) keeps numDroughtStyle's own colours.
// The chase and the flash are different properties.
function solGridCellStyle(d, entry, maxLvl, held, chased, flashed, trackColor) {
  const base = numDroughtStyle(d, entry, maxLvl, held === true);
  return {
    bg: flashed ? "#ffffff22" : base.bg,
    bd: flashed ? "#ffffff" : chased ? (trackColor || base.bd) : base.bd,
    tx: base.tx,
    chase: chased === true,
  };
}

const categoryStyle = cat => {
  if(cat==="jackpot")      return{bd:"#fbbf24",tx:"#fbbf24",bg:"#1c1500"};
  if(cat==="win")          return{bd:"#4ade80",tx:"#4ade80",bg:"#0a1f0a"};
  if(cat==="breakeven")    return{bd:"#a3e635",tx:"#a3e635",bg:"#0d1a00"};
  if(cat==="partial-loss") return{bd:"#f97316",tx:"#f97316",bg:"#1a0a00"};
  return{bd:"#1f2937",tx:"#1f2937",bg:"#080808"};
};