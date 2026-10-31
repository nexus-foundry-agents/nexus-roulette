import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// F13, the sessions browser: the pure grouping, filters and bulk entry (sessions-browse.js), the resume, label and
// unsaved-spin helpers (session.js), the rename's sync (casino-sync.mjs), and the sheet's markup (SessionsPage.jsx).
// The real source is transpiled and run in one sandbox, in the order build.js concatenates it. Nothing is copied from source.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const ROOT = new URL('../', import.meta.url);
const LOGIC = ['constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'sessions-browse.js', 'casino-sync.mjs'];
const SHEET = ['constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'sessions-browse.js',
  'components/ui.jsx', 'components/BoardPhoto.jsx', 'components/SessionsPage.jsx'];

async function load(files, reactImpl = React) {
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n');
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
    React: reactImpl,
    ReactDOMServer,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return reactImpl;
      if (name === 'react-dom/server') return ReactDOMServer;
      throw new Error(`unexpected module in the bundle: ${name}`);
    },
    setTimeout: () => 0,
    clearTimeout() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options && options.detail; } },
    navigator: {},
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  sandbox.window.location = { search: '', pathname: '/' };
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.window.dispatchEvent = () => true;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'session-browser-bundle.js' });
  return {
    // JSON round trip, so results from the sandbox realm compare as plain data.
    get(expr, vars) { sandbox.vars = vars || {}; return JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, sandbox)); },
    raw(expr, vars) { sandbox.vars = vars || {}; return vm.runInContext(expr, sandbox); },
  };
}

// Local time, month index from zero (9 is October). The browser reads local time, so the tests do too.
const T = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
const NOW = T(2026, 9, 31, 15, 0); // Saturday 31 October 2026, 15:00
const LATER = T(2026, 9, 31, 16, 0); // a change made after every fixture was saved, so its stamp wins a sync merge

function session(over = {}) {
  return {
    id: 's1', name: 'Session 10/31/2026', created: T(2026, 9, 31, 8), modified: T(2026, 9, 31, 9),
    roulette: 'american', bankroll: 500, bankrollCurrent: 500, totalBuyIn: 0, buyIns: [],
    spins: [], droughts: {}, tracks: [], totalCashOut: 0, cashOuts: [],
    sessionStartedAt: T(2026, 9, 31, 8), sessionEndedAt: null, mode: 'live',
    ...over,
  };
}
const plain = (v) => JSON.parse(JSON.stringify(v));

const machineHarbor = { kind: 'machine', casino: 'Harbor', maker: 'IGT', model: 'Game King', version: 'v2' };
const tableRiverside = { kind: 'table', casino: 'Riverside', table: '3', dealer: 'Ann' };

// -- Grouping and sorting --

test('dayGroups: newest first, grouped Today, Yesterday, then the date; newest first within a day', async () => {
  const b = await load(LOGIC);
  const sessions = [
    session({ id: 'b', sessionStartedAt: T(2026, 9, 31, 8) }),
    session({ id: 'd', sessionStartedAt: T(2026, 9, 28, 10) }),
    session({ id: 'a', sessionStartedAt: T(2026, 9, 31, 9) }),
    session({ id: 'c', sessionStartedAt: T(2026, 9, 30, 20) }),
  ];
  const groups = b.get('dayGroups(vars.list, vars.now)', { list: sessions, now: NOW });
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday', new Date(T(2026, 9, 28)).toLocaleDateString()]);
  assert.deepEqual(groups.map((g) => g.sessions.map((s) => s.id)), [['a', 'b'], ['c'], ['d']]);
});

test('dayGroups: a session never started sorts by its creation time', async () => {
  const b = await load(LOGIC);
  const sessions = [
    session({ id: 'a', sessionStartedAt: T(2026, 9, 31, 9) }),
    session({ id: 'e', sessionStartedAt: null, created: T(2026, 9, 31, 10) }),
  ];
  const groups = b.get('dayGroups(vars.list, vars.now)', { list: sessions, now: NOW });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['e', 'a']);
});

// -- Filter values and the filters --

