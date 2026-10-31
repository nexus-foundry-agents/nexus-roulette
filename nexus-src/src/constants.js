// -- Constants & Lookup Tables --
import { useState, useEffect, useMemo } from "react";

// -- Constants --
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const DOZEN_LABELS = ["1st Dozen","2nd Dozen","3rd Dozen"];
const COLUMN_LABELS = ["1st Col","2nd Col","3rd Col"];
const DOZEN_RANGES = ["1-12","13-24","25-36"];
const COLUMN_RANGES = ["1,4..34","2,5..35","3,6..36"];
const DOZEN_BORDERS = ["#f59e0b","#3b82f6","#a855f7"];
const DOZEN_TEXTS = ["#fbbf24","#60a5fa","#c084fc"];
const COLUMN_BORDERS = ["#2dd4bf","#f472b6","#a3e635"];
const COLUMN_TEXTS = ["#5eead4","#f9a8d4","#bef264"];
const SOLUTION_TARGET_COLOR = "#fbbf24";
const INSIDE_BET_COLOR = "#c084fc"; // same purple the board uses for covered inside bets
const TRACK_COLORS = ["#f59e0b","#2dd4bf","#a855f7","#f97316","#38bdf8"];
const TRACK_ICONS = { fibonacci:"🎲", solution:"🎯", custom:"🃏" };
const STORAGE_KEY = "nexus-roulette-v1";
const APP_VERSION = "0.71.0";
const ROI_PRESETS = [5,10,15,20,25,30];
const UNITS = [0.25, 0.50, 1.00, 2, 5, 10]; // the quick base-bet presets; any other base is typed in (BaseBetInput.jsx)

const CURRENCIES = {
  USD:{ symbol:"$",  name:"US Dollar",        flag:"🇺🇸", rate:1,      dec:2 },
  EUR:{ symbol:"€",  name:"Euro",              flag:"🇪🇺", rate:0.92,   dec:2 },
  GBP:{ symbol:"£",  name:"British Pound",     flag:"🇬🇧", rate:0.79,   dec:2 },
  JPY:{ symbol:"¥",  name:"Japanese Yen",      flag:"🇯🇵", rate:149.5,  dec:0 },
  CAD:{ symbol:"C$", name:"Canadian Dollar",   flag:"🇨🇦", rate:1.36,   dec:2 },
  AUD:{ symbol:"A$", name:"Australian Dollar", flag:"🇦🇺", rate:1.53,   dec:2 },
  MXN:{ symbol:"$",  name:"Mexican Peso",      flag:"🇲🇽", rate:17.1,   dec:2 },
  CHF:{ symbol:"Fr", name:"Swiss Franc",       flag:"🇨🇭", rate:0.90,   dec:2 },
  SGD:{ symbol:"S$", name:"Singapore Dollar",  flag:"🇸🇬", rate:1.35,   dec:2 },
  HKD:{ symbol:"HK$",name:"Hong Kong Dollar",  flag:"🇭🇰", rate:7.82,   dec:2 },
  KRW:{ symbol:"₩",  name:"Korean Won",        flag:"🇰🇷", rate:1325,   dec:0 },
  BRL:{ symbol:"R$", name:"Brazilian Real",    flag:"🇧🇷", rate:4.97,   dec:2 },
  ARS:{ symbol:"$",  name:"Argentine Peso",    flag:"🇦🇷", rate:870,    dec:0 },
  CHIP:{ symbol:"🪙",name:"Chips (no currency)",flag:"🎰", rate:1,      dec:2 },
};

