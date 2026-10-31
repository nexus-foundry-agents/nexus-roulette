import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// Venue data (F11): the shape, the migration of sessions saved before venues, dealer changes, the value lists, the
// spin counts, and the export and import round trip. The real source is transpiled and run in one sandbox, in the
// order build.js concatenates it. Nothing is copied from source.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));

const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'components/session-files.jsx',
  'components/onboarding-apply.jsx',
];

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
  const captured = { blobs: [], downloads: [], inputs: [], alerts: [] };
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
    Blob: class { constructor(parts) { this.text = parts.join(''); captured.blobs.push(this); } },
    URL: { createObjectURL: () => `blob:test/${captured.blobs.length}`, revokeObjectURL() {} },
    document: {
      createElement(tag) {
        const el = { tagName: tag };
        el.click = () => { if (tag === 'a') captured.downloads.push(el); };
        if (tag === 'input') captured.inputs.push(el);
        return el;
      },
      body: { appendChild() {}, removeChild() {} },
    },
    alert: () => { throw new Error('a native browser dialog was opened'); },
    FileReader: class { readAsText(file) { this.onload({ target: { result: file.text } }); } },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'venue-slice.js' });
  return { ctx: sandbox, store, captured };
}

const run = (ctx, expr) => vm.runInContext(expr, ctx);

function legacySession(extra = {}) {
  return {
    id: 'legacy-1', name: 'Session 1', created: 1000, modified: 2000, roulette: 'american',
    bankroll: 500, bankrollCurrent: 500, totalBuyIn: 0, buyIns: [], spins: ['7', '0', '12'],
    droughts: {}, tracks: [], totalCashOut: 0, cashOuts: [], sessionStartedAt: null, sessionEndedAt: null,
    ...extra,
  };
}

function spinsOf(n) { return Array.from({ length: n }, (_, i) => String(i % 36 + 1)); }

test('a venue keeps only the fields its kind carries, trimmed; nothing recorded is no venue', async () => {
  const { ctx } = await loadSlice();
  assert.deepEqual(
    plain(ctx.normalizeVenue({ casino: ' Casino One ', kind: 'machine', maker: 'Maker One', model: '  Mark VII ', version: '', table: '9', dealer: 'Ann' })),
    { casino: 'Casino One', kind: 'machine', maker: 'Maker One', model: 'Mark VII' },
  );
  assert.deepEqual(
    plain(ctx.normalizeVenue({ kind: 'table', table: '3', dealer: 'Ann', maker: 'X' })),
    { kind: 'table', table: '3', dealer: 'Ann' },
  );
  assert.equal(ctx.normalizeVenue({ casino: '   ' }), null);
  assert.equal(ctx.normalizeVenue(null), null);
  assert.equal(ctx.normalizeVenue('Casino One'), null);
  assert.equal(ctx.normalizeVenue([]), null);
});

test('migration: a session saved before venues comes back exactly as it was, with no venue keys added', async () => {
  const { ctx } = await loadSlice();
  const old = legacySession();
  const before = plain(old);
  ctx.migrateSessionVenue(old);
  assert.deepEqual(plain(old), before);
  assert.equal('venue' in old, false);
  assert.equal('dealerChanges' in old, false);
});