test('filterOptions: each list holds only values the sessions hold, and casino and dealer follow F11', async () => {
  const b = await load(LOGIC);
  const sessions = [
    session({ id: 's1', venue: machineHarbor }),
    session({ id: 's2', venue: tableRiverside, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 5, dealer: 'Bo' }] }),
    session({ id: 's3' }),
    session({ id: 's4', venue: { kind: 'machine', casino: 'harbor' } }),
  ];
  const options = b.get('filterOptions(vars.list)', { list: sessions });
  assert.deepEqual(options.casino.map((x) => x.toLowerCase()).sort(), ['harbor', 'riverside']);
  assert.deepEqual(options.place.slice().sort(), ['3', 'IGT Game King v2'], 'a machine with no details names no place');
  assert.deepEqual(options.dealer.slice().sort(), ['Ann', 'Bo'], 'a dealer recorded mid-session is offered');
  const none = b.get('filterOptions(vars.list)', { list: [session({ id: 'x' })] });
  assert.deepEqual(none, { casino: [], place: [], dealer: [] }, 'no venues, no choices');
});

test('each filter: casino, machine or table, dealer, and this week or all', async () => {
  const b = await load(LOGIC);
  const sessions = [
    session({ id: 'harbor', venue: machineHarbor, sessionStartedAt: T(2026, 9, 31, 8) }),
    session({ id: 'river', venue: tableRiverside, sessionStartedAt: T(2026, 9, 26, 0, 30),
      dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 5, dealer: 'Bo' }] }),
    session({ id: 'old', venue: tableRiverside, sessionStartedAt: T(2026, 9, 25, 23, 59) }),
  ];
  const ids = (filters) => b.get('filterSessions(vars.list, vars.f, vars.now).map(s => s.id)', { list: sessions, f: filters, now: NOW });
  assert.deepEqual(ids({ casino: null, place: null, dealer: null, period: 'all' }), ['harbor', 'river', 'old']);
  assert.deepEqual(ids({ casino: 'riverside', place: null, dealer: null, period: 'all' }), ['river', 'old'], 'casino is case-insensitive');
  assert.deepEqual(ids({ casino: null, place: 'IGT Game King v2', dealer: null, period: 'all' }), ['harbor']);
  assert.deepEqual(ids({ casino: null, place: '3', dealer: null, period: 'all' }), ['river', 'old']);
  assert.deepEqual(ids({ casino: null, place: null, dealer: 'Bo', period: 'all' }), ['river'], 'a dealer from a mid-session change matches');
  assert.deepEqual(ids({ casino: null, place: null, dealer: null, period: 'week' }), ['harbor', 'river'], 'this week starts Monday 00:00');
  assert.deepEqual(ids({ casino: 'Riverside', place: null, dealer: 'Ann', period: 'week' }), ['river'], 'filters combine');
});

test('thisWeekStart is Monday 00:00 local, so a session on Sunday 23:59 falls in the week before', async () => {
  const b = await load(LOGIC);
  assert.equal(b.get('thisWeekStart(vars.now)', { now: NOW }), T(2026, 9, 26));
  assert.equal(b.get('thisWeekStart(vars.now)', { now: T(2026, 9, 25, 12) }), T(2026, 9, 19), 'a Sunday belongs to the week that began the Monday before');
});

// -- Row facts --

test('sessionRow: "No venue", a dash for a never-started session, and the duration, spins and P&L of a saved one', async () => {
  const b = await load(LOGIC);
  const bare = b.get('sessionRow(vars.s)', { s: session({ id: 'x', sessionStartedAt: null }) });
  assert.equal(bare.venue, 'No venue');
  assert.equal(bare.hasVenue, false);
  assert.equal(bare.duration, '—');
  const ended = session({
    id: 'y', venue: tableRiverside, spins: ['1', '2', '3'], bankroll: 500, bankrollCurrent: 540,
    sessionStartedAt: T(2026, 9, 31, 8), sessionEndedAt: T(2026, 9, 31, 10, 30),
  });
  const row = b.get('sessionRow(vars.s)', { s: ended });
  assert.equal(row.venue, 'Riverside · 3 · Dealer Ann', 'the venue line F11 writes');
  assert.equal(row.spins, 3);
  assert.equal(row.pnl, 40);
  assert.equal(row.duration, b.raw('formatElapsed(' + (2.5 * 3600000) + ')'));
  assert.equal(row.title, 'Session 10/31/2026', 'the title is the name when there is no label');
  assert.equal(b.get('sessionRow(vars.s)', { s: session({ label: 'Harbor night' }) }).title, 'Harbor night');
});