const CHANGELOG = [
  { v:"0.71.0", date:"Oct 31, 2026", title:"Undo Stays With Its Session", changes:[
    "Undo only works on the session it was made in: resuming a session, importing one, restarting setup or switching Live and Game turns it off instead of bringing back something old"
  ]},
  { v:"0.70.0", date:"Oct 31, 2026", title:"Names Who Read the Board", changes:[
    "When a board photo comes back, the review names who read it (for example Google Gemini or your PC)"
  ]},
  { v:"0.69.0", date:"Oct 31, 2026", title:"Undo Never Surprises", changes:[
    "Undo is refused after you abandon a track, and it is cleared when you clear the history or end, tear or start a session, so nothing old comes back by surprise"
  ]},
  { v:"0.68.0", date:"Oct 31, 2026", title:"Undo Stays Honest", changes:[
    "Undo is refused, with a reason, after a buy-in, cash-out or bankroll change, so money moves are never quietly reversed",
    "Every parked track now remembers when it was parked (imports and older sessions too), so its record can't be changed by a later fix"
  ]},
  { v:"0.67.0", date:"Oct 31, 2026", title:"Recording Keeps Going", changes:[
    "If a call to Casino fails, recording keeps going: later spins are still saved and the screen says what failed"
  ]},
  { v:"0.66.0", date:"Oct 31, 2026", title:"Undo Keeps Your Edits", changes:[
    "Undo is refused, with a reason, if you edited or parked a track after the last spin, so an edit is never silently lost",
    "Fixing a number from before you parked a track is refused with a reason, so the parked track's record stays right"
  ]},
  { v:"0.65.0", date:"Oct 31, 2026", title:"No Spin Lost on a Casino Blip", changes:[
    "When the Casino connection blips, new spins wait in line and send in order, instead of being dropped",
    "If a spin cannot be saved to Casino, the screen says so with a count; nothing is lost silently",
    "Stop asks before throwing away unsent spins and tells you how many"
  ]},
  { v:"0.64.0", date:"Oct 31, 2026", title:"Edits Start a New Track", changes:[
    "Editing a track (base bet or anything else) now parks it and starts a new track with a fresh record; The Solution keeps chasing its numbers in the new track",
    "Fixing a number from before your last edit is refused with a reason, so a parked track's record is never left wrong",
    "The recent numbers strip and typed amounts no longer jump back or clear when something else on screen changes"
  ]},
  { v:"0.63.0", date:"Oct 31, 2026", title:"Real vs Simulated, and Every Number in Game Mode", changes:[
    "Stats > Real vs simulated: for each casino, machine or table, and dealer, see the spins you logged, hits per number next to the simulated wheel, and the longest streaks",
    "Game mode's recent numbers now reach every number, 40 at a time, like the Live strip",
    "The catch-up card uses the same photo button as the rest of the app, and typed catch-up works for Game sessions too"
  ]},
  { v:"0.62.0", date:"Oct 31, 2026", title:"Who Read Your Board", changes:[
    "When a board photo comes back, the review says whether the cloud model or your PC read it"
  ]},
  { v:"0.61.0", date:"Oct 31, 2026", title:"Cash Out Says Why", changes:[
    "Typing a Cash Out above your bankroll now says why it can't be used and keeps your amount; it is no longer quietly cut to the bankroll"
  ]},
  { v:"0.60.0", date:"Oct 31, 2026", title:"Every Number, and Gold for the Coldest", changes:[
    "Swipe the recent numbers strip to see every number in the session, loaded 40 at a time; Newer and Older buttons sit beside it",
    "Gold marks the number with the highest loss level in each dozen and each column, on the board and on each tile; turn it off in Settings"
  ]},
  { v:"0.59.0", date:"Oct 31, 2026", title:"Money Fields Tell You Why", changes:[
    "Bankroll, buy-in, cash-out and base bet fields keep exactly what you type",
    "If an amount can't be used, the field says why and keeps your previous amount; nothing is rounded or cut off"
  ]},
  { v:"0.58.0", date:"Oct 31, 2026", title:"Exact Base Bets and a Sessions Browser", changes:[
    "Set your exact base bet on any track: tap 0.25, 0.50, 1, 2, 5 or 10, or type any amount up to 10,000",
    "Changing only the base on a track keeps its level, bets and results so far",
    "Browse sessions: grouped by day, filter by casino, machine or table, dealer and week",
    "Resume a session exactly where you left it, then catch up by typing the numbers you missed (repeats kept) or reading a board photo",
    "Rename a session so you can find it later"
  ]},
  { v:"0.57.0", date:"Oct 31, 2026", title:"Every Number From a Board Add Shows", changes:[
    "A board Add of more than 30 numbers now shows them all on the recent strip, so repeats like 2, 2, 2 at the start are visible",
    "Those numbers were always saved and counted; only the strip was cutting off the oldest ones"
  ]},
  { v:"0.56.0", date:"Oct 31, 2026", title:"The Solution Picks Your Number", changes:[
    "Your Solution entry setting (for example 90) is now saved and used everywhere; before, it went back to 120 and hid numbers like your 33",
    "Setting up a Solution track shows the 6 coldest numbers with misses and colour; tap one to chase it, and the card says Chasing 33 - 92 misses",
    "Edit a Solution track to change its entry; editing no longer drops the bets it holds, and picking a new number never drops a held bet"
  ]},
  { v:"0.55.0", date:"Oct 31, 2026", title:"Where You Play", changes:[
    "Starting a live session asks where you are playing: the casino, then the machine (maker, model, version) or the table and dealer; each is a list of what you used before, with Add new, and Skip",
    "Edit it any time; a dealer change mid-session is recorded from that spin on",
    "Stats shows the spins you have logged per casino, machine and dealer, the start of comparing real tables to the simulation"
  ]},
  { v:"0.54.0", date:"Oct 31, 2026", title:"Percentile Outlines", changes:[
    "Every number on the board gets a subtle outline from its losing streak: green from P75, yellow from P95, red from P98",
    "Nothing moves and the tap still picks the number; turn it off in Settings (Percentile outlines)"
  ]},
  { v:"0.53.0", date:"Oct 31, 2026", title:"TLV Tiles and a Cleaner Tap", changes:[
    "Each dozen and column tile shows its losing streak with a percentile badge (P25 to P98), its Total Loss Value with a small graph, the average and highest loss level, and how many of its numbers are cold",
    "Tap a tile for a full-screen chart of that section with every number's loss level and percentile",
    "Picking the hit: a tap anywhere in a number square counts, so the counter under the number never blocks it"
  ]},
  { v:"0.52.0", date:"Oct 30, 2026", title:"Streak Percentiles and the Spot Planner", changes:[
    "Every number, outside bet, dozen and column shows where its current losing streak sits (P50 to P98), from a 1000 x 1,000,000-spin simulation; the Stats page has the full table",
    "Settings: the counter under each number can show the percentile instead of the spin count",
    "Custom Bet Full Table: tap a level to see each spot's bet, payout and net, plus the bankroll needed for that level",
  ]},
  { v:"0.51.0", date:"Oct 30, 2026", title:"Spins Since Last Hit", changes:[
    "A small count under every number shows the spins since it last hit; turn it off in Settings",
    "Head start for unseen numbers (Settings, off by default): a number not seen yet this session starts at the wheel size, shown with a ~",
  ]},
  { v:"0.50.0", date:"Oct 30, 2026", title:"Read the Board From a Photo", changes:[
    "Read board photo: snap the table's recent-numbers board and the numbers come back for you to check; nothing is added until you press Add",
    "Works standalone and inside Nexus Casino; the reader runs on your own PC, and the first read after a while can take about a minute to warm up",
  ]},
  { v:"0.49.0", date:"Oct 29, 2026", title:"Fix a Wrong Number", changes:[
    "Long-press any recent number to correct it; every tracker, bet and your bankroll are recalculated as if the right number had been entered",
  ]},
  { v:"0.48.0", date:"Oct 29, 2026", title:"Faster at the Table", changes:[
    "Clear numbers: empty the recent numbers and their tracking without ending the session; your bankroll, buy-ins and history stay, and Undo is right there for 15 seconds",
    "Taps and long-presses no longer select text or pop up the copy menu while you enter numbers",
    "Dialogs close only on a tap that starts and ends outside them, never on a stray drag",
  ]},
  { v:"0.47.0", date:"Sep 9, 2026", title:"Nexus Casino Integration", changes:[
    "Roulette now launches as a complete module inside Nexus Casino while the standalone application remains available",
    "Signed-in Casino accounts synchronize Roulette sessions and preferences across devices, with conflict-safe local-first storage",
    "Casino recording covers Live and Game play with exact stakes, returns, duration controls, and retry-safe spins",
    "Google sign-in and Drive backup are retired; JSON download and import remain available for manual backups",
  ]},
  { v:"0.46.1", date:"Aug 29, 2026", title:"Fixes The Lockout On A Signed-In Phone", changes:[
    "Fixed the bug where the app answered \"401 Authorization Required\" on your own phone even while you were signed in to Connect, and only a private window would open it",
    "The offline worker was rebuilding each page request before sending it, which stripped the marker the staff gate uses to tell a page open from a background file fetch — so the gate refused it instead of sending you to the sign-in page",
    "It then stored that refusal offline, so the lockout survived signing in; the app now refuses to cache any error, and an expired session takes you to the Connect sign-in page instead of a dead end",
    "Installing the app no longer aborts when a file is fetched without a session, which used to leave the old broken worker in charge",
  ]},
  { v:"0.46.0", date:"Aug 14, 2026", title:"Every Track Reads Out Its Bets", changes:[
    "Every strategy track now spells out exactly which bets it places — 1st Dozen (1-12), 2nd Col (2,5..35), Red, #17 — as colour-coded chips on the track card, in Game and Live mode",
    "Chip colours are the same ones the dozen/column pickers and drought cards use, so a track's colour already matches the dozen or column it bets on — no more hand-matching",
    "New tracks are automatically coloured after their first target (falls back to the old rotation when that colour is already taken by a live track)",
    "Add Track and Edit Config show a live \"This Track Will Bet\" read-out before you commit",
    "Bet read-outs also appear on the Full Table header and its track tabs, the Abandon Progression buttons, Resume Closed Track buttons, Session Stats, and every Experimental strategy row",
    "Result flash names each line by the bet it placed (\"🎲 1st Dozen + 2nd Col (Prog)\") instead of just \"Prog\"",
    "Session Stats no longer merges two Progression tracks that bet different dozens into a single row",
  ]},
  { v:"0.45.0", date:"Jul 25, 2026", title:"Averages, Expected Loss + Repeat Experiments", changes:[
    "Averages grid in Experimental results: avg P&L per session and per sequence, avg winning vs losing session (with counts), avg sequences and avg staked per session",
    "Expected Loss panel: total staked × house edge for the wheel you ran (2.70% EU / 5.26% US), per-session expectation, and an actual-vs-expected luck delta",
    "Expected loss is shown as a secondary metric — real runs scatter around the drain and can finish in profit despite it",
    "🔁 Repeat Experiment: run the exact same setup up to 500 times; results include full aggregate stats across all runs (profitable %, avg/median/best/worst P&L — or bust rate and sessions survived in Bankroll Mode) plus a bar chart of every experiment's outcome",
  ]},
  { v:"0.44.0", date:"Jul 25, 2026", title:"Bankroll Survival + Sat-Out Metric", changes:[
    "💰 Bankroll Mode: P&L carries over between sessions from one buy-in (separate from stop loss); if the bankroll hits zero mid-session you're busted, and the results show how many sessions you survived",
    "Busted strategies leave the game while others keep playing; running bankroll shown on every session row",
    "Sat Out metric: how many sessions the strategy never entered at all (drought threshold never reached), as a stat tile and a Session Explorer filter",
  ]},
  { v:"0.43.0", date:"Jul 25, 2026", title:"Session Explorer", changes:[
    "Per-session drill-down in Experimental results: every session's P&L, sequence wins/losses, win rate, stop-loss count, and low/high water marks",
    "Filter sessions (All / Won / Lost / Hit Stop) and sort by order, best, or worst P&L",
    "Win rate definition shown in the results header: completed progressions ending in a win (a stop-loss counts as the losing end of one progression)",
  ]},
  { v:"0.42.0", date:"Jul 25, 2026", title:"Auto-Chase + Sharper Controls", changes:[
    "🔄 Auto-chase mode for Experimental Progression Bets: automatically bets the dozen or column that has missed the most, stays locked on it until it hits or the stop loss ends the sequence, then re-picks (ties broken at random)",
    "Min drought to enter is now a type-in field, and steps by 1 (not 5) when betting 12-number groups",
    "Min drought to enter is now an entry rule — it never abandons a progression mid-sequence; for The Solution it raises the enrollment bar instead of freezing live bets",
    "Onboarding preset buttons (bankroll, buy-in) now actually fill the amount field",
  ]},
  { v:"0.41.0", date:"Jul 25, 2026", title:"Experimental Overhaul + $10 Chip", changes:[
    "New $10 chip (blue) in the chip selector, Game and Live modes",
    "Experimental mode rebuilt: The Solution now bets every overdue number with its own progression, matching live play (results were unwinnable before)",
    "Min-drought-to-enter park rule now actually applies in simulations",
    "Progression Bet strategies must have a target before a simulation can start",
    "Stopping a simulation early is now labeled honestly and partial sessions are discarded",
    "Win rate now counts resolved sequences, not every intermediate losing spin",
    "Net P&L no longer counts cash-outs as losses",
    "Result flash and Stop Loss labels respect your chosen currency",
    "Large simulations run much faster (progression tables computed once, not per spin)",
  ]},
  { v:"0.35.0", date:"Apr 13, 2026", title:"Manual Betting", changes:[
    "Place bets directly on the roulette table — tap any number, dozen, column, or even money bet",
    "Casino-style chip selector with denominations from 25¢ to $500",
    "Undo, Clear, Double (2×), and Repeat last bet buttons",
    "Chip indicators show on the board where your bets are placed",
    "Manual bets resolve alongside strategy tracks on each spin",
    "Bets clear after every spin",
  ]},
  { v:"0.34.0", date:"Apr 13, 2026", title:"Full Roulette Table", changes:[
    "Complete roulette table with outside bets — columns (2:1), dozens, and even money",
    "Winning spin highlights the number AND all matching outside bets with golden glow",
    "Strategy bet numbers highlighted with track colors on the board",
  ]},
  { v:"0.33.0", date:"Apr 13, 2026", title:"Roulette Table Display", changes:[
    "Visual roulette table layout with traditional number arrangement",
    "Winning number highlighted with golden marker after each spin",
    "Update notifications now show what's new in each update",
  ]},
  { v:"0.32.0", date:"Apr 13, 2026", title:"Feedback Button", changes:[
    "Bug report & idea suggestion button (🐛) — floating top-left corner",
    "Submit feedback with text or voice-to-text, goes directly to developer",
  ]},
  { v:"0.31.0", date:"Apr 13, 2026", title:"Game Mode & Auto-Updates", changes:[
    "Game Mode — spin a virtual roulette wheel with your strategies, default mode on launch",
    "Auto-update detection — get notified when a new version is available, tap to update",
    "Session Profit display with last spin result",
    "Changelog versioning system",
  ]},
  { v:"0.30.0", date:"Apr 13, 2026", title:"Cloud Sync & Strategy Editing", changes:[
    "Cloud backup was available in this historical release",
    "Editing a strategy now parks the original and creates a new active variation",
    "Losses now properly tracked in session profit (was only showing wins)",
    "Hard reset now deletes cloud backup too",
    "Import session data loads and activates the imported session",
  ]},
  { v:"0.29.0", date:"Apr 13, 2026", title:"Three-Mode Layout", changes:[
    "Three app modes: Game, Live, Experimental (formerly Simulation)",
    "Full drought panel — even money, dozens, and columns all visible",
    "Session clock isolated — no more edit panel resets",
    "Network-first service worker — updates load without clearing cache",
  ]},
  { v:"1.2.0", date:"Apr 2025", title:"Cash Flow Tracking", changes:[
    "Cash Out button -- withdraw any amount from your bankroll at any time",
    "Full money flow log -- tracks every buy in and cash out with spin number",
    "Net Money In metric -- total bought in minus total cashed out",
    "Onboarding restart detects bankroll delta: increase = buy in, decrease = cash out",
    "Stats page shows Initial Bankroll, Total Buy Ins, Total Cash Outs, Net Money In, Net P&L",
    "Frequent buy ins flag losing sessions; cash outs with steady bankroll indicate casino winnings flowing out",
  ]},
  { v:"1.1.0", date:"Apr 2025", title:"Big Update", changes:[
    "Onboarding wizard -- set bankroll, currency & default buy-in on first launch",
    "Buy In modal -- add funds anytime, adjustable to the cent from any screen",
    "Multi-currency support (14 currencies) with live symbol formatting",
    "Currency conversion -- true exchange rate OR keep-same-numbers mode",
    "Bankroll tap-to-edit -- tap the bank amount in the header to edit directly",
    "In-app changelog -- you're reading it!",
    "Settings tab -- currency, default buy-in, onboarding reset",
  ]},
  { v:"1.0.0", date:"Apr 2025", title:"Live Deployment", changes:[
    "Deployed to Netlify via drag-and-drop",
    "Switched to CDN-loaded React (80KB vs 225KB bundle)",
    "Fixed ES module import/export syntax for browser compatibility",
  ]},
  { v:"0.9.0", date:"Apr 2025", title:"Spin Log", changes:[
    "Spin Log tab -- logs spins & updates droughts without advancing strategy levels",
    "Dozen & column drought heat cards (WARM/COOLING/COLD/FROZEN)",
    "Undo last spin, clear all spins",
    "Recent spins display (last 50)",
  ]},
  { v:"0.8.0", date:"Apr 2025", title:"Full Table View", changes:[
    "Full Table tab -- complete progression table for any active track",
    "Column legend explaining every header",
    "Jackpot mode columns (PW / JP return & profit) for dozen+column mix",
    "Track selector tabs for multi-track table view",
  ]},
  { v:"0.7.0", date:"Apr 2025", title:"Result Flash", changes:[
    "Result flash panel after each tracker tap with per-track outcomes",
    "Jackpot detection -- gold panel when 2+ tracks win simultaneously",
    "Net delta displayed on every result",
  ]},
  { v:"0.6.0", date:"Apr 2025", title:"Sessions", changes:[
    "Session save & resume system with localStorage persistence",
    "Session Stats tab with per-track performance breakdown",
    "Export all sessions as JSON with full metrics",
    "Tear session -- reset while keeping settings",
  ]},
  { v:"0.5.0", date:"Apr 2025", title:"Park & Play", changes:[
    "Park & Play -- freeze a track's level while still logging spins",
    "Multi-track color-coded dot overlay on number grid",
    "Track selector chip in Tracker tab",
  ]},
  { v:"0.4.0", date:"Apr 2025", title:"The Solution", changes:[
    "The Solution strategy -- single number drought targeting",
    "Entry threshold config (default 120 misses)",
    "Active bets panel with per-number level & bet size",
    "In-range number display sorted by drought depth",
  ]},
  { v:"0.3.0", date:"Apr 2025", title:"Jackpot Mode", changes:[
    "Progression Bet jackpot mode -- dozen + column mix with 6× payout math",
    "Number color coding: Jackpot (gold), Win (green), Breakeven (lime), Partial Loss (orange), Total Loss (dark)",
    "ROI stepper with quick presets 5-30%",
    "Stop loss configuration per track",
  ]},
  { v:"0.2.0", date:"Apr 2025", title:"Multi-Track", changes:[
    "Multi-track session model -- Active / Parked / Closed states",
    "Shared bankroll with per-track P&L tracking",
    "Add Track panel with Progression Bet and Solution types",
    "Unit size selection ($0.25 / $0.50 / $1.00)",
  ]},
  { v:"0.1.0", date:"Apr 2025", title:"Initial Build", changes:[
    "Basic roulette number grid with tap interaction",
    "American (0, 00) and European (0) wheel modes",
    "Bankroll & P&L display in header",
    "4-tab layout: Tracker / Full Table / Spin Log / Session Stats",
  ]},
];

