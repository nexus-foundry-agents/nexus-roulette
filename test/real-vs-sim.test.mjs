import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// F12, real versus simulated: the pure grouping, counts, streaks and simulated reference (real-vs-sim.js), the venue
// picker's choice lists, and the sheet's markup (RealVsSimPage.jsx). The real source is transpiled and run in one sandbox,
// in the order build.js concatenates it. Nothing is copied from source.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const ROOT = new URL('../', import.meta.url);
const LOGIC = ['constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'sessions-browse.js',
  'streak-percentiles.js', 'percentile.js', 'real-vs-sim.js'];
const SHEET = [...LOGIC, 'components/ui.jsx', 'components/BoardPhoto.jsx', 'components/SessionsPage.jsx', 'components/RealVsSimPage.jsx'];

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
  vm.runInContext(code, sandbox, { filename: 'real-vs-sim-bundle.js' });
  return {
    // JSON round trip, so results from the sandbox realm compare as plain data.
    get(expr, vars) { sandbox.vars = vars || {}; return JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, sandbox)); },
    raw(expr, vars) { sandbox.vars = vars || {}; return vm.runInContext(expr, sandbox); },
  };
}

const T = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
function sess(over = {}) {
  return {
    id: 's1', name: 'Session', created: T(2026, 9, 31, 8), modified: T(2026, 9, 31, 9), roulette: 'american',
    spins: [], dealerChanges: [], venue: null, tracks: [], sessionStartedAt: T(2026, 9, 31, 8), sessionEndedAt: null,
    ...over,
  };
}
const MACHINE = { kind: 'machine', casino: 'Harbor', maker: 'IGT', model: 'Game King', version: 'v2' };
const TABLE = { kind: 'table', casino: 'Riverside', table: '3' };
const SPINS_11 = ['1', '2', '13', '25', '0', '00', '5', '14', '26', '35', '4'];
const NOOP = () => {};

async function renderSheet(props) {
  const b = await load(SHEET);
  return b.raw('ReactDOMServer.renderToStaticMarkup(React.createElement(RealVsSimPage, vars.props))',
    { props: { onClose: NOOP, ...props } });
}

// -- Grouping by venue --

test('venue grouping: a machine is one stretch, a table splits at its dealer changes, and keys ignore case', async () => {
  const b = await load(LOGIC);
  const list = [
    sess({ id: 'a', venue: MACHINE, spins: ['1', '2', '3', '4', '5'] }),
    sess({ id: 'b', venue: { kind: 'table', casino: 'Riverside', table: '3', dealer: 'Bo' },
      dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 3, dealer: 'Bo' }],
      spins: ['7', '8', '9', '10', '11', '12'] }),
    sess({ id: 'c', venue: null, spins: ['1'] }),
    sess({ id: 'd', venue: { kind: 'machine', casino: 'HARBOR', maker: 'igt', model: 'game king', version: 'V2' }, spins: ['6', '6'] }),
  ];
  const stretches = b.get('venueStretches(vars.list)', { list });
  assert.equal(stretches.length, 4, 'machine a, table b split into Ann and Bo, machine d; the session with no venue is left out');
  assert.deepEqual(stretches.map((st) => st.dealer), [null, 'Ann', 'Bo', null]);
  const groups = b.get('venueGroups(vars.s)', { s: stretches });
  assert.equal(groups.length, 3, 'Harbor machine, Riverside table with Ann, Riverside table with Bo');
  assert.equal(groups[0].casino, 'Harbor', 'the spelling kept is the first one seen');
  assert.equal(groups[0].spins, 7, 'the machine typed two ways is one venue: 5 + 2 spins');
  assert.deepEqual(groups.slice(1).map((g) => [g.dealer, g.spins]), [['Ann', 3], ['Bo', 3]]);
});