// -- Bulk entry --

test('parseBulkNumbers: spaces or commas, oldest first, repeats kept as separate spins', async () => {
  const b = await load(LOGIC);
  const parse = (text, wheel = 'american', max = 40) => b.get('parseBulkNumbers(vars.t, vars.w, vars.m)', { t: text, w: wheel, m: max });
  assert.deepEqual(parse('2 2 2 24 4').numbers, ['2', '2', '2', '24', '4']);
  assert.deepEqual(parse('2,2,2,24,4').numbers, ['2', '2', '2', '24', '4']);
  assert.deepEqual(parse('2, 2 ,2,\t24 ,4').numbers, ['2', '2', '2', '24', '4'], 'mixed separators');
  assert.equal(parse('2 2 2').numbers.length, 3, 'a repeat is three spins, not one');
  assert.deepEqual(parse('00 0').numbers, ['00', '0'], '00 is legal on the American wheel');
});

test('parseBulkNumbers: a bad token rejects the whole entry and is named', async () => {
  const b = await load(LOGIC);
  const bad = b.get('parseBulkNumbers(vars.t, vars.w, vars.m)', { t: '2 35x 4', w: 'american', m: 40 });
  assert.equal(bad.ok, false);
  assert.equal(bad.bad, '35x');
  assert.match(bad.message, /"35x"/);
  assert.equal(bad.numbers, undefined, 'nothing from a rejected entry is kept');
  assert.equal(b.get('parseBulkNumbers(vars.t, vars.w, vars.m)', { t: '02 4', w: 'american', m: 40 }).bad, '02', 'only canonical numbers');
});

test('parseBulkNumbers: 00 is rejected on the European wheel and names the token', async () => {
  const b = await load(LOGIC);
  const euro = b.get('parseBulkNumbers(vars.t, vars.w, vars.m)', { t: '2 00', w: 'european', m: 40 });
  assert.equal(euro.ok, false);
  assert.equal(euro.bad, '00');
  assert.match(euro.message, /European/);
});

test('parseBulkNumbers: an empty entry says so, and the limit is enforced in numbers', async () => {
  const b = await load(LOGIC);
  assert.equal(b.get('parseBulkNumbers(vars.t, vars.w, vars.m)', { t: '  ,  ', w: 'american', m: 40 }).empty, true);
  const over = b.get('parseBulkNumbers(vars.t, vars.w, vars.m)', { t: '1 2 3 4', w: 'american', m: 3 });
  assert.equal(over.ok, false);
  assert.match(over.message, /at most 3/);
});

// -- Resume --

function resumeFixture() {
  const track = { id: 't1', type: 'fibonacci', color: '#f00', state: 'active', config: { unit: 1, roi: 15 }, level: 2, pnl: 4, bets: [{ level: 2 }], createdAtSpin: 0, closedAtSpin: null, wins: 1, sequences: 1 };
  const savedA = session({ id: 'a', mode: 'live', spins: ['5', '6', '7'], tracks: [track], venue: tableRiverside, droughts: { '5': 0 }, modified: T(2026, 9, 30, 21) });
  const savedG = session({ id: 'g', mode: 'game', spins: ['1'], tracks: [], modified: T(2026, 9, 29, 21) });
  const current = session({ id: 'cur', spins: ['1', '2'], tracks: [track], modified: T(2026, 9, 31, 14) });
  return {
    savedA, savedG,
    state: { savedSessions: [savedA, savedG], currentSession: current, gameSession: session({ id: 'gcur', mode: 'game', spins: [] }), settings: {} },
  };
}