// -- Currency helpers --
function getCurrency(code) { return CURRENCIES[code] || CURRENCIES.USD; }

function formatMoney(amount, currCode) {
  const cur = getCurrency(currCode);
  if (amount === undefined || amount === null || isNaN(amount)) return cur.symbol + "0";
  const abs = Math.abs(amount);
  let str;
  if (abs >= 1e6) str = (abs/1e6).toFixed(2) + "M";
  else if (abs >= 1000) str = (abs/1000).toFixed(1) + "k";
  else str = abs.toFixed(cur.dec);
  return (amount < 0 ? "-" : "") + cur.symbol + str;
}

function formatChips(chips, unit, currCode) {
  return formatMoney(chips * unit, currCode);
}

// Smart format: no decimals unless fractional part exists
function formatSmart(amount, cur) {
  var abs = Math.abs(amount);
  var hasFrac = abs % 1 !== 0;
  var str = hasFrac ? abs.toFixed(cur.dec) : abs.toFixed(0);
  return (amount<0?"-":"") + cur.symbol + str;
}
function formatNumber(amount) {
  var abs = Math.abs(amount);
  return abs % 1 !== 0 ? abs.toFixed(2) : abs.toFixed(0);
}

// -- Chip Denominations --
// Single source of truth for the chip selector racks (Game + Live pages).
const CHIP_DENOMS = [
  {val:0.25,color:"#89CFF0",border:"#5BA3D9",label:"25¢"},
  {val:0.50,color:"#FFB6C1",border:"#E8929E",label:"50¢"},
  {val:1,color:"#ffffff",border:"#aaaaaa",label:"$1"},
  {val:5,color:"#ef4444",border:"#b91c1c",label:"$5"},
  {val:10,color:"#3b82f6",border:"#1d4ed8",label:"$10"},
  {val:25,color:"#22c55e",border:"#15803d",label:"$25"},
  {val:100,color:"#1e293b",border:"#64748b",label:"$100"},
  {val:500,color:"#8b5cf6",border:"#6d28d9",label:"$500"},
];