test('a spin that is not a number on its wheel is left out: 00 is not on a European wheel', async () => {
  const b = await load(LOGIC);
  const stretches = b.get('venueStretches(vars.list)', {
    list: [sess({ roulette: 'european', venue: MACHINE, spins: ['0', '00', '7'] })],
  });
  assert.equal(stretches.length, 1);
  assert.deepEqual(stretches[0].spins, ['0', '7']);
});

// -- Counts and streaks on a fixed fixture (American) --

test('counts and longest completed losing streaks on a fixed fixture match hand counts, and the percentile reads the table', async () => {
  const b = await load(LOGIC);
  const stats = b.get('venueStats(venueStretches(vars.list))', { list: [sess({ venue: MACHINE, spins: SPINS_11 })] });
  assert.equal(stats.spins, 11);
  assert.equal(stats.numbers.length, 38, 'the grid always has the 38 American cells');
  assert.equal(stats.numbers.filter((n) => n.count === 1).length, 11, 'each of the 11 spins is one hit on its number');
  assert.equal(stats.numbers.find((n) => n.number === '00').count, 1);
  assert.equal(stats.numbers.find((n) => n.number === '17').count, 0);
  // Dozens: 1-12 hit by 1, 2, 5, 4; 13-24 by 13, 14; 25-36 by 25, 26, 35.
  assert.deepEqual(stats.dozens.map((d) => d.hits), [4, 2, 3]);
  // Columns: column 1 by 1, 13, 25, 4; column 2 by 2, 5, 14, 26, 35; the third column by no spin.
  assert.deepEqual(stats.columns.map((c) => c.hits), [4, 5, 0]);
  // Longest completed losing streak (a run of misses ended by a hit; an open run at the end is not counted).
  assert.deepEqual(stats.dozens.map((d) => d.longest), [4, 4, 4]);
  assert.deepEqual(stats.columns.map((c) => c.longest), [6, 4, 0]);
  assert.equal(stats.columns[2].percentile, null, 'no completed streak: no percentile');
  // The percentile is read from the generated table: the share of completed streaks of that length or shorter, rounded down.
  const table = b.get('STREAK_PERCENTILE_DATA');
  const pct = (cat, k) => Math.floor(table.american[cat].cum[k - 1] / 1000) / 10;
  assert.equal(stats.dozens[0].percentile, pct('dozen:0', 4));
  assert.equal(stats.columns[0].percentile, pct('column:0', 6));
  assert.equal(stats.columns[1].percentile, pct('column:1', 4));
});

test('a losing streak is counted inside one dealer\'s span, so a dealer change cuts it', async () => {
  const b = await load(LOGIC);
  // The same six spins, at a machine and at a table whose dealer changes after the third spin. The only difference between the
  // two arms is the dealer split. Dozen 1-12 is missed by 25, 26, 27 and then hit by 2.
  const spins = ['25', '26', '27', '2', '5', '6'];
  const machine = b.get('venueStats(venueStretches(vars.list))', { list: [sess({ venue: MACHINE, spins })] });
  const table = b.get('venueStats(venueStretches(vars.list))', {
    list: [sess({ venue: { kind: 'table', casino: 'Riverside', table: '3' }, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }, { fromSpin: 3, dealer: 'Bo' }], spins })],
  });
  assert.equal(machine.dozens[0].longest, 3, 'one stretch: the run 25, 26, 27 is ended by the hit on 2');
  assert.equal(table.dozens[0].longest, 0, 'Ann\'s span 25, 26, 27 never ends in a hit, and Bo\'s span starts with a hit');
  assert.equal(table.dozens[0].hits, machine.dozens[0].hits, 'the hit counts do not depend on the split');
});

// -- The simulated reference (plain arithmetic) --