test('resumeSavedSession: the saved session becomes current exactly as saved, and the unsaved current is saved first', async () => {
  const b = await load(LOGIC);
  const { state, savedA } = resumeFixture();
  const before = JSON.stringify(state);
  const next = b.get('resumeSavedSession(vars.state, "a", "live", vars.now)', { state, now: LATER });
  assert.deepEqual(next.currentSession, plain(savedA), 'tracks, levels, bets, droughts and venue as saved');
  const cur = next.savedSessions.find((x) => x.id === 'cur');
  assert.ok(cur, 'the previous current session is now saved');
  assert.equal(cur.spins.length, 2, 'its spins are kept');
  assert.equal(cur.modified, LATER);
  assert.equal(cur.mode, 'live');
  assert.equal(typeof cur.metrics.netPnL, 'number');
  assert.equal(next.savedSessions.length, 3);
  assert.deepEqual(next.savedSessions.find((x) => x.id === 'a'), plain(savedA), 'the saved copy is unchanged');
  assert.equal(JSON.stringify(state), before, 'the input state is not mutated');
});

test('resumeSavedSession: a Game session resumes into gameSession and keeps the Live session', async () => {
  const b = await load(LOGIC);
  const { state, savedG } = resumeFixture();
  const next = b.get('resumeSavedSession(vars.state, "g", "live", vars.now)', { state, now: LATER });
  assert.deepEqual(next.gameSession, plain(savedG));
  assert.equal(b.get('savedSessionMode(vars.s)', { s: savedG }), 'game');
  assert.equal(b.get('savedSessionMode(vars.s)', { s: session({ mode: undefined }) }), 'live', 'a session saved before modes is Live');
});

test('resumeSavedSession: nothing to save means nothing is added; the same id or an unknown id changes nothing', async () => {
  const b = await load(LOGIC);
  const { state } = resumeFixture();
  const emptyCurrent = { ...state, currentSession: session({ id: 'fresh', spins: [], tracks: [], buyIns: [], cashOuts: [] }) };
  const next = b.get('resumeSavedSession(vars.state, "a", "live", vars.now)', { state: emptyCurrent, now: LATER });
  assert.equal(next.savedSessions.length, 2, 'an empty, never-saved session is not saved');
  const selfSaved = { ...state, savedSessions: state.savedSessions.concat([plain(state.currentSession)]) };
  assert.equal(b.raw('resumeSavedSession(vars.state, "cur", "live", 1) === vars.state', { state: selfSaved }), true, 'the current session is not resumed onto itself');
  assert.equal(b.raw('resumeSavedSession(vars.state, "zzz", "live", 1) === vars.state', { state }), true, 'an unknown id is a no-op');
});

test('unsavedSpinCount: the spins the saved copy does not have, and every spin when the history changed', async () => {
  const b = await load(LOGIC);
  const saved = [session({ id: 's1', spins: ['1', '2'] })];
  assert.equal(b.get('unsavedSpinCount(vars.s, vars.list)', { s: session({ id: 's1', spins: ['1', '2', '3'] }), list: saved }), 1);
  assert.equal(b.get('unsavedSpinCount(vars.s, vars.list)', { s: session({ id: 's1', spins: ['1', '2'] }), list: saved }), 0);
  assert.equal(b.get('unsavedSpinCount(vars.s, vars.list)', { s: session({ id: 's9', spins: ['1', '2'] }), list: saved }), 2, 'never saved');
  assert.equal(b.get('unsavedSpinCount(vars.s, vars.list)', { s: session({ id: 's1', spins: ['9', '2', '3'] }), list: saved }), 3, 'a changed history counts every spin');
});

test('sessionHasUnsavedWork: a session that was saved and then changed, or never saved with spins', async () => {
  const b = await load(LOGIC);
  const saved = [session({ id: 's1', spins: ['1'] })];
  assert.equal(b.get('sessionHasUnsavedWork(vars.s, vars.list)', { s: session({ id: 's1', spins: ['1'] }), list: saved }), false);
  assert.equal(b.get('sessionHasUnsavedWork(vars.s, vars.list)', { s: session({ id: 's1', spins: ['1'], label: 'New name' }), list: saved }), true);
  assert.equal(b.get('sessionHasUnsavedWork(vars.s, vars.list)', { s: session({ id: 's2', spins: ['4'] }), list: saved }), true);
  assert.equal(b.get('sessionHasUnsavedWork(vars.s, vars.list)', { s: session({ id: 's2' }), list: saved }), false);
});

