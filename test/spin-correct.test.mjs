import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

const CLOCK = 1700002000000;
const NOW = 1700003000000;

// The files the bundle concatenates ahead of the pieces these tests use, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'spin-apply.js',
  'roulette-bets.mjs', 'components/ui.jsx', 'components/SpinTools.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global scope.
// Nothing is copied from source; the functions under test are the ones the bundle runs.
async function loadSlice() {
  const sources = await Promise.all(SLICE.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = SLICE.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n');
  const { code } = transformSync(combined, {
    babelrc: false,
    configFile: false,
    filename: 'app.jsx',
    presets: [
      [presetReact, { runtime: 'classic' }],
      [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
    ],
  });
  const store = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox; // standalone page: window.parent === window
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  return { ctx: sandbox };
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

// Track arrays are compared with each solution bet list sorted by number. Order is not semantic, and after a
// correction that un-hits a bet the replay may place that bet last. The golden replay below does not sort.
function sortedBets(sess) {
  return {
    ...sess,
    tracks: sess.tracks.map((t) => (t.config && Array.isArray(t.config.activeBets)
      ? { ...t, config: { ...t.config, activeBets: [...t.config.activeBets].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0)) } }
      : t)),
  };
}

// Deterministic spins from a seed (a small linear congruential generator), over the wheel's own numbers.
function spinsFrom(seed, count, wheel) {
  let x = seed >>> 0;
  const next = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  return Array.from({ length: count }, () => wheel[Math.floor(next() * wheel.length)]);
}

// A scripted table: four tracks of four kinds. Each is created before the first spin, as addTrack creates them.
function startSession(ctx) {
  const sess = plain(ctx.newSession('american', 500));
  Object.assign(sess, { id: 'spin-correct-1', name: 'Correction test', created: CLOCK, modified: CLOCK, sessionStartedAt: CLOCK });
  const dozen = plain(ctx.newTrack('fibonacci', 0, { ...plain(ctx.defaultFibCfg()), dozenTargets: [0], colTargets: [], stopLoss: 150 }));
  const odd = plain(ctx.newTrack('fibonacci', 1, { ...plain(ctx.defaultFibCfg()), dozenTargets: [], colTargets: [], evenTargets: ['odd'], stopLoss: 60 }));
  const solution = plain(ctx.newTrack('solution', 2, {
    ...plain(ctx.defaultSolCfg()), unit: 2,
    activeBets: [{ number: '17', level: 0, invest: 0 }, { number: '5', level: 0, invest: 0 }, { number: '23', level: 0, invest: 0 }],
  }));
  const custom = plain(ctx.newTrack('custom', 3, {
    type: 'custom', unit: 1, roi: 15, betMode: 'flat', stopLoss: 200,
    positions: [{ type: 'straight', target: '8', baseAmount: 1 }, { type: 'column', target: 1, baseAmount: 1 }],
  }));
  sess.tracks = [dozen, odd, solution, custom];
  return sess;
}

// Buy-ins and a cash-out at spin indices. `at` is the spin index before which the money moved.
const MONEY = [
  { at: 0, kind: 'buy', amount: 100 },
  { at: 12, kind: 'buy', amount: 200 },
  { at: 25, kind: 'buy', amount: 50 },
  { at: 30, kind: 'cash', amount: 150 },
];

// The live path, step for step: money first at its index, then each spin through applySpin, as App's tapNumber does.
// hooks maps a spin index to a change made before that spin (for example adding a track mid-session).
function buildLive(ctx, start, spins, money = MONEY, hooks = {}) {
  let s = plain(start);
  let at = CLOCK;
  for (let i = 0; i <= spins.length; i += 1) {
    if (hooks[i]) s = plain(hooks[i](s));
    money.filter((m) => m.at === i).forEach((m) => {
      at += 1000;
      s = plain(m.kind === 'buy' ? ctx.applyBuyIn(s, m.amount, at) : ctx.applyCashOut(s, m.amount, at));
    });
    if (i < spins.length) s = plain(ctx.applySpin(s, spins[i], true).sess);
  }
  return s;
}

function wheelOf(ctx, roulette = 'american') { return ctx.getWheelNumbers(roulette); }

// The seed whose scripted spins exercise every kind of derived state the replay must rebuild. The search stops at the
// first seed that covers all of them. Tests copy the result before they change anything.
function coveringSeed(ctx, start) {
  const wheel = wheelOf(ctx);
  for (let seed = 1; seed < 500; seed += 1) {
    const spins = spinsFrom(seed, 36, wheel);
    const live = buildLive(ctx, start, spins);
    const closed = live.tracks.some((t) => t.state === 'closed' && t.type !== 'solution');
    const solutionWin = live.tracks.some((t) => t.type === 'solution' && t.bets.some((b) => b.outcome === 'win'));
    const customWin = live.tracks.some((t) => t.type === 'custom' && t.bets.some((b) => b.outcome === 'win'));
    const progressionWin = live.tracks.some((t) => t.type === 'fibonacci' && t.bets.some((b) => b.outcome === 'win'));
    if (closed && solutionWin && customWin && progressionWin) return { seed, spins, live };
  }
  throw new Error('no covering seed found in the search range');
}

// A value different from the one recorded at index: a fixed step round the wheel.
function differentValue(ctx, sess, index, roulette = 'american') {
  const wheel = wheelOf(ctx, roulette);
  return wheel[(wheel.indexOf(sess.spins[index]) + 5) % wheel.length];
}

// The live state is replayed from its own record and must match exactly.
test('golden: replaying the recorded spins reproduces the live-built session exactly', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const { spins, live } = coveringSeed(ctx, start);
  assert.equal(spins.length, 36, 'the scripted session is 36 spins');
  const replayed = plain(ctx.replaySession(live, live.spins));
  assert.deepStrictEqual(replayed.spins, live.spins);
  assert.deepStrictEqual(replayed.droughts, live.droughts, 'droughts');
  assert.equal(replayed.bankrollCurrent, live.bankrollCurrent, 'bankrollCurrent');
  assert.deepStrictEqual(replayed.tracks, live.tracks, 'every track: bets, wins, sequences, level, pnl, state, closure, solution bets');
  assert.deepStrictEqual(replayed, live, 'the whole session');
});