test('migration on load: old saved sessions are untouched; malformed venue and dealer entries are dropped or sorted', async () => {
  const { ctx, store } = await loadSlice();
  const key = run(ctx, 'STORAGE_KEY');
  const old = legacySession();
  const withVenue = legacySession({
    id: 'v-1', venue: { casino: 'Casino One', kind: 'table', table: '3', dealer: 'Ann' },
    dealerChanges: [{ fromSpin: 2, dealer: 'Bo' }, { fromSpin: 0, dealer: 'Ann' }, { fromSpin: 'x', dealer: 'Z' }],
  });
  const malformed = legacySession({ id: 'm-1', venue: 'Casino One' });
  store[key] = JSON.stringify({
    savedSessions: [old, withVenue, malformed],
    currentSession: legacySession({ id: 'cur', spins: [] }),
    gameSession: legacySession({ id: 'game', spins: [] }),
    settings: { onboarded: true, currency: 'USD', defaultBuyIn: 100 },
  });
  const loaded = plain(ctx.loadApp());
  assert.deepEqual(loaded.savedSessions[0], plain(old));
  assert.equal('venue' in loaded.savedSessions[0], false);
  assert.equal('venue' in loaded.currentSession, false);
  assert.deepEqual(loaded.savedSessions[1].venue, { casino: 'Casino One', kind: 'table', table: '3', dealer: 'Ann' });
  assert.deepEqual(loaded.savedSessions[1].dealerChanges, [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 2, dealer: 'Bo' }]);
  assert.equal(loaded.savedSessions[2].venue, null);
});

test('a dealer is recorded from spin 0 at the start, and a later change starts at the spin it begins from', async () => {
  const { ctx } = await loadSlice();
  const start = legacySession({ spins: [] });
  const before = plain(start);
  const atStart = plain(ctx.withVenue(start, { kind: 'table', table: '3', dealer: 'Ann' }, 0));
  assert.deepEqual(plain(start), before, 'the input is not mutated');
  assert.deepEqual(atStart.dealerChanges, [{ fromSpin: 0, dealer: 'Ann' }]);
  assert.equal(atStart.venue.dealer, 'Ann');

  const live = { ...atStart, spins: spinsOf(5) };
  const changed = plain(ctx.withVenue(live, { kind: 'table', table: '3', dealer: 'Bo' }, 5));
  assert.deepEqual(changed.dealerChanges, [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 5, dealer: 'Bo' }]);
  assert.equal(changed.venue.dealer, 'Bo');

  const relabelled = plain(ctx.withVenue(changed, { kind: 'table', table: '4', dealer: 'Bo' }, 5));
  assert.equal(relabelled.dealerChanges.length, 2, 'a table relabel with the same dealer records no change');

  const cleared = plain(ctx.withVenue(changed, { kind: 'table', table: '3' }, 5));
  assert.deepEqual(cleared.dealerChanges, [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 5, dealer: null }]);
  assert.equal('dealer' in cleared.venue, false);
});

test('a machine venue leaves the dealer history alone, and an ended session keeps a later dealer change as recorded', async () => {
  const { ctx } = await loadSlice();
  const base = legacySession({ spins: spinsOf(4), dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }] });
  const machine = plain(ctx.withVenue(base, { kind: 'machine', maker: 'Maker One', model: 'Mark VII', version: '2' }, 4));
  assert.deepEqual(machine.dealerChanges, [{ fromSpin: 0, dealer: 'Ann' }]);
  assert.equal('dealer' in machine.venue, false);

  const ended = legacySession({
    sessionEndedAt: 9000, spins: spinsOf(9), venue: { kind: 'table', table: '3', dealer: 'Bo' },
    dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 4, dealer: 'Bo' }],
  });
  assert.equal(ctx.dealerLocked(ended), true);
  const lockedEdit = plain(ctx.withVenue(ended, { kind: 'table', table: '3', dealer: 'Cy' }, 9));
  assert.deepEqual(lockedEdit.dealerChanges, [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 4, dealer: 'Bo' }]);
  assert.equal(lockedEdit.venue.dealer, 'Bo');

  const endedOnly = legacySession({ sessionEndedAt: 9000, spins: spinsOf(3), dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }] });
  assert.equal(ctx.dealerLocked(endedOnly), false);
  const replaced = plain(ctx.withVenue(endedOnly, { kind: 'table', table: '3', dealer: 'Cy' }, 3));
  assert.deepEqual(replaced.dealerChanges, [{ fromSpin: 0, dealer: 'Cy' }]);
});