// -- Bet Types & Helpers --
const BET_TYPES = [
  {key:"straight",label:"#",name:"Straight",pay:36,desc:"1 number"},
  {key:"split",label:"||",name:"Split",pay:18,desc:"2 numbers"},
  {key:"street",label:"|||",name:"Street",pay:12,desc:"3 numbers"},
  {key:"corner",label:"⊞",name:"Corner",pay:9,desc:"4 numbers"},
  {key:"line",label:"═",name:"Line",pay:6,desc:"6 numbers"},
  {key:"basket",label:"B",name:"Basket",pay:7,desc:"0,00,1,2,3"},
];

function getStreet(n) {
  var row = Math.ceil(n/3);
  return [(row-1)*3+1,(row-1)*3+2,(row-1)*3+3];
}
function getVerticalSplit(n) {
  var st = getStreet(n);
  var idx = st.indexOf(n);
  if(idx<2) return [n, n+1]; // up
  return [n-1, n]; // down
}
function getHorizontalSplit(n) {
  if(n<=3) return [n, n+3]; // right
  return [n-3, n]; // left
}
function getCornerNums(n) {
  var st = getStreet(n);
  var idx = st.indexOf(n);
  var base = idx<2 ? n : n-1; // use left two in row
  if(base+3<=36) return [base, base+1, base+3, base+4];
  return [base-3, base-2, base, base+1]; // use row above
}
function getLineNums(n) {
  var st = getStreet(n);
  var first = st[0];
  if(first+3<=34) return [first,first+1,first+2,first+3,first+4,first+5];
  return [first-3,first-2,first-1,first,first+1,first+2]; // use row above
}