test('the scripted session covers closure, a solution hit, a custom win, a progression win and mid-way money', async () => {
  const { ctx } = await load();
  const { live } = coveringSeed(ctx, startSession(ctx));
  assert.ok(live.tracks.some((t) => t.state === 'closed' && t.type !== 'solution'), 'a progression track closed by a losing spin');
  assert.ok(live.tracks.some((t) => t.type === 'solution' && t.bets.some((b) => b.outcome === 'win')), 'a solution hit removed a bet');
  assert.ok(live.tracks.some((t) => t.type === 'custom' && t.bets.some((b) => b.outcome === 'win')), 'a custom win');
  assert.ok(live.buyIns.length === 3 && live.cashOuts.length === 1, 'buy-ins and a cash-out at their spin indices');
  assert.ok(live.buyIns.some((b) => b.spin > 0 && b.spin < 36), 'a buy-in mid-way through the session');
});

// Every spin of the scripted session is corrected in turn. Each result must equal entering the corrected list fresh.
test('a correction at every spin replays to exactly what entering the corrected list fresh gives', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const { live } = coveringSeed(ctx, start);
  let checked = 0;
  for (let k = 0; k < live.spins.length; k += 1) {
    const value = differentValue(ctx, live, k);
    const result = plain(ctx.correctSpin(live, k, value, NOW));
    assert.equal(result.ok, true, `spin ${k} can be corrected`);
    assert.equal(result.session.spins[k], value, `spin ${k} now holds ${value}`);
    const fresh = buildLive(ctx, start, result.session.spins);
    fresh.modified = NOW;
    assert.deepStrictEqual(sortedBets(result.session), sortedBets(fresh), `correction at spin ${k} matches a fresh entry`);
    checked += 1;
  }
  assert.equal(checked, 36, 'all 36 spins were corrected and compared');
});