test('the simulated reference: each spin adds 1 over the wheel\'s pockets to each number on that wheel', async () => {
  const b = await load(LOGIC);
  const american = b.get('venueStats(venueStretches(vars.list))', { list: [sess({ venue: MACHINE, spins: Array(370).fill('1') })] });
  assert.equal(american.numbers.length, 38);
  american.numbers.forEach((n) => assert.ok(Math.abs(n.reference - 370 / 38) < 1e-9, n.number));
  assert.ok(Math.abs(american.dozens[0].reference - 370 * 12 / 38) < 1e-9);

  const european = b.get('venueStats(venueStretches(vars.list))', {
    list: [sess({ roulette: 'european', venue: MACHINE, spins: Array(370).fill('1') })],
  });
  const zero = european.numbers.find((n) => n.number === '00');
  assert.equal(zero.onWheel, false, '00 is not on a European wheel: its cell is hidden, its place kept');
  assert.equal(zero.reference, 0);
  assert.ok(european.numbers.filter((n) => n.onWheel).every((n) => Math.abs(n.reference - 10) < 1e-9), 'the 37 pockets each get 370 / 37 = 10');
  assert.ok(Math.abs(european.dozens[2].reference - 120) < 1e-9);

  const mixed = b.get('venueStats(venueStretches(vars.list))', {
    list: [sess({ id: 'a', venue: MACHINE, spins: Array(38).fill('1') }),
      sess({ id: 'b', roulette: 'european', venue: MACHINE, spins: Array(37).fill('1') })],
  });
  assert.equal(mixed.numbers.find((n) => n.number === '00').reference, 1, '38 American spins over 38 pockets');
  assert.equal(mixed.numbers.find((n) => n.number === '00').onWheel, true);
  assert.ok(Math.abs(mixed.numbers.find((n) => n.number === '1').reference - 2) < 1e-9, '1 from each wheel: 38/38 + 37/37');
  assert.ok(Math.abs(mixed.dozens[0].reference - 24) < 1e-9, 'a dozen holds 12 numbers on each wheel: 38 * 12 / 38 + 37 * 12 / 37');
});

// -- Empty, loading, error and under-100 states --

test('empty: no venue, or a venue with no spins, logs nothing to show', async () => {
  const b = await load(LOGIC);
  assert.deepEqual(b.get('venueStretches(vars.list)', { list: [sess({ venue: null, spins: ['1'] })] }), []);
  assert.deepEqual(b.get('venueStretches(vars.list)', { list: [sess({ venue: MACHINE, spins: [] })] }), []);
  const markup = await renderSheet({ sessions: [] });
  assert.match(markup, /No sessions logged at a venue yet\./);
  assert.doesNotMatch(markup, /Spins observed/);
});

test('loading and error states: undefined is loading, null cannot be read', async () => {
  assert.match(await renderSheet({ sessions: undefined }), /Loading the logged sessions/);
  assert.match(await renderSheet({ sessions: null }), /Could not read the logged sessions\./);
});

test('under 100 spins the note says how many are logged; at 100 it says nothing', async () => {
  const b = await load(LOGIC);
  assert.equal(b.get('venueNote(vars.n)', { n: 42 }), 'Only 42 spins logged here.');
  assert.equal(b.get('venueNote(vars.n)', { n: 1 }), 'Only 1 spin logged here.');
  assert.equal(b.get('venueNote(vars.n)', { n: 0 }), 'Only 0 spins logged here.');
  assert.equal(b.get('venueNote(vars.n)', { n: 100 }), '');
  assert.match(await renderSheet({ sessions: [sess({ venue: MACHINE, spins: SPINS_11.slice(0, 3) })] }), /Only 3 spins logged here\./);
  assert.doesNotMatch(await renderSheet({ sessions: [sess({ venue: MACHINE, spins: Array(150).fill('1') })] }), /logged here/);
});

// -- The current session and the saved list --