test('dealer segments split a table session at its changes, and a change past the last spin is ignored', async () => {
  const { ctx } = await loadSlice();
  const s = legacySession({ spins: spinsOf(10), dealerChanges: [{ fromSpin: 0, dealer: 'A' }, { fromSpin: 4, dealer: 'B' }] });
  assert.deepEqual(plain(ctx.dealerSegments(s, 10)), [{ from: 0, to: 4, dealer: 'A' }, { from: 4, to: 10, dealer: 'B' }]);
  assert.equal(ctx.dealerAtSpin(s, 3), 'A');
  assert.equal(ctx.dealerAtSpin(s, 4), 'B');
  const late = legacySession({ spins: spinsOf(3), dealerChanges: [{ fromSpin: 3, dealer: 'B' }] });
  assert.deepEqual(plain(ctx.dealerSegments(late, 3)), [{ from: 0, to: 3, dealer: null }], 'a change after the last spin leaves the spins before it with no dealer');
  const lead = legacySession({ spins: spinsOf(6), dealerChanges: [{ fromSpin: 3, dealer: 'B' }] });
  assert.deepEqual(plain(ctx.dealerSegments(lead, 6)), [{ from: 0, to: 3, dealer: null }, { from: 3, to: 6, dealer: 'B' }]);
  assert.deepEqual(plain(ctx.dealerSegments(legacySession({ spins: [] }), 0)), []);
});

test('clearing the numbers restarts the dealer record at spin 0, and Undo puts the record back', async () => {
  const { ctx } = await loadSlice();
  const s = legacySession({ spins: spinsOf(6), dealerChanges: [{ fromSpin: 0, dealer: 'A' }, { fromSpin: 4, dealer: 'B' }], venue: { kind: 'table', table: '3', dealer: 'B' }, bankrollCurrent: 480 });
  const snap = ctx.snapshotSpinState(s);
  const cleared = plain(ctx.clearSpins(s, 5000));
  assert.deepEqual(cleared.spins, []);
  assert.deepEqual(cleared.dealerChanges, [{ fromSpin: 0, dealer: 'B' }]);
  assert.equal(cleared.bankrollCurrent, 480, 'money is not touched by a clear');
  const restored = plain(ctx.restoreSpinState(cleared, snap, 6000));
  assert.deepEqual(restored.dealerChanges, [{ fromSpin: 0, dealer: 'A' }, { fromSpin: 4, dealer: 'B' }]);
  assert.equal(restored.spins.length, 6);

  const plainSession = legacySession({ spins: spinsOf(2) });
  const plainCleared = plain(ctx.clearSpins(plainSession, 7000));
  assert.equal('dealerChanges' in plainCleared, false, 'a session with no dealer record gains none on clear');
  const plainSnap = ctx.snapshotSpinState(plainSession);
  const plainRestored = plain(ctx.restoreSpinState(plainCleared, plainSnap, 8000));
  assert.equal('dealerChanges' in plainRestored, false);
});

test('value lists: most recent first, each value once (case-insensitive, latest spelling), with entries typed by hand', async () => {
  const { ctx } = await loadSlice();
  const sessions = [
    { modified: 100, created: 1, venue: { casino: 'Casino One', kind: 'machine', maker: 'Maker One' } },
    { modified: 300, created: 1, venue: { casino: 'casino one', kind: 'table', table: '3', dealer: 'Ann' }, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 4, dealer: 'Bo' }] },
    { modified: 0, created: 50, venue: null },
  ];
  const entries = [{ field: 'casino', value: 'Casino Two', at: 200 }, { field: 'dealer', value: 'Cy', at: 500 }];
  assert.deepEqual(plain(ctx.venueOptions('casino', sessions, entries)), ['casino one', 'Casino Two']);
  assert.deepEqual(plain(ctx.venueOptions('dealer', sessions, entries)), ['Cy', 'Ann', 'Bo']);
  assert.deepEqual(plain(ctx.venueOptions('maker', sessions, entries)), ['Maker One']);
  assert.deepEqual(plain(ctx.venueOptions('table', sessions, entries)), ['3']);
  assert.deepEqual(plain(ctx.venueChoiceList(['casino one', 'Casino Two'], 'Casino Two')), ['casino one']);
  assert.deepEqual(plain(ctx.venueChoiceList(['casino one', 'Casino Two'], null)), ['casino one', 'Casino Two']);
});

