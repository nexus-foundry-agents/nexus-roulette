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
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

const CLEAR_AT = 1700001000000;
const UNDO_AT = 1700001005000;

// The files the bundle concatenates ahead of the pieces these tests use, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js',
  'roulette-bets.mjs', 'components/ui.jsx', 'components/SpinTools.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global
// scope. The bundle's require('react') is answered by the React this file imports, so the markup these
// tests render is the markup the bundle's createElement calls produce. Nothing is copied from source.
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
  return { ctx: sandbox, store };
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

const NOOP = () => {};
const controls = { onAsk: NOOP, onCancel: NOOP, onConfirm: NOOP, onUndo: NOOP };
async function render(name, props) {
  const { ctx } = await load();
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx[name], props));
}
const renderRow = (props) => render('SpinTools', { confirmOpen: false, undoVisible: false, ...controls, ...props });
const renderStrip = (spins) => render('RecentNumbersStrip', { spins, trackOverlays: [] });
const SPINS = (n) => Array.from({ length: n }, (_, i) => String((i * 5) % 36 + 1));
// The first element of a render is the reserved slot; its opening tag carries the slot's layout.
const openingTag = (html) => html.match(/^<[a-z]+[^>]*>/)[0];

// Money as loadApp recomputes it: 500 bankroll + 200 buy-in - 50 cash-out + track pnl, where the
// tracks give 0.1 (unit 1) + 0.2 x 2 (unit 2) + -30 (unit 1) = -29.5. The fixture stores that value.
const EXPECTED_BANKROLL = 620.5;

function liveSession(ctx) {
  const sess = plain(ctx.newSession('american', 500));
  Object.assign(sess, {
    id: 'live-session-1', name: 'Live test', created: 1700000000000, modified: 1700000500000,
    sessionStartedAt: 1700000000000, sessionEndedAt: null,
    totalBuyIn: 200, buyIns: [{ amount: 200, at: 1700000001000, spin: 0 }],
    totalCashOut: 50, cashOuts: [{ amount: 50, at: 1700000400000, spin: 3 }],
    bankrollCurrent: EXPECTED_BANKROLL,
    spins: ['17', '0', '5', '22', '33', '17'],
  });
  sess.droughts = plain(ctx.initDroughts('american'));
  sess.droughts['5'] = 1;

  const fib = plain(ctx.newTrack('fibonacci', 0, ctx.defaultFibCfg()));
  Object.assign(fib, {
    pnl: 0.1, level: 2, wins: 1, sequences: 1, createdAtSpin: 2,
    bets: [
      { spinIdx: 0, level: 0, outcome: 'win', profit: 2, cat: 'win' },
      { spinIdx: 1, level: 0, outcome: 'loss', profit: -1, cat: 'loss' },
    ],
  });
  fib.config.dozenTargets = [1];

  const sol = plain(ctx.newTrack('solution', 1, {
    ...plain(ctx.defaultSolCfg()),
    unit: 2,
    activeBets: [{ number: '17', level: 2, invest: 9 }, { number: '5', level: 0, invest: 0 }],
  }));
  Object.assign(sol, {
    state: 'parked', pnl: 0.2, wins: 2, sequences: 1,
    bets: [{ spinIdx: 2, level: 0, outcome: 'loss', profit: -1, cat: 'loss' }],
  });

  const closed = plain(ctx.newTrack('fibonacci', 2, ctx.defaultFibCfg()));
  Object.assign(closed, {
    state: 'closed', closedAtSpin: 4, pnl: -30, level: 5,
    bets: [{ spinIdx: 4, level: 5, outcome: 'loss', profit: -16, cat: 'loss' }],
  });

  sess.tracks = [fib, sol, closed];
  return sess;
}

// The session record, without modified: a clear is a change, so modified moves and is tested on its own.
const SESSION_RECORD = [
  'id', 'name', 'created', 'roulette', 'bankroll', 'bankrollCurrent',
  'totalBuyIn', 'buyIns', 'totalCashOut', 'cashOuts', 'sessionStartedAt', 'sessionEndedAt',
];
const TRACK_MONEY = ['id', 'type', 'color', 'state', 'pnl'];
const TRACK_PROGRESS = ['bets', 'wins', 'sequences', 'level', 'createdAtSpin', 'closedAtSpin'];
// Solution bets carry a progression level, which a clear resets. Everything else in a config is kept.
const configKeptApartFromBetProgress = (cfg) => ({
  ...cfg,
  activeBets: cfg.activeBets && cfg.activeBets.map((b) => ({ number: b.number })),
});