test('the current session replaces its saved copy, and a current session never saved is added', async () => {
  const b = await load(LOGIC);
  const saved = [sess({ id: 'a', venue: MACHINE, spins: ['1'] }), sess({ id: 'b', venue: MACHINE, spins: ['2'] })];
  const current = sess({ id: 'b', venue: MACHINE, spins: ['2', '3'] });
  const list = b.get('realVsSimSessions(vars.saved, vars.current).map(s => s.id + ":" + s.spins.length)', { saved, current });
  assert.deepEqual(list, ['a:1', 'b:2'], 'b is counted once, with its live spins');
  const extra = b.get('realVsSimSessions(vars.saved, vars.current).map(s => s.id)', { saved, current: sess({ id: 'z', venue: TABLE }) });
  assert.deepEqual(extra, ['a', 'b', 'z']);
});

// -- The picker: choice lists hold only values that exist, one level at a time --

test('the picker lists only values that exist, and a casino resets the lower levels', async () => {
  const b = await load(LOGIC);
  const stretches = b.get('venueStretches(vars.list)', {
    list: [
      sess({ id: 'm', venue: MACHINE, spins: ['1'] }),
      sess({ id: 't', venue: { kind: 'table', casino: 'Riverside', table: '3' }, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }], spins: ['2'] }),
      sess({ id: 'h', venue: { kind: 'table', casino: 'Harbor', table: 'Blackjack' }, spins: ['3'] }),
    ],
  });
  const all = b.get('venueChoices(vars.s, vars.sel)', { s: stretches, sel: { casino: null, place: null, dealer: null } });
  assert.deepEqual(all.casino.map((c) => c.label), ['Harbor', 'Riverside']);
  assert.deepEqual(all.place.map((c) => c.label), ['3', 'Blackjack', 'IGT Game King v2']);
  assert.deepEqual(all.dealer.map((c) => c.label), ['Ann', 'No dealer recorded'], 'a machine has no dealer, so it adds none');

  const harbor = b.get('venueChoices(vars.s, vars.sel)', { s: stretches, sel: { casino: 'harbor', place: null, dealer: null } });
  assert.deepEqual(harbor.place.map((c) => c.label), ['Blackjack', 'IGT Game King v2'], 'only the places under Harbor');
  assert.deepEqual(harbor.dealer.map((c) => c.label), ['No dealer recorded']);

  const machine = b.get('venueChoices(vars.s, vars.sel)', { s: stretches, sel: { casino: 'harbor', place: 'machine:igt game king v2', dealer: null } });
  assert.deepEqual(machine.dealer, [], 'a machine offers no dealer');

  const picked = b.get('venuePick(vars.sel, "casino", "riverside")', { sel: { casino: 'harbor', place: 'table:blackjack', dealer: '' } });
  assert.deepEqual(picked, { casino: 'riverside', place: null, dealer: null }, 'a new casino clears the place and the dealer');
  const same = b.raw('venuePick(vars.sel, "casino", "harbor") === vars.sel', { sel: { casino: 'harbor', place: null, dealer: null } });
  assert.equal(same, true, 'tapping the choice already applied changes nothing');
  const dealerPick = b.get('venuePick(vars.sel, "dealer", "ann")', { sel: { casino: 'riverside', place: 'table:3', dealer: null } });
  assert.deepEqual(dealerPick, { casino: 'riverside', place: 'table:3', dealer: 'ann' });
});

// -- Rendering: reserved cells, the sheet's copy, and the static rules --

test('the number grid keeps its 38 cells on every venue: 00 is hidden on a European venue, not removed', async () => {
  const american = await renderSheet({ sessions: [sess({ venue: MACHINE, spins: SPINS_11 })] });
  const european = await renderSheet({ sessions: [sess({ roulette: 'european', venue: MACHINE, spins: SPINS_11.filter((v) => v !== '00') })] });
  const cells = (markup) => (markup.match(/>ref \d+\.\d</g) || []).length;
  assert.equal(cells(american), 38);
  assert.equal(cells(european), 38, 'the same number of cells on both wheels');
  assert.match(european, /aria-hidden="true" style="[^"]*visibility:hidden;font-variant-numeric:tabular-nums"><div style="[^"]*">00<\/div>/);
  assert.doesNotMatch(american, /aria-hidden="true" style="[^"]*visibility:hidden;font-variant-numeric:tabular-nums"><div style="[^"]*">00<\/div>/);
});