test('a value typed by hand is stored once per field, the newest spelling kept, and an unknown field is refused', async () => {
  const { ctx } = await loadSlice();
  const first = plain(ctx.addVenueEntries([], [{ field: 'casino', value: 'Casino Two ' }], 10));
  assert.deepEqual(first, [{ field: 'casino', value: 'Casino Two', at: 10 }]);
  const again = plain(ctx.addVenueEntries(first, [{ field: 'casino', value: 'casino two' }], 20));
  assert.deepEqual(again, [{ field: 'casino', value: 'casino two', at: 20 }]);
  assert.deepEqual(plain(ctx.addVenueEntries([], [{ field: 'secret', value: 'x' }], 1)), []);
  assert.deepEqual(plain(ctx.addVenueEntries([], [{ field: 'casino', value: '   ' }], 1)), []);
});

test('spins logged by venue: counts per casino, machine, and table and dealer, reconciled with the total', async () => {
  const { ctx } = await loadSlice();
  const sessions = [
    legacySession({ spins: spinsOf(4), venue: { casino: 'Casino One', kind: 'machine', maker: 'Maker One', model: 'Model One', version: '2' } }),
    legacySession({ spins: spinsOf(10), venue: { casino: 'Casino One', kind: 'table', table: '3', dealer: 'Ann' }, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 4, dealer: 'Bo' }] }),
    legacySession({ spins: spinsOf(3) }),
    legacySession({ spins: spinsOf(2), venue: { kind: 'machine', maker: 'Maker One', model: 'Model One', version: '2' } }),
  ];
  const counts = plain(ctx.venueSpinCounts(sessions));
  assert.equal(counts.total, 19);
  assert.equal(counts.noVenue, 3);
  assert.deepEqual(plain(ctx.venueCountRows(counts.casino)), [{ label: 'Casino One', count: 14 }, { label: 'No casino name', count: 2 }]);
  assert.deepEqual(plain(ctx.venueCountRows(counts.machine)), [{ label: 'Maker One Model One 2', count: 6 }]);
  assert.deepEqual(plain(ctx.venueCountRows(counts.table)), [{ label: '3 · Bo', count: 6 }, { label: '3 · Ann', count: 4 }]);
  const casinoTotal = Object.values(counts.casino).reduce((a, b) => a + b, 0);
  assert.equal(casinoTotal + counts.noVenue, counts.total, 'every spin is in a casino row or the no-venue line');
});

test('the start step opens once, when a Live session first starts with no venue; never on load, in Game mode, or once a venue is set', async () => {
  const { ctx } = await loadSlice();
  const idle = legacySession({ id: 'a', spins: [] });
  const running = { ...idle, sessionStartedAt: 5000 };
  assert.equal(ctx.venueStartOpens(null, running, 'live'), false, 'a session already running on load does not prompt');
  assert.equal(ctx.venueStartOpens({ id: 'a', started: false }, running, 'live'), true, 'the first spin of a Live session opens the step');
  assert.equal(ctx.venueStartOpens({ id: 'a', started: true }, running, 'live'), false, 'a started session does not reopen it');
  assert.equal(ctx.venueStartOpens({ id: 'a', started: false }, running, 'game'), false, 'Game mode never opens it');
  assert.equal(ctx.venueStartOpens({ id: 'a', started: false }, { ...running, venue: { casino: 'Casino One' } }, 'live'), false, 'a session with a venue does not prompt');
  assert.equal(ctx.venueStartOpens({ id: 'a', started: false }, idle, 'live'), false, 'a session that has not started does not prompt');
});