test('resumeStep: unsaved spins in the current session ask first; a saved one resumes at once; the current one does nothing', async () => {
  const b = await load(LOGIC);
  const saved = [session({ id: 'a', spins: ['5'] }), session({ id: 'b', spins: ['6'] })];
  // Never saved, with two spins: the confirm shows.
  assert.equal(b.get('resumeStep(vars.s, vars.list, "a")', { s: session({ id: 'cur', spins: ['1', '2'] }), list: saved }), 'confirm');
  // Saved with one spin, now three: one unsaved spin, so the confirm shows.
  const savedCopy = plain(session({ id: 'cur', spins: ['1'] }));
  assert.equal(b.get('resumeStep(vars.s, vars.list, "a")', { s: session({ id: 'cur', spins: ['1', '2', '3'] }), list: saved.concat([savedCopy]) }), 'confirm');
  // Saved, nothing changed since: resumes at once.
  assert.equal(b.get('resumeStep(vars.s, vars.list, "a")', { s: session({ id: 'cur', spins: ['1'] }), list: saved.concat([savedCopy]) }), 'resume');
  // The target is the current session: nothing to do.
  assert.equal(b.get('resumeStep(vars.s, vars.list, "cur")', { s: session({ id: 'cur', spins: ['1', '2'] }), list: saved }), 'none');
});

// -- Rename and sync --

test('normalizeLabel: trimmed, at most 60 characters, and empty or non-text is no label', async () => {
  const b = await load(LOGIC);
  assert.equal(b.get('normalizeLabel(vars.v)', { v: '  Harbor night  ' }), 'Harbor night');
  assert.equal(b.get('normalizeLabel(vars.v).length', { v: 'x'.repeat(80) }), 60);
  assert.equal(b.get('normalizeLabel(vars.v)', { v: '   ' }), null);
  assert.equal(b.get('normalizeLabel(vars.v)', { v: 5 }), null);
});

test('migrateSessionVenue normalises a label on load, and leaves a session without one alone', async () => {
  const b = await load(LOGIC);
  assert.equal(b.get('migrateSessionVenue(vars.s).label', { s: { id: 'x', label: '  Night  ' } }), 'Night');
  const legacy = b.get('migrateSessionVenue(vars.s)', { s: { id: 'y' } });
  assert.equal('label' in legacy, false, 'no label key is added to a legacy session');
});

test('renameSavedSession: the saved copy and the live copy both take the label, stamped as modified', async () => {
  const b = await load(LOGIC);
  const { state } = resumeFixture();
  const withLive = { ...state, currentSession: { ...state.currentSession, id: 'a' } };
  const next = b.get('renameSavedSession(vars.state, "a", "  Harbor night  ", vars.now)', { state: withLive, now: LATER });
  const saved = next.savedSessions.find((x) => x.id === 'a');
  assert.equal(saved.label, 'Harbor night');
  assert.equal(saved.modified, LATER);
  assert.equal(next.currentSession.label, 'Harbor night', 'a later save keeps the label');
  assert.equal(next.currentSession.modified, LATER);
  const cleared = b.get('renameSavedSession(vars.state, "a", "  ", vars.now)', { state: next, now: LATER + 100 });
  assert.equal(cleared.savedSessions.find((x) => x.id === 'a').label, null, 'an empty label shows the name again');
});