test('reserved space: the three chip rows and the venue title keep their height whatever the choices', async () => {
  const machine = await renderSheet({ sessions: [sess({ venue: MACHINE, spins: SPINS_11 })] });
  const table = await renderSheet({
    sessions: [sess({ roulette: 'european', venue: TABLE, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }], spins: ['1', '2', '3'] })],
  });
  for (const markup of [machine, table]) {
    assert.equal(markup.split('height:66px;overflow-y:auto').length - 1, 3, 'three chip rows, each two lines high, scrolling inside');
    assert.equal(markup.split('height:40px;overflow:hidden').length - 1, 1, 'the venue title keeps two lines');
  }
});

test('the sheet and the module copy contain none of the banned words', async () => {
  const read = (p) => readFile(new URL(p, SRC), 'utf8');
  const banned = /house edge|\bodds\b|beat|fair|rigged|advantage|should/i;
  for (const f of ['real-vs-sim.js', 'components/RealVsSimPage.jsx']) {
    assert.doesNotMatch(await read(f), banned, f);
  }
  const b = await load(SHEET);
  const markup = b.raw('ReactDOMServer.renderToStaticMarkup(React.createElement(RealVsSimPage, { sessions: vars.s, current: null, onClose: function(){} }))',
    { s: [sess({ venue: MACHINE, spins: SPINS_11 }), sess({ id: 't', venue: TABLE, dealerChanges: [{ fromSpin: 0, dealer: 'Ann' }], spins: ['1', '2'] })] });
  assert.doesNotMatch(markup, banned);
});

test('static rules: a shared Modal, wrapping chips, no native select or dialog, and no fixed width', async () => {
  const sheet = await readFile(new URL('components/RealVsSimPage.jsx', SRC), 'utf8');
  assert.doesNotMatch(sheet, /<select|window\.(confirm|alert|prompt)\(/, 'the sheet uses the shared Modal and chips only');
  assert.doesNotMatch(sheet, /width:\s*\d{3,}/, 'no fixed width of 100 px or more, so nothing scrolls sideways');
  assert.match(sheet, /flexWrap: "wrap"/, 'the chip rows and the header wrap');
  assert.match(sheet, /<Modal onClose=\{onClose\}>/, 'one shared Modal');
  assert.match(sheet, /repeat\(auto-fill,minmax\(64px,1fr\)\)/, 'the number grid wraps');
});

test('StatsPage has one button, one state line and one mount for the sheet', async () => {
  const page = await readFile(new URL('components/SecondaryPages.jsx', SRC), 'utf8');
  assert.equal(page.split('Real vs simulated').length - 1, 1, 'one button');
  assert.equal(page.split('<RealVsSimPage ').length - 1, 1, 'one mount');
  assert.match(page, /const \[realVsSim, setRealVsSim\] = useState\(false\);/);
  assert.match(page, /\{realVsSim && <RealVsSimPage sessions=\{saved\} current=\{sess\}/, 'the saved list and the current session');
});

test('build.js lists both new files in dependency order', async () => {
  const build = await readFile(new URL('nexus-src/build.js', ROOT), 'utf8');
  assert.ok(build.indexOf("'real-vs-sim.js'") > build.indexOf("'tlv.js'"), 'after tlv.js, which follows percentile.js');
  assert.ok(build.indexOf("'real-vs-sim.js'") < build.indexOf("'components/SecondaryPages.jsx'"), 'before the Stats page that mounts it');
  assert.ok(build.indexOf("'components/RealVsSimPage.jsx'") > build.indexOf("'components/SessionsPage.jsx'"), 'after SessionsPage, whose chip it uses');
  assert.ok(build.indexOf("'components/RealVsSimPage.jsx'") < build.indexOf("'components/SecondaryPages.jsx'"), 'before SecondaryPages');
});