test('clearSpins keeps every money field and the session record, and stamps modified', async () => {
  const { ctx } = await load();
  const before = liveSession(ctx);
  const after = plain(ctx.clearSpins(before, CLEAR_AT));
  assert.deepStrictEqual(pick(after, SESSION_RECORD), pick(before, SESSION_RECORD));
  assert.equal(after.modified, CLEAR_AT);
  assert.equal(after.tracks.length, before.tracks.length);
  after.tracks.forEach((t, i) => {
    const was = before.tracks[i];
    assert.deepStrictEqual(pick(t, TRACK_MONEY), pick(was, TRACK_MONEY));
    assert.deepStrictEqual(configKeptApartFromBetProgress(t.config), configKeptApartFromBetProgress(was.config));
  });
});

test('the load-time bankroll recompute lands on the same value before and after a clear', async () => {
  const { ctx, store } = await load();
  const key = vm.runInContext('STORAGE_KEY', ctx);
  // Runs the real loadApp, which recomputes bankrollCurrent from each track's pnl on the way in.
  const loadWith = (sess) => {
    store[key] = JSON.stringify({
      currentSession: sess,
      gameSession: plain(ctx.newSession()),
      savedSessions: [],
      settings: plain(ctx.defaultSettings()),
    });
    return plain(ctx.loadApp()).currentSession;
  };

  const before = liveSession(ctx);
  const after = plain(ctx.clearSpins(before, CLEAR_AT));
  assert.equal(before.bankrollCurrent, EXPECTED_BANKROLL, 'fixture agrees with the recompute');

  const loadedBefore = loadWith(before);
  const loadedAfter = loadWith(after);
  assert.equal(loadedBefore.bankrollCurrent, EXPECTED_BANKROLL);
  assert.equal(loadedAfter.bankrollCurrent, loadedBefore.bankrollCurrent);
  assert.deepStrictEqual(pick(loadedAfter, SESSION_RECORD), pick(loadedBefore, SESSION_RECORD));
  assert.equal(loadedAfter.spins.length, 0, 'the clear survives a reload');

  // CONTROL: zeroing track pnl changes the recompute, so the equality above depends on pnl surviving.
  const pnlZeroed = plain(after);
  pnlZeroed.tracks.forEach((t) => { t.pnl = 0; });
  assert.notEqual(loadWith(pnlZeroed).bankrollCurrent, EXPECTED_BANKROLL);
});

test('clearSpins empties the spins and resets what was derived from them', async () => {
  const { ctx } = await load();
  const before = liveSession(ctx);
  const after = plain(ctx.clearSpins(before, CLEAR_AT));
  assert.deepStrictEqual(after.spins, []);
  assert.deepStrictEqual(after.droughts, plain(ctx.initDroughts('american')));
  assert.notDeepStrictEqual(after.droughts, before.droughts);
  for (const t of after.tracks) {
    assert.deepStrictEqual(t.bets, []);
    assert.equal(t.wins, 0);
    assert.equal(t.sequences, 0);
    assert.equal(t.level, 0);
    assert.equal(t.createdAtSpin, 0);
    assert.equal(t.closedAtSpin, null);
  }
  // Solution numbers are kept; their progression restarts the way addSolBet creates a bet.
  assert.deepStrictEqual(after.tracks[1].config.activeBets, [
    { number: '17', level: 0, invest: 0 },
    { number: '5', level: 0, invest: 0 },
  ]);
  // Track pnl and state survive, because loadApp's recompute reads pnl.
  assert.deepStrictEqual(after.tracks.map((t) => t.pnl), before.tracks.map((t) => t.pnl));
  assert.deepStrictEqual(after.tracks.map((t) => t.state), ['active', 'parked', 'closed']);
});

test('clearSpins returns a new object and does not mutate its input', async () => {
  const { ctx } = await load();
  const before = liveSession(ctx);
  const snapshot = plain(before);
  const out = ctx.clearSpins(before, CLEAR_AT);
  assert.deepStrictEqual(plain(before), snapshot);
  assert.equal(before.spins.length, 6);
  assert.notEqual(out, before);
  assert.notEqual(out.tracks, before.tracks);
  assert.notEqual(out.tracks[0].config, before.tracks[0].config);
});