test('a rename syncs: the renamed copy wins the merge in either order', async () => {
  const b = await load(LOGIC);
  const { state } = resumeFixture();
  const renamed = b.get('renameSavedSession(vars.state, "a", "Harbor night", vars.now)', { state, now: LATER });
  const snap = (appState, modifiedAt) => ({ schema: 1, modifiedAt, resetAt: 0, appState });
  const older = snap(state, LATER - 1000);
  const newer = snap(renamed, LATER);
  const forward = b.get('mergeRouletteSnapshots(vars.a, vars.b)', { a: older, b: newer });
  const reverse = b.get('mergeRouletteSnapshots(vars.a, vars.b)', { a: newer, b: older });
  assert.equal(forward.appState.savedSessions.find((x) => x.id === 'a').label, 'Harbor night');
  assert.equal(reverse.appState.savedSessions.find((x) => x.id === 'a').label, 'Harbor night');
});

// -- The sheet: markup and static rules --

test('the sheet renders its rows, and the Current mark keeps its space whether or not a row is current', async () => {
  const b = await load(SHEET);
  const { state } = resumeFixture();
  const saved = state.savedSessions.concat([
    session({ id: 'river', venue: tableRiverside, spins: ['1'], sessionStartedAt: T(2026, 9, 31, 8) }),
    session({ id: 'harbor', venue: machineHarbor, spins: ['1'], sessionStartedAt: T(2026, 9, 31, 9) }),
  ]);
  const props = (sess) => ({ saved, sess, cur: { symbol: '$', dec: 2 }, initialResumeId: null, onResume() {}, onRename() {}, onAddNumbers() {}, readPhoto() {}, onClose() {} });
  const withCurrent = b.raw('ReactDOMServer.renderToStaticMarkup(React.createElement(SessionsPage, vars.p))', { p: props(saved[0]) });
  const withoutCurrent = b.raw('ReactDOMServer.renderToStaticMarkup(React.createElement(SessionsPage, vars.p))', { p: props(session({ id: 'nowhere' })) });
  const marks = (html) => (html.match(/>Current</g) || []).length;
  assert.equal(marks(withCurrent), saved.length, 'one Current slot per row');
  assert.equal(marks(withoutCurrent), saved.length, 'the same slots when no row is current');
  assert.match(withCurrent, /visibility:visible[^>]*>Current</, 'the current row shows its mark');
  assert.match(withoutCurrent, /visibility:hidden[^>]*>Current</, 'the mark is hidden, not removed');
  assert.match(withCurrent, /Harbor/, 'a casino the sessions hold is offered');
  assert.doesNotMatch(withCurrent, /<select/, 'no native select (rule 27)');
});

// The sheet's other views start from state a server render cannot reach, because effects do not run on the server. So
// the test supplies the first value of each useState, in the order SessionsPage declares them: view, target, filters,
// draft, bulk, note. Every other hook is the real one.
function startingState(initial) {
  let index = 0;
  return { ...React, useState: (init) => {
    const value = index < initial.length && initial[index] !== undefined ? initial[index] : init;
    index += 1;
    return [value, () => {}];
  } };
}