function betCoveredNumbers(type, target) {
  if(type==="straight") return [target];
  if(type==="basket") return ["0","00","1","2","3"];
  if(type==="split") return target.split("-");
  if(type==="street") return target.split("-");
  if(type==="corner") return target.split("-");
  if(type==="line") return target.split("-");
  if(type==="dozen") { var d=+target; return Array.from({length:12},function(_,i){return String(d*12+i+1);}); }
  if(type==="column") { var c=+target; var nums=[]; for(var i=1;i<=36;i++){if((i%3===1&&c===0)||(i%3===2&&c===1)||(i%3===0&&c===2))nums.push(String(i));} return nums; }
  if(type==="red") return Array.from(RED).map(String);
  if(type==="black") { var b=[]; for(var i=1;i<=36;i++){if(!RED.has(i))b.push(String(i));} return b; }
  if(type==="odd") { var o=[]; for(var i=1;i<=36;i+=2)o.push(String(i)); return o; }
  if(type==="even") { var e=[]; for(var i=2;i<=36;i+=2)e.push(String(i)); return e; }
  if(type==="low") { var l=[]; for(var i=1;i<=18;i++)l.push(String(i)); return l; }
  if(type==="high") { var h=[]; for(var i=19;i<=36;i++)h.push(String(i)); return h; }
  return [];
}