test('undo puts back exactly what the clear changed', async () => {
  const { ctx } = await load();
  const before = liveSession(ctx);
  const snap = plain(ctx.snapshotSpinState(before));
  const cleared = plain(ctx.clearSpins(before, CLEAR_AT));
  const restored = plain(ctx.restoreSpinState(cleared, snap, UNDO_AT));
  assert.deepStrictEqual(restored.spins, before.spins);
  assert.deepStrictEqual(restored.droughts, before.droughts);
  assert.deepStrictEqual(restored.tracks.map((t) => pick(t, TRACK_PROGRESS)), before.tracks.map((t) => pick(t, TRACK_PROGRESS)));
  assert.deepStrictEqual(restored.tracks.map((t) => t.config.activeBets), before.tracks.map((t) => t.config.activeBets));
  assert.deepStrictEqual(pick(restored, SESSION_RECORD), pick(before, SESSION_RECORD));
  assert.equal(restored.modified, UNDO_AT);
});

test('undo keeps money and tracks changed after the clear', async () => {
  const { ctx } = await load();
  const before = liveSession(ctx);
  const snap = plain(ctx.snapshotSpinState(before));
  const cleared = plain(ctx.clearSpins(before, CLEAR_AT));
  // Changes made after the clear and before Undo.
  cleared.buyIns.push({ amount: 50, at: CLEAR_AT + 1000, spin: 0 });
  cleared.totalBuyIn = 250;
  cleared.cashOuts.push({ amount: 20, at: CLEAR_AT + 2000, spin: 0 });
  cleared.totalCashOut = 70;
  cleared.bankrollCurrent = 610;
  cleared.tracks[0].state = 'parked';
  const added = plain(ctx.newTrack('fibonacci', 3, ctx.defaultFibCfg()));
  cleared.tracks.push(added);

  const restored = plain(ctx.restoreSpinState(cleared, snap, UNDO_AT));
  assert.deepStrictEqual(restored.spins, before.spins);
  assert.equal(restored.buyIns.length, 2);
  assert.equal(restored.totalBuyIn, 250);
  assert.equal(restored.cashOuts.length, 2);
  assert.equal(restored.totalCashOut, 70);
  assert.equal(restored.bankrollCurrent, 610);
  assert.equal(restored.tracks[0].state, 'parked');
  assert.deepStrictEqual(restored.tracks[3], added);
  assert.deepStrictEqual(restored.tracks.slice(0, 3).map((t) => t.pnl), before.tracks.map((t) => t.pnl));
  assert.equal(restored.modified, UNDO_AT);
});

test('CONTROL: restoring the whole pre-clear session would revert a buy-in made after the clear', async () => {
  const { ctx } = await load();
  const before = liveSession(ctx);
  const cleared = plain(ctx.clearSpins(before, CLEAR_AT));
  cleared.buyIns.push({ amount: 50, at: CLEAR_AT + 1000, spin: 0 });
  cleared.totalBuyIn = 250;
  // Arm one: put back the whole pre-clear session. Arm two: put back only what the clear changed.
  const wholeSession = plain(before);
  const scoped = plain(ctx.restoreSpinState(cleared, plain(ctx.snapshotSpinState(before)), UNDO_AT));
  assert.equal(wholeSession.totalBuyIn, 200, 'the whole-session arm loses the buy-in');
  assert.equal(scoped.totalBuyIn, 250, 'the scoped arm keeps the buy-in');
});

test('the Clear numbers row has the same reserved height and layout whatever its contents', async () => {
  const { ctx } = await load();
  const tags = [
    openingTag(await renderRow({ spinCount: 0 })),
    openingTag(await renderRow({ spinCount: 5 })),
    openingTag(await renderRow({ spinCount: 0, undoVisible: true })),
  ];
  assert.match(tags[0], new RegExp(`min-height:${ctx.SPIN_TOOLS_ROW_HEIGHT}px`));
  assert.equal(tags[0], tags[1]);
  assert.equal(tags[0], tags[2]);
});

test('Clear numbers is disabled with no numbers and available with some', async () => {
  const empty = await renderRow({ spinCount: 0 });
  const filled = await renderRow({ spinCount: 5 });
  assert.match(empty, /<button[^>]*disabled=""[^>]*>\s*Clear numbers\s*<\/button>/);
  assert.doesNotMatch(filled, /disabled=""/);
});