test('a track closed by the number being corrected reopens when the correction takes away its losing spin', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const { live } = coveringSeed(ctx, start);
  const closed = live.tracks.find((t) => t.state === 'closed' && t.type !== 'solution');
  const j = closed.closedAtSpin;
  // A winning number for this track: a dozen-0 track wins on 1-12, an odd track wins on odd numbers.
  const winners = closed.config.evenTargets && closed.config.evenTargets.includes('odd') ? ['1', '3', '5', '7'] : ['1', '2', '3'];
  const value = winners.find((w) => w !== live.spins[j]);
  const result = plain(ctx.correctSpin(live, j, value, NOW));
  assert.equal(result.ok, true);
  const after = result.session.tracks.find((t) => t.id === closed.id);
  assert.notEqual(after.closedAtSpin, j, 'the track no longer closes on the corrected spin');
  assert.ok(after.state === 'active' || after.closedAtSpin > j, 'the track is open again, or closed later by a later spin');
  const fresh = buildLive(ctx, start, result.session.spins);
  fresh.modified = NOW;
  assert.deepStrictEqual(sortedBets(result.session), sortedBets(fresh));
});

test('a track parked by hand keeps its recorded history, and the rest of the session is replayed', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const { live } = coveringSeed(ctx, start);
  const parked = plain(live);
  const index = parked.tracks.findIndex((t) => t.type === 'solution');
  parked.tracks[index].state = 'parked';
  const before = plain(parked.tracks[index]);
  const result = plain(ctx.correctSpin(parked, 4, differentValue(ctx, parked, 4), NOW));
  assert.equal(result.ok, true, 'a parked track does not block the correction');
  assert.deepStrictEqual(result.session.tracks[index], before, 'the parked track is exactly as recorded');
  assert.equal(result.session.tracks[index].state, 'parked');
});

test('bankroll the record cannot explain (a hand edit) is kept as a fixed amount through a correction', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const { live } = coveringSeed(ctx, start);
  const edited = plain(live);
  edited.bankrollCurrent = Math.round((live.bankrollCurrent + 37.5) * 100) / 100;
  const result = plain(ctx.correctSpin(edited, 9, differentValue(ctx, edited, 9), NOW));
  assert.equal(result.ok, true);
  const fresh = buildLive(ctx, start, result.session.spins);
  assert.equal(result.session.bankrollCurrent, Math.round((fresh.bankrollCurrent + 37.5) * 100) / 100);
});

// A ghost spin is logged without settling a track. The record does not say so, so a replay would settle it.
test('a session whose record cannot be replayed is refused, and nothing changes', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const spins = spinsFrom(7, 36, wheelOf(ctx));
  let s = plain(start);
  for (let i = 0; i < spins.length; i += 1) {
    s = plain(i === 3 ? ctx.applySpin(s, spins[i], false).sess : ctx.applySpin(s, spins[i], true).sess);
  }
  const before = plain(s);
  const result = plain(ctx.correctSpin(s, 10, differentValue(ctx, s, 10), NOW));
  assert.equal(result.ok, false);
  assert.match(result.reason, /ghost spin/);
  assert.match(ctx.spinCorrectionBlock(s), /can't be corrected/);
  assert.deepStrictEqual(s, before, 'the session passed in is unchanged');
});