function betPayoutMult(type) {
  if(type==="straight") return 36;
  if(type==="split") return 18;
  if(type==="street") return 12;
  if(type==="corner") return 9;
  if(type==="line") return 6;
  if(type==="basket") return 7;
  if(type==="dozen"||type==="column") return 3;
  return 2; // even money
}

function isInsideBet(type) {
  return type==="straight"||type==="split"||type==="street"||type==="corner"||type==="line"||type==="basket";
}

function signChips(chips, unit, currCode) {
  const v = chips * unit;
  return (v >= 0 ? "+" : "-") + getCurrency(currCode).symbol + Math.abs(v).toFixed(getCurrency(currCode).dec);
}

function convertAmount(amount, fromCode, toCode) {
  const from = getCurrency(fromCode), to = getCurrency(toCode);
  return amount * (to.rate / from.rate);
}

// -- Data helpers --
const generateId = () => Math.random().toString(36).slice(2,10);
const dozenOf = v => { if(v==="0"||v==="00")return null; const n=+v; return n<=12?0:n<=24?1:2; };
const columnOf = v => { if(v==="0"||v==="00")return null; const n=+v; return n%3===1?0:n%3===2?1:2; };

function getWheelNumbers(r) {
  const b = r==="american" ? ["0","00"] : ["0"];
  for(let i=1;i<=36;i++) b.push(String(i));
  return b;
}
function initDroughts(r) { const d={}; getWheelNumbers(r).forEach(n=>d[n]=0); return d; }