test('the catch-up, confirm and rename views render from their own state, and a bad entry disables Add', async () => {
  const liveTarget = session({ id: 'a', spins: ['5'], venue: tableRiverside, mode: 'live', sessionStartedAt: T(2026, 9, 30, 19) });
  const gameTarget = session({ id: 'g', mode: 'game', spins: ['1'] });
  const saved = [liveTarget, gameTarget];
  const render = async (initial, sess) => {
    const b = await load(SHEET, startingState(initial));
    const props = { saved, sess, cur: { symbol: '$', dec: 2 }, initialResumeId: null, onResume() {}, onRename() {}, onAddNumbers() {}, readPhoto() {}, onClose() {} };
    return b.raw('ReactDOMServer.renderToStaticMarkup(React.createElement(SessionsPage, vars.p))', { p: props });
  };
  // Catch up on a live session, five numbers with a repeat: the chips, the status and the Add count.
  const catchUp = await render(['catchup', liveTarget, undefined, undefined, '2 2 2 24 4', undefined], liveTarget);
  assert.match(catchUp, /Numbers you add here are entered as new spins, oldest first\./);
  assert.match(catchUp, /Read board photo/);
  assert.match(catchUp, /5 numbers to enter, oldest first/);
  assert.match(catchUp, />Add 5 spins</);
  assert.equal((catchUp.match(/>2</g) || []).length, 3, 'the repeats are three chips');
  // A bad token: the entry is named in the status, and Add is disabled.
  const badEntry = await render(['catchup', liveTarget, undefined, undefined, '2 35x', undefined], liveTarget);
  assert.match(badEntry, /35x/);
  assert.match(badEntry, /is not a number on the American wheel\./);
  assert.match(badEntry, /<button[^>]*disabled=""[^>]*>Add<\/button>/, 'Add is disabled while the entry is not valid');
  // A Game session: no numbers can be caught up into it, and the card says where they go.
  const gameView = await render(['catchup', gameTarget, undefined, undefined, undefined, undefined], gameTarget);
  assert.match(gameView, /This is a Game session\./);
  assert.doesNotMatch(gameView, /Read board photo/);
  // Switching away with unsaved spins: the confirm names the count, and offers Cancel and Save and switch.
  const confirm = await render(['confirm', liveTarget], session({ id: 'cur', spins: ['1', '2'] }));
  assert.match(confirm, /has 2 spins that are not saved/);
  assert.match(confirm, />Save and switch</);
  assert.match(confirm, />Cancel</);
  // Rename: the field holds the label, and the count of characters is shown.
  const rename = await render(['rename', liveTarget, undefined, 'Harbor night', undefined, undefined], liveTarget);
  assert.match(rename, /value="Harbor night"/);
  assert.match(rename, /12\/60 characters/);
});

test('static rules: one sheet, mounted from Stats, the board add wired, and no native dialog or fixed width', async () => {
  const read = (p) => readFile(new URL(p, SRC), 'utf8');
  const files = ['components/SessionsPage.jsx', 'components/SecondaryPages.jsx', 'App.jsx', 'sessions-browse.js', 'session.js'];
  const texts = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await read(f)])));
  const sheet = texts['components/SessionsPage.jsx'];
  assert.doesNotMatch(sheet, /<select|window\.(confirm|alert|prompt)\(/, 'the sheet uses the shared Modal and chips only');
  assert.doesNotMatch(sheet, /width:\s*\d{3,}/, 'no fixed width of 100 px or more, so nothing scrolls sideways');
  assert.ok(/flexWrap:"wrap"/.test(sheet), 'the chip rows wrap');
  assert.match(texts['components/SecondaryPages.jsx'], /<SessionsPage /, 'StatsPage mounts the sheet');
  assert.match(texts['App.jsx'], /addCatchUp=\{setBoardAdd\}/, 'the Add goes through the board-add path');
  assert.doesNotMatch(texts['App.jsx'] + texts['components/SecondaryPages.jsx'], /loadSession/, 'the old resume is gone');
  const copies = (await Promise.all((await readdirSources()).map(async (f) => (await read(f)).match(/function SessionsPage\(/g) || []))).flat();
  assert.equal(copies.length, 1, 'one definition of the sheet');
  assert.ok((texts['App.jsx'].split('\n').length - 1) < 900, 'App.jsx stays under the 900-line test cap');
});

async function readdirSources() {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  const walk = async (dir, prefix) => {
    for (const e of await readdir(new URL(dir, SRC), { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) await walk(dir + e.name + '/', rel + '/');
      else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(rel);
    }
  };
  await walk('', '');
  return out;
}

test('build.js lists both new files in dependency order', async () => {
  const build = await readFile(new URL('nexus-src/build.js', ROOT), 'utf8');
  assert.ok(build.indexOf("'sessions-browse.js'") > build.indexOf("'session.js'"), 'after session.js');
  assert.ok(build.indexOf("'sessions-browse.js'") < build.indexOf("'App.jsx'"), 'before App.jsx');
  assert.ok(build.indexOf("'components/BoardPhoto.jsx'") < build.indexOf("'components/SessionsPage.jsx'"), 'after BoardPhoto (BOARD_MAX_NUMBERS)');
  assert.ok(build.indexOf("'components/SessionsPage.jsx'") < build.indexOf("'components/SecondaryPages.jsx'"), 'before SecondaryPages');
});