test('a track added mid-session replays only from the spin it was created at', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const spins = spinsFrom(11, 30, wheelOf(ctx));
  const addLateTrack = (s) => {
    const t = plain(ctx.newTrack('solution', 4, { ...plain(ctx.defaultSolCfg()), activeBets: [{ number: spins[12], level: 0, invest: 0 }] }));
    t.createdAtSpin = s.spins.length; // App.jsx addTrack and updateTrackConfig stamp this
    return { ...s, tracks: [...s.tracks, t] };
  };
  const live = buildLive(ctx, start, spins, MONEY, { 10: addLateTrack });
  assert.equal(live.tracks[4].createdAtSpin, 10);
  assert.deepStrictEqual(plain(ctx.replaySession(live, live.spins)), live, 'a replay with the creation spin recorded is exact');
  const unstamped = plain(live);
  unstamped.tracks[4].createdAtSpin = 0; // the value newTrack gives before the stamp existed
  assert.notEqual(ctx.spinCorrectionBlock(unstamped), null, 'without the creation spin the record is refused, not guessed');
});

test('correctSpin refuses an index that is not in the session and a number that is not on the wheel', async () => {
  const { ctx } = await load();
  const { live } = coveringSeed(ctx, startSession(ctx));
  assert.equal(plain(ctx.correctSpin(live, -1, '5', NOW)).ok, false);
  assert.equal(plain(ctx.correctSpin(live, live.spins.length, '5', NOW)).ok, false);
  assert.equal(plain(ctx.correctSpin(live, 2, '37', NOW)).ok, false);
  assert.equal(plain(ctx.correctSpin(live, 2, '00', NOW)).ok, true, '00 is on an American wheel');
  let euro = plain(ctx.newSession('european', 500));
  ['1', '2', '3'].forEach((v) => { euro = plain(ctx.applySpin(euro, v, true).sess); });
  assert.equal(plain(ctx.correctSpin(euro, 1, '00', NOW)).ok, false, '00 is refused on a European wheel');
  assert.equal(plain(ctx.correctSpin(euro, 1, '36', NOW)).ok, true, '36 is accepted on a European wheel');
});

test('applySpin, applyBuyIn, applyCashOut and correctSpin never change their input', async () => {
  const { ctx } = await load();
  const start = startSession(ctx);
  const { live } = coveringSeed(ctx, start);
  const snapshot = plain(live);
  ctx.applySpin(live, '17', true);
  ctx.applyBuyIn(live, 25, NOW);
  ctx.applyCashOut(live, 25, NOW);
  ctx.replaySession(live, live.spins);
  ctx.correctSpin(live, 5, differentValue(ctx, live, 5), NOW);
  assert.deepStrictEqual(live, snapshot);
});

// The picker offers the wheel's own numbers. The shared Modal draws it.
function renderPicker(ctx, props) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SpinNumberPicker, {
    spinIndex: 4, spinCount: 30, currentValue: '17', roulette: 'american', blockedReason: null,
    onChoose: () => {}, onClose: () => {}, ...props,
  }));
}