const TABLE_LIMIT_PRESETS = [
  {label:"$0.25 min (machine)", minBet:0.25, maxBet:100,   maxTotal:500},
  {label:"$0.50 min (machine)", minBet:0.50, maxBet:100,   maxTotal:500},
  {label:"$1 min",              minBet:1,    maxBet:500,   maxTotal:5000},
  {label:"$10 min",             minBet:10,   maxBet:2000,  maxTotal:10000},
  {label:"$15 min",             minBet:15,   maxBet:2000,  maxTotal:10000},
  {label:"$25 min",             minBet:25,   maxBet:10000, maxTotal:10000},
  {label:"$100 min (high limit)",minBet:100, maxBet:10000, maxTotal:50000},
];

const EVEN_MONEY = [
  {key:"red",   label:"Red",   color:"#ef4444", pred: n=>RED.has(n)},
  {key:"black", label:"Black", color:"#64748b", pred: n=>!RED.has(n)},
  {key:"odd",   label:"Odd",   color:"#a78bfa", pred: n=>n%2===1},
  {key:"even",  label:"Even",  color:"#60a5fa", pred: n=>n%2===0},
  {key:"high",  label:"19-36", color:"#fbbf24", pred: n=>n>=19},
  {key:"low",   label:"1-18",  color:"#86efac", pred: n=>n<=18},
];