test('Confirm venue is asked first only for a Live session with no venue', async () => {
  const { ctx } = await loadSlice();
  assert.equal(ctx.venueEndAsksFirst('live', legacySession({ spins: [] })), true);
  assert.equal(ctx.venueEndAsksFirst('live', legacySession({ venue: { casino: 'Casino One' } })), false);
  assert.equal(ctx.venueEndAsksFirst('game', legacySession({})), false);
});

test('the venue line reads casino, machine or table and dealer, and is empty with no venue', async () => {
  const { ctx } = await loadSlice();
  assert.equal(ctx.venueLine({ casino: 'Casino One', kind: 'table', table: '3', dealer: 'Ann' }), 'Casino One · 3 · Dealer Ann');
  assert.equal(ctx.venueLine({ casino: 'Casino One', kind: 'machine', maker: 'Maker One', model: 'Model One', version: '2' }), 'Casino One · Maker One Model One 2');
  assert.equal(ctx.venueLine(null), '');
});

test('export and import carry the venue and the dealer changes unchanged; a session without a venue is exported as before', async () => {
  const { ctx, captured } = await loadSlice();
  const venued = legacySession({
    id: 'v-1', name: 'Table night', spins: spinsOf(5), venue: { casino: 'Casino One', kind: 'table', table: '3', dealer: 'Bo' },
    dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 3, dealer: 'Bo' }],
  });
  const plainOne = legacySession({ id: 'p-1', name: 'Plain' });
  ctx.exportSessionsJSON([plainOne, venued]);
  const exported = JSON.parse(captured.blobs[captured.blobs.length - 1].text);
  assert.equal('venue' in exported.sessions[0], false, 'a session with no venue has no venue key in the export');
  assert.deepEqual(exported.sessions[1].venue, venued.venue);
  assert.deepEqual(exported.sessions[1].dealerChanges, venued.dealerChanges);
  assert.ok(exported.sessions[1].metrics, 'metrics are still added');

  const state = { savedSessions: [], currentSession: legacySession({ id: 'cur', spins: [] }), gameSession: legacySession({ id: 'g', spins: [] }), settings: {} };
  const notices = [];
  ctx.pickSessionsFile((fn) => fn(state), () => {}, (opts) => { notices.push(opts); return Promise.resolve(true); });
  const input = captured.inputs[captured.inputs.length - 1];
  input.onchange({ target: { files: [{ text: captured.blobs[captured.blobs.length - 1].text }] } });
  const imported = plain(state.savedSessions);
  assert.equal('venue' in imported[0], false);
  assert.deepEqual(imported[1].venue, venued.venue);
  assert.deepEqual(imported[1].dealerChanges, venued.dealerChanges);
  assert.deepEqual(plain(state.currentSession.venue), venued.venue, 'the last imported session becomes the current one, venue included');
  const done = notices[notices.length - 1];
  assert.equal(done.title, 'Import complete!', 'the import reports through the in-app dialog');
  assert.equal(done.notice, true, 'the report is a notice: one OK button, no Cancel');
  assert.match(done.body, /2 sessions added/);

  // A file that does not parse reports through the same dialog, never alert().
  input.onchange({ target: { files: [{ text: '{not json' }] } });
  assert.equal(notices[notices.length - 1].title, 'Failed to parse file');
  assert.equal(notices[notices.length - 1].notice, true);
});

test('no odds or house-edge commentary in the venue code', async () => {
  const session = await readFile(new URL('../nexus-src/src/session.js', import.meta.url), 'utf8');
  const picker = await readFile(new URL('../nexus-src/src/components/VenuePicker.jsx', import.meta.url), 'utf8');
  const sheet = await readFile(new URL('../nexus-src/src/components/SecondaryPages.jsx', import.meta.url), 'utf8');
  for (const [name, text] of [['session.js', session], ['VenuePicker.jsx', picker], ['SecondaryPages.jsx', sheet]]) {
    assert.doesNotMatch(text, /house[ -]edge|\bodds\b|expected value|expected return/i, name);
  }
});