test('the picker offers 0-36 and 00 only on an American wheel', async () => {
  const { ctx } = await load();
  const american = renderPicker(ctx, { roulette: 'american' });
  const european = renderPicker(ctx, { roulette: 'european' });
  assert.equal((american.match(/aria-label="Set spin 5 to /g) || []).length, 38, 'American: 0, 00 and 1-36');
  assert.match(american, /aria-label="Set spin 5 to 00"/);
  assert.equal((european.match(/aria-label="Set spin 5 to /g) || []).length, 37, 'European: 0 and 1-36');
  assert.doesNotMatch(european, /aria-label="Set spin 5 to 00"/);
  assert.match(american, /Correct spin 5 of 30/);
  assert.match(american, /position:fixed/, 'drawn by the shared Modal, as an overlay');
});

test('a blocked picker disables every number and shows the reason', async () => {
  const { ctx } = await load();
  const html = renderPicker(ctx, { blockedReason: "This session can't be corrected. Nothing has been changed." });
  assert.equal((html.match(/disabled=""/g) || []).length, 38);
  assert.match(html, /can&#x27;t be corrected|can't be corrected/);
});

// The long-press timer is injected, so the test drives time itself.
function fakeTimers() {
  let now = 0;
  let id = 0;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => { id += 1; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (k) => { pending.delete(k); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        pending.forEach((p, k) => { if (p.at <= target && (due === null || p.at < pending.get(due).at)) due = k; });
        if (due === null) break;
        const p = pending.get(due);
        pending.delete(due);
        now = p.at;
        p.fn();
      }
      now = target;
    },
    get size() { return pending.size; },
  };
}

test('a press fires once at 500 ms with its spin index, and a release after that does nothing more', async () => {
  const { ctx } = await load();
  const timers = fakeTimers();
  const fired = [];
  const press = ctx.createLongPress({ onLongPress: (i) => fired.push(i), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  press.down(7, 100, 100);
  timers.advance(499);
  assert.deepStrictEqual(fired, [], 'not before 500 ms');
  timers.advance(1);
  assert.deepStrictEqual(fired, [7], 'fires at 500 ms with the spin index');
  press.up();
  timers.advance(5000);
  assert.deepStrictEqual(fired, [7], 'a release after the press fired does not fire again');
});

test('a move past the slop, or a cancel from a scroll, ends the press without firing', async () => {
  const { ctx } = await load();
  const timers = fakeTimers();
  const fired = [];
  const press = ctx.createLongPress({ onLongPress: (i) => fired.push(i), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  press.down(3, 100, 100);
  press.move(100, 120); // 20 px: a swipe
  timers.advance(600);
  press.down(4, 100, 100);
  press.cancel(); // the browser took the pointer for a scroll
  timers.advance(600);
  press.down(5, 100, 100);
  press.move(100, 104); // 4 px: still a hold
  timers.advance(500);
  assert.deepStrictEqual(fired, [5], 'a small wobble still holds; a swipe or a scroll does not');
  assert.equal(timers.size, 0, 'no timer is left behind');
});

test('a release before 500 ms, and a second press, each leave one clean outcome', async () => {
  const { ctx } = await load();
  const timers = fakeTimers();
  const fired = [];
  const press = ctx.createLongPress({ onLongPress: (i) => fired.push(i), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  press.down(1, 0, 0);
  timers.advance(300);
  press.up(); // a tap: released early
  timers.advance(1000);
  press.down(2, 0, 0);
  press.down(9, 0, 0); // a second finger replaces the first press
  timers.advance(500);
  assert.deepStrictEqual(fired, [9]);
});

// The replay tests compare the replay with the same settlement, so they cannot catch a wrong sum inside it. These
// numbers are worked out by hand from the stakes and payouts, not from the code under test.
test('hand-computed arithmetic: a progression win and a miss, and a solution hit at unit 2, give the stated pnl and bankroll', async () => {
  const { ctx } = await load();
  // Dozen 0 at unit 1 with stop loss 150: level 1 stakes 1 chip on a 3-to-1 payout, profit 2.
  let s = plain(ctx.newSession('american', 500));
  s.tracks = [plain(ctx.newTrack('fibonacci', 0, { ...plain(ctx.defaultFibCfg()), dozenTargets: [0], colTargets: [], stopLoss: 150 }))];
  s = plain(ctx.applySpin(s, '5', true).sess); // 5 is in dozen 0: a win of 2
  assert.equal(s.bankrollCurrent, 502);
  assert.equal(s.tracks[0].pnl, 2);
  s = plain(ctx.applySpin(s, '30', true).sess); // 30 misses: the stake of 1 is lost and the level climbs to 1
  assert.equal(s.bankrollCurrent, 501);
  assert.equal(s.tracks[0].pnl, 1);
  assert.equal(s.tracks[0].level, 1);
  assert.deepStrictEqual(s.tracks[0].bets.map((b) => [b.spinIdx, b.outcome, b.profit]), [[0, 'win', 2], [1, 'loss', -1]]);
  assert.equal(s.droughts['5'], 1);
  // A solution bet on 17 at unit 2: the level-0 stake of 1 chip pays 36, so the win is 35 chips, which is 70 on the bankroll.
  let t = plain(ctx.newSession('american', 500));
  t.tracks = [plain(ctx.newTrack('solution', 0, { ...plain(ctx.defaultSolCfg()), unit: 2, activeBets: [{ number: '17', level: 0, invest: 0 }] }))];
  t = plain(ctx.applySpin(t, '17', true).sess);
  assert.equal(t.bankrollCurrent, 570);
  assert.equal(t.tracks[0].pnl, 35);
  assert.deepStrictEqual(t.tracks[0].config.activeBets, [], 'a hit removes its bet');
});

// The source checks: one settlement implementation, and nothing on the long-press path records a spin.
test('the live tap, a ghost spin and the replay share one settlement, and the long-press path records none', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  const tools = await readFile(new URL('components/SpinTools.jsx', SRC), 'utf8');
  const spinApply = await readFile(new URL('spin-apply.js', SRC), 'utf8');
  assert.match(app, /applySpin\(s,val,fromTracker\)/, 'tapNumber settles through applySpin');
  assert.match(app, /applySpin\(s, val, false\)/, 'a ghost spin logs through applySpin');
  assert.match(app, /applyBuyIn\(s, amount, Date\.now\(\)\)/);
  assert.match(app, /applyCashOut\(s, amount, Date\.now\(\)\)/);
  // closeTrack and the stats abandon are manual actions and stay in App.jsx; settlement (a spin's bets, pnl and
  // closure by a losing spin) must not.
  assert.doesNotMatch(app, /t\.bets\.push\(|t\.pnl\s*[+-]=|closedAtSpin=s\.spins\.length-1/, 'App.jsx keeps no settlement copy');
  assert.match(spinApply, /t\.bets\.push\(/, 'the settlement lives in spin-apply.js');
  assert.match(spinApply, /Object\.assign\(work, applySpin\(work, spins\[i\], true\)\.sess\)/, 'the replay settles through applySpin');
  const open = app.slice(app.indexOf('  function openSpinCorrection('), app.indexOf('  function applySpinCorrection('));
  assert.ok(open.length > 0 && open.length < 200, 'openSpinCorrection sits between its two lines');
  assert.doesNotMatch(open, /tapNumber|ghostSpin|updSess|applySpin/, 'opening the picker records no spin');
  const apply = app.slice(app.indexOf('  function applySpinCorrection('), app.indexOf('  function reactivateTrack('));
  assert.ok(apply.includes('correctSpin(appState.currentSession'), 'applying a correction goes through correctSpin');
  assert.doesNotMatch(apply, /tapNumber|ghostSpin|updSess|applySpin\(/, 'applying a correction does not settle a spin');
  assert.doesNotMatch(tools, /tapNumber|ghostSpin|updSess|applySpin|correctSpin/, 'the strip and picker never settle or record a spin');
  assert.doesNotMatch(tools, /onNumber|onGhost/, 'the strip has no tap or ghost path');
});

test('the add-track and track-config paths stamp the spin they are created at', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.match(app, /t\.createdAtSpin=s\.spins\.length; s\.tracks\.push\(t\);/);
  assert.match(app, /nt\.state = "active";\s*nt\.createdAtSpin = s\.spins\.length;/);
});

test('spin-apply.js touches no React, storage, clock or DOM; the build compiles it after session.js', async () => {
  const spinApply = await readFile(new URL('spin-apply.js', SRC), 'utf8');
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  assert.doesNotMatch(spinApply, /localStorage|document\.|setTimeout|setState|Math\.random|Date\.now/);
  assert.ok(build.indexOf("'session.js'") < build.indexOf("'spin-apply.js'"), 'after session.js');
  assert.ok(build.indexOf("'spin-apply.js'") < build.indexOf("'App.jsx'"), 'before App.jsx');
});