// -- Bet Targets: what is this strategy actually betting on? --
// Single source of truth. Every surface that shows a track or a simulated
// strategy (track cards, progression table, session stats, Experimental rows,
// resume buttons, result flash) reads its wording AND its colours from here, so
// a track never has to be identified by cross-referencing a coloured dot with
// the pickers by hand. Colours deliberately reuse the dozen/column/even-money
// palettes the pickers and drought cards already use.
//
// Returns [{key, label, detail, color}] — an empty array means "nothing picked".
function betTargetList(type, config) {
  const cfg = config || {};
  const out = [];
  if(type==="fibonacci") {
    // Auto-chase (Experimental only) has no fixed target — it re-picks each sequence.
    if(cfg.autoChase) return [{key:"autochase",label:"🔄 Auto-chase",detail:"most-missed dozen/col",color:"#c4b5fd"}];
    (cfg.dozenTargets||[]).slice().sort((a,b)=>a-b).forEach(d=>{
      if(DOZEN_LABELS[d]) out.push({key:"dozen:"+d,label:DOZEN_LABELS[d],detail:DOZEN_RANGES[d],color:DOZEN_TEXTS[d]});
    });
    (cfg.colTargets||[]).slice().sort((a,b)=>a-b).forEach(c=>{
      if(COLUMN_LABELS[c]) out.push({key:"column:"+c,label:COLUMN_LABELS[c],detail:COLUMN_RANGES[c],color:COLUMN_TEXTS[c]});
    });
    (cfg.evenTargets||[]).forEach(k=>{
      const em = EVEN_MONEY.filter(e=>e.key===k)[0];
      if(em) out.push({key:"em:"+em.key,label:em.label,detail:"even money",color:em.color});
    });
    return out;
  }
  if(type==="solution") {
    const bets = cfg.activeBets||[];
    if(bets.length===0) return [{key:"sol-waiting",label:"Overdue numbers",detail:"≥"+(cfg.entryThreshold||120)+" misses",color:SOLUTION_TARGET_COLOR}];
    // A number speaks for itself — no detail, or a 20-number track becomes a wall.
    return bets.map(b=>({key:"s:"+b.number,label:"#"+b.number,detail:"",color:SOLUTION_TARGET_COLOR}));
  }
  if(type==="custom") {
    return (cfg.positions||[]).map((p,i)=>{
      const d = betPositionLabel(p);
      return {key:"pos"+i+":"+p.type+":"+p.target,label:d.label,detail:d.detail,color:d.color};
    });
  }
  return out;
}

// One custom-bet position, named the way a player would call it at the table.
function betPositionLabel(p) {
  if(p.type==="dozen")  { const d=+p.target; return {label:DOZEN_LABELS[d]||"Dozen",   detail:DOZEN_RANGES[d]||"",  color:DOZEN_TEXTS[d]||INSIDE_BET_COLOR}; }
  if(p.type==="column") { const c=+p.target; return {label:COLUMN_LABELS[c]||"Column", detail:COLUMN_RANGES[c]||"", color:COLUMN_TEXTS[c]||INSIDE_BET_COLOR}; }
  const em = EVEN_MONEY.filter(e=>e.key===p.type)[0];
  if(em) return {label:em.label,detail:"even money",color:em.color};
  if(p.type==="straight") return {label:"#"+p.target,detail:"straight",color:INSIDE_BET_COLOR};
  const bt = BET_TYPES.filter(b=>b.key===p.type)[0];
  return {label:(bt?bt.name:p.type),detail:betCoveredNumbers(p.type,p.target).join("/"),color:INSIDE_BET_COLOR};
}

// Plain-text form for headers, buttons and the result flash.
// detail:true appends the covered range, e.g. "1st Dozen (1-12) + 2nd Col (2,5..35)".
// max caps how many are spelled out before "+N more" (custom bets can be long).
function betTargetText(type, config, detail, max) {
  const list = betTargetList(type, config);
  if(list.length===0) return "No bet selected";
  const shown = max && list.length>max ? list.slice(0,max) : list;
  const txt = shown.map(t=>detail&&t.detail?t.label+" ("+t.detail+")":t.label).join(" + ");
  return shown.length<list.length ? txt+" +"+(list.length-shown.length)+" more" : txt;
}

// Colour a new track after the bet it actually places, so the dot on the card,
// the chip drawn on the board and the dozen/column pickers all already agree —
// no hand-matching. Falls back to the generic rotation when that colour is
// already spoken for by another live track (two tracks must stay tellable apart).
function pickTrackColor(type, config, existingTracks) {
  const taken = (existingTracks||[]).filter(t=>t.state!=="closed").map(t=>t.color);
  const targets = betTargetList(type, config);
  const preferred = targets.length>0 ? targets[0].color : null;
  if(preferred && taken.indexOf(preferred)<0) return preferred;
  const free = TRACK_COLORS.filter(c=>taken.indexOf(c)<0)[0];
  return free || TRACK_COLORS[(existingTracks||[]).length % TRACK_COLORS.length];
}