test('in the undo state Numbers cleared · Undo takes the Clear slot inline, with no overlay', async () => {
  const html = await renderRow({ spinCount: 0, undoVisible: true });
  const clear = html.match(/<button[^>]*>\s*Clear numbers\s*<\/button>/)[0];
  assert.match(clear, /visibility:hidden/);
  assert.match(clear, /aria-hidden="true"/);
  const status = html.match(/<div role="status"[^>]*>/)[0];
  assert.match(status, /visibility:visible/);
  assert.match(status, /aria-hidden="false"/);
  assert.match(html, />Numbers cleared</);
  assert.match(html, /<button[^>]*>Undo<\/button>/);
  assert.doesNotMatch(html, /position:fixed/);
});

test('with no undo offered the notice is hidden in its slot, not removed, and Clear numbers shows', async () => {
  const html = await renderRow({ spinCount: 5 });
  const clear = html.match(/<button[^>]*>\s*Clear numbers\s*<\/button>/)[0];
  assert.match(clear, /visibility:visible/);
  assert.match(clear, /aria-hidden="false"/);
  const status = html.match(/<div role="status"[^>]*>/)[0];
  assert.match(status, /visibility:hidden/);
  assert.match(status, /aria-hidden="true"/);
  assert.doesNotMatch(html, /position:fixed/);
});

test('the confirm is closed by default and opens the shared Modal with the spin count', async () => {
  const closed = await renderRow({ spinCount: 5 });
  assert.doesNotMatch(closed, /Clear numbers\?/);
  const asking = await renderRow({ spinCount: 5, confirmOpen: true });
  assert.match(asking, /position:fixed/);
  assert.match(asking, /Clear numbers\?/);
  assert.match(asking, /Removes the 5 spins from this session/);
  assert.match(asking, /Bankroll, buy-ins, cash-outs and track profit and loss are not changed/);
  assert.match(asking, />Cancel</);
  const single = await renderRow({ spinCount: 1, confirmOpen: true });
  assert.match(single, /Removes the 1 spin from this session/);
});

test('the recent-numbers strip keeps the same reserved height with no numbers and with some', async () => {
  const { ctx } = await load();
  const tags = [];
  const chips = [];
  for (const n of [0, 5, 30, 31]) {
    const html = await renderStrip(SPINS(n));
    tags.push(openingTag(html));
    chips.push((html.match(/border:2px solid/g) || []).length);
  }
  assert.match(tags[0], new RegExp(`min-height:${ctx.RECENT_STRIP_MIN_HEIGHT}px`));
  assert.ok(tags.every((t) => t === tags[0]), 'the container tag is identical at 0, 5, 30 and 31 spins');
  assert.deepStrictEqual(chips, [0, 5, 30, 30], 'the strip shows at most thirty numbers');
});

test('App mounts the strip and the drought slot unconditionally, with the clear wiring in place', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.equal(app.split('<RecentNumbersStrip spins={sess.spins} trackOverlays={trackOverlays}/>').length - 1, 1);
  assert.doesNotMatch(app, /recentSpins/);
  assert.match(app, /<div aria-hidden=\{sess\.spins\.length===0\} style=\{\{minHeight:DROUGHT_PANEL_HEIGHT,visibility:sess\.spins\.length>0\?"visible":"hidden"\}\}>/);
  assert.doesNotMatch(app, /sess\.spins\.length>0 && \(\s*<DroughtPanel/);
  assert.match(app, /<SpinTools spinCount=\{sess\.spins\.length\}/);
});

test('the clear and undo handlers never open a native dialog', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  const start = app.indexOf('  function clearNumbers() {');
  const end = app.indexOf('  function reactivateTrack(id) {');
  assert.ok(start > 0 && end > start, 'clear handlers sit between undoLastSpin and reactivateTrack');
  assert.doesNotMatch(app.slice(start, end), /\b(confirm|alert|prompt)\s*\(/);
});

test('SpinTools.jsx draws no overlay of its own and never calls a native dialog', async () => {
  const source = await readFile(new URL('components/SpinTools.jsx', SRC), 'utf8');
  assert.doesNotMatch(source, /position:\s*"fixed"/);
  assert.doesNotMatch(source, /\bconfirm\s*\(/);
  assert.match(source, /<Modal onClose=\{onCancel\}>/);
});

test('SpinTools is built after the modals it uses and before App', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('components/SpinTools.jsx') > at('components/ui.jsx'));
  assert.ok(at('components/SpinTools.jsx') > at('components/modals.jsx'));
  assert.ok(at('App.jsx') > at('components/SpinTools.jsx'));
});
