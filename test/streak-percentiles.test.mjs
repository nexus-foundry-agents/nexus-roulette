import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import {
  MAX_LENGTH, PERCENTILES, SEED_LABEL, WHEELS, betCategories, fnv1a32, renderModule, runShard,
  sessionState, simulate, winTable, xoshiroNext,
} from '../tools/gen-streak-percentiles.mjs';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const GENERATED = new URL('streak-percentiles.js', SRC);
const plain = (value) => JSON.parse(JSON.stringify(value));
const NOOP = () => {};

// The files the bundle concatenates ahead of the pieces these tests render, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'streak-percentiles.js', 'percentile.js', 'tlv.js',
  'roulette-bets.mjs', 'components/NumberDrought.jsx', 'components/ui.jsx', 'components/grids.jsx',
  'components/TlvSparkline.jsx', 'components/SectionTile.jsx', 'components/DroughtPanel.jsx', 'components/SecondaryPages.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global scope.
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
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React,
    useState: React.useState,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useRef: React.useRef,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    require: (name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  return { ctx: sandbox };
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

async function render(name, props) {
  const { ctx } = await load();
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx[name], props));
}

async function fixture(roulette = 'american') {
  const { ctx } = await load();
  return { ctx, sess: plain(ctx.newSession(roulette, 500)) };
}

// The counter's fixed style as the server renders it. Its opening tag is the reserved slot; only its text varies.
const SLOT = 'font-size:7px;font-weight:400;line-height:8px;height:8px;';
// [label, text] for each counter in a stacked RouletteBoard cell, and for each counter in a FibGrid cell.
const boardPairs = (html) => [...html.matchAll(
  new RegExp(`align-items:center">([^<]+)<div style="${SLOT}[^"]*">([^<]*)</div></div>`, 'g'),
)].map((m) => [m[1], m[2]]);
const fibPairs = (html) => [...html.matchAll(
  new RegExp(`(?:line-height:14px"|<div)>([^<]+)</div><div style="${SLOT}[^"]*">([^<]*)</div>`, 'g'),
)].map((m) => [m[1], m[2]]);
const boardProps = (sess, extra = {}) => ({
  roulette: sess.roulette, droughts: sess.droughts, spins: sess.spins,
  stratBets: {}, boardBets: {}, betResults: {}, stratChips: {}, ...extra,
});
const fibProps = (sess, extra = {}) => ({
  onNumber: NOOP, dozenTargets: [0], colTargets: [], fibRow: null, trackOverlays: [], flashNum: null,
  roulette: sess.roulette, droughts: sess.droughts, spins: sess.spins, showDroughts: true, headStart: false,
  ...extra,
});

// The module text as the app loads it: evaluated, with the table returned.
function loadTable(text) {
  return vm.runInNewContext(`${text}\nSTREAK_PERCENTILE_DATA`, {});
}

// An independent reference. Each spin's pocket comes from the reference xoshiroNext step, and each bet's streaks
// are counted one spin at a time from the bet's own cover list. Returns the bins, shaped like the generator's.
function referenceBins(wheel, sessions, spins, onlyKey) {
  const widx = WHEELS.indexOf(wheel);
  const master = fnv1a32(SEED_LABEL);
  const tbl = winTable(wheel);
  const cats = tbl.cats.map((cat, c) => ({ ...cat, c })).filter((cat) => !onlyKey || cat.key === onlyKey);
  const bins = new Float64Array(tbl.nC * MAX_LENGTH);
  for (let s = 0; s < sessions; s++) {
    const state = sessionState(master, widx, s);
    const run = new Array(tbl.nC).fill(0);
    for (let i = 0; i < spins; i++) {
      const label = tbl.labels[Math.floor((xoshiroNext(state) * tbl.nP) / 4294967296)];
      for (const cat of cats) {
        if (cat.cover.includes(label)) {
          if (run[cat.c] > 0) bins[cat.c * MAX_LENGTH + Math.min(run[cat.c], MAX_LENGTH - 1)] += 1;
          run[cat.c] = 0;
        } else {
          run[cat.c] += 1;
        }
      }
    }
  }
  return bins;
}

// Every table entry is internally consistent: lengths rise with the percentile, the cumulative table never falls
// and reaches 99.99%, and each P length is the shortest length whose share reaches that percentile.
function checkTable(table, label) {
  for (const wheel of WHEELS) {
    for (const [key, entry] of Object.entries(table[wheel])) {
      const where = `${label} ${wheel} ${key}`;
      assert.ok(entry.n > 0, where);
      assert.equal(entry.p.length, PERCENTILES.length, where);
      for (let i = 1; i < entry.p.length; i++) assert.ok(entry.p[i] >= entry.p[i - 1], `${where}: lengths rise`);
      assert.ok(entry.p[0] >= 1, where);
      for (let i = 1; i < entry.cum.length; i++) assert.ok(entry.cum[i] >= entry.cum[i - 1], `${where}: cumulative never falls`);
      const last = entry.cum[entry.cum.length - 1];
      assert.ok(last >= 999900 && last <= 1000000, `${where}: the table reaches 99.99%`);
      entry.p.forEach((len, i) => {
        const threshold = PERCENTILES[i] * 10000;
        assert.ok(entry.cum[len - 1] >= threshold, `${where}: P${PERCENTILES[i]} reaches its share`);
        if (len > 1) assert.ok(entry.cum[len - 2] < threshold, `${where}: P${PERCENTILES[i]} is the shortest such length`);
      });
    }
  }
}

// -- Generator --

test('generator: the same seed gives the same table whatever the number of workers, and a different seed a different one', async () => {
  const one = await simulate({ sessions: 2, spins: 50000, workers: 1 });
  const two = await simulate({ sessions: 2, spins: 50000, workers: 2 });
  const again = await simulate({ sessions: 2, spins: 50000, workers: 2 });
  assert.deepEqual(two, one);
  assert.deepEqual(again, two);
  assert.equal(renderModule(one, 'fixed'), renderModule(two, 'fixed'), 'the module text is identical too');
  const other = await simulate({ sessions: 2, spins: 50000, workers: 1, seedLabel: 'a different seed' });
  assert.notDeepEqual(other.american['straight:17'].cum, one.american['straight:17'].cum);
});

test('generator: the optimised loop counts exactly the streaks the one-spin-at-a-time reference counts, for every bet on both wheels', () => {
  for (const wheel of WHEELS) {
    const { hist, overflow } = runShard({ master: fnv1a32(SEED_LABEL), sessions: 2, spins: 20000, wheels: [wheel], shard: 0, shards: 1 });
    assert.equal(overflow, 0);
    assert.deepEqual(Array.from(hist[wheel]), Array.from(referenceBins(wheel, 2, 20000)), wheel);
  }
});

test('generator: the seeded pockets come out evenly (each pocket within 8% of its expected count over 200,000 spins)', () => {
  const state = sessionState(fnv1a32(SEED_LABEL), 0, 0);
  const counts = new Array(38).fill(0);
  const spins = 200000;
  for (let i = 0; i < spins; i++) counts[Math.floor((xoshiroNext(state) * 38) / 4294967296)] += 1;
  const expected = spins / 38;
  counts.forEach((c, i) => assert.ok(Math.abs(c - expected) / expected < 0.08, `pocket ${i} counted ${c}`));
});

test('generator: the reduced run gives consistent tables, and the module text loads back to the same table', async () => {
  const reduced = await simulate({ sessions: 2, spins: 50000, workers: 2 });
  checkTable(reduced, 'reduced');
  assert.deepEqual(
    betCategories('american').map((c) => c.key),
    Object.keys(reduced.american),
    'every bet category is in the table, in order',
  );
  assert.deepEqual(Object.keys(reduced.european), betCategories('european').map((c) => c.key));
  const back = loadTable(renderModule(reduced, 'fixed'));
  delete back.meta.generatedAt;
  assert.deepEqual(plain(back), plain(reduced));
});

// -- The generated table --

test('generated module: a header with the seed, sessions, spins, algorithm and timestamp; under 300 KB; data only', async () => {
  const text = await readFile(GENERATED, 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') < 300 * 1024, 'under 300 KB');
  const head = text.split('\n').slice(0, 9).join('\n');
  assert.match(head, /GENERATED FILE: do not edit by hand/);
  assert.match(head, /Generated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  assert.match(head, /Seed: "nexus-roulette-streak-percentiles-2026-10-30" \(FNV-1a 32-bit 0x[0-9a-f]{8}\)/);
  assert.match(head, /Algorithm: xoshiro128\*\* \(Blackman and Vigna\)/);
  assert.match(head, /Simulation: 1000 sessions x 1000000 spins for each wheel: american \(38 pockets\), european \(37 pockets\)\./);
  assert.doesNotMatch(text, /\bfunction\b|=>/, 'the generated file is data, not code');
  const table = loadTable(text);
  assert.equal(table.meta.sessions, 1000);
  assert.equal(table.meta.spinsPerSession, 1000000);
  assert.equal(table.meta.seedLabel, SEED_LABEL);
});

test('generated table: consistent for every bet on both wheels, with the expected categories', async () => {
  const table = loadTable(await readFile(GENERATED, 'utf8'));
  checkTable(table, 'generated');
  assert.equal(Object.keys(table.american).length, betCategories('american').length, '55 categories on American, basket included');
  assert.equal(Object.keys(table.european).length, betCategories('european').length, '53 categories on European, no basket');
  assert.equal(table.american.basket !== undefined, true);
  assert.equal(table.european.basket, undefined);
});

// -- Lookup --

test('lookup: the percentile never falls as the streak lengthens, for every bet on both wheels', async () => {
  const { ctx } = await load();
  for (const wheel of WHEELS) {
    for (const row of ctx.streakRows(wheel)) {
      let last = -1;
      for (let length = 0; length <= 700; length++) {
        const pct = ctx.streakPercentile(row.key, wheel, length);
        assert.ok(pct >= last, `${wheel} ${row.key} at ${length}: ${pct} after ${last}`);
        last = pct;
      }
    }
  }
});

test('lookup: each percentile length reads at least its percentile, and the length before it reads below', async () => {
  const { ctx } = await load();
  for (const wheel of WHEELS) {
    for (const row of ctx.streakRows(wheel)) {
      row.p.forEach((len, i) => {
        const pct = PERCENTILES[i];
        const where = `${wheel} ${row.key} P${pct}`;
        assert.ok(ctx.streakPercentile(row.key, wheel, len) >= pct, `${where} at ${len}`);
        assert.ok(ctx.streakPercentile(row.key, wheel, len - 1) < pct, `${where} before ${len}`);
      });
    }
  }
});

test('lookup: a single number at its P98 length reads at least 98.0 and the length before it reads below', async () => {
  const { ctx } = await load();
  const p98 = ctx.STREAK_PERCENTILE_DATA.american['straight:17'].p[5];
  assert.ok(p98 > 100, `the P98 of a single number is a long streak (${p98})`);
  assert.ok(ctx.streakPercentile('straight:17', 'american', p98) >= 98);
  assert.ok(ctx.streakPercentile('straight:17', 'american', p98 - 1) < 98);
});

test('a known case: single number 17 on American, the P50 of the reduced run is that run\'s own median and the lookup lands on it', async () => {
  const { ctx } = await load();
  const reduced = await simulate({ sessions: 2, spins: 50000, workers: 2 });
  // The median from the reduced run's own counts, from the reference streaks and not from the table's P50 field.
  const bins = referenceBins('american', 2, 50000, 'straight:17');
  const cat = betCategories('american').findIndex((c) => c.key === 'straight:17');
  const counts = Array.from(bins.subarray(cat * MAX_LENGTH, (cat + 1) * MAX_LENGTH));
  const total = counts.reduce((a, b) => a + b, 0);
  let running = 0;
  let median = 0;
  for (let k = 1; k < MAX_LENGTH && median === 0; k++) {
    running += counts[k];
    if (running * 2 >= total) median = k;
  }
  assert.equal(reduced.american['straight:17'].p[1], median, 'the generator\'s P50 is the reduced run\'s own median');
  assert.ok(ctx.streakPercentile('straight:17', 'american', median, reduced) >= 50);
  assert.ok(ctx.streakPercentile('straight:17', 'american', median - 1, reduced) < 50);
  // Theory for a single number on American: each spin loses with chance 37/38, so the median completed streak is
  // the smallest k with 1 - (37/38)^k >= 1/2, which is 26. The reduced run must land within 3 of it.
  assert.ok(Math.abs(median - 26) <= 3, `median ${median} is within 3 of 26`);
});

test('lookup: an unknown bet, wheel or length gives null; no losses gives 0; past the table it reads the last entry', async () => {
  const { ctx } = await load();
  assert.equal(ctx.streakPercentile('nope', 'american', 5), null);
  assert.equal(ctx.streakPercentile('basket', 'european', 5), null, 'European has no basket');
  assert.equal(ctx.streakPercentile('red', 'meta', 5), null);
  assert.equal(ctx.streakPercentile('red', 'american', undefined), null);
  assert.equal(ctx.streakPercentile('red', 'american', NaN), null);
  assert.equal(ctx.streakPercentile('red', 'american', -1), null);
  assert.equal(ctx.streakPercentile('red', 'american', 0), 0);
  const cumLength = ctx.STREAK_PERCENTILE_DATA.american.red.cum.length;
  assert.equal(ctx.streakPercentile('red', 'american', 100000), ctx.streakPercentile('red', 'american', cumLength));
});

test('percentTag: P and the whole part; an empty tag for no percentile', async () => {
  const { ctx } = await load();
  assert.equal(ctx.percentTag(96.3), 'P96');
  assert.equal(ctx.percentTag(0), 'P0');
  assert.equal(ctx.percentTag(99.9), 'P99');
  assert.equal(ctx.percentTag(null), '');
  assert.equal(ctx.percentTag(undefined), '');
});

// -- Counter setting --

test('Counter shows: Spins by default, one tap flips it, and a saved setting with no key reads as Spins', async () => {
  const { ctx } = await load();
  assert.equal(ctx.defaultSettings().counterShows, 'spins');
  assert.equal(ctx.nextCounterShows('spins'), 'percentile');
  assert.equal(ctx.nextCounterShows('percentile'), 'spins');
  assert.equal(ctx.nextCounterShows(undefined), 'percentile', 'a missing key reads as Spins, so one tap gives Percentile');

  const cur = ctx.getCurrency('USD');
  const sess = plain(ctx.newSession('american', 500));
  const page = (settings) => render('SettingsPage', {
    settings, updSettings: NOOP, setCurrencyOpen: NOOP, currency: 'USD', cur, updSess: NOOP, sess,
    setChangelogOpen: NOOP, updApp: NOOP, importJSON: NOOP, setHardResetOpen: NOOP,
  });
  const buttonAfter = (html, label) => html.slice(html.indexOf(label)).match(/>(Spins|Percentile|ON|OFF)<\/button>/)[1];
  const legacy = await page({ currency: 'USD', defaultBuyIn: 100, onboarded: true, vibration: true, tableMinBet: 10, tableMaxBet: 500, tableMaxTotal: 10000 });
  const chosen = await page({ ...ctx.defaultSettings(), counterShows: 'percentile' });
  assert.equal(buttonAfter(legacy, 'Counter shows'), 'Spins');
  assert.equal(buttonAfter(chosen, 'Counter shows'), 'Percentile');
  assert.ok(legacy.indexOf('Head start for unseen numbers') < legacy.indexOf('Counter shows'), 'the row sits under Head start');
  const secondary = await readFile(new URL('components/SecondaryPages.jsx', SRC), 'utf8');
  assert.match(secondary, /s\.settings\.counterShows=nextCounterShows\(s\.settings\.counterShows\)/, 'the tap runs the one toggle');
});

// -- NumberDrought: Percentile mode --

test('NumberDrought: Percentile mode shows the P-value in the same reserved slot as the count; the estimate keeps its ~', async () => {
  const { ctx } = await load();
  const droughts = Object.fromEntries(ctx.getWheelNumbers('american').map((n) => [n, 0]));
  droughts['17'] = 30;
  const base = { droughts, spins: ['5'], wheelSize: 38, headStart: false, on: true };
  const spinsHtml = await render('NumberDrought', { num: '17', view: base });
  const pctHtml = await render('NumberDrought', { num: '17', view: { ...base, counter: 'percentile', wheel: 'american' } });
  const slotOf = (html) => html.match(/^<div[^>]*>/)[0];
  assert.equal(slotOf(pctHtml), slotOf(spinsHtml), 'the same reserved slot in both modes');
  assert.match(spinsHtml, />30<\/div>$/);
  const expected = 'P' + Math.floor(ctx.streakPercentile('straight:17', 'american', 30));
  assert.match(pctHtml, new RegExp(`>${expected}<\\/div>$`));

  // An unseen number with the head start on: its estimate (0 + 38) is the length, and the ~ stays.
  const estimate = { ...base, droughts: { ...droughts, '17': 0 }, spins: [], headStart: true, counter: 'percentile', wheel: 'american' };
  const estimateHtml = await render('NumberDrought', { num: '17', view: estimate });
  const estimatePct = 'P' + Math.floor(ctx.streakPercentile('straight:17', 'american', 38));
  assert.match(estimateHtml, new RegExp(`>~${estimatePct}<\\/div>$`));

  // No wheel named: the Spins text, so a view that does not ask for the percentile is unchanged.
  const noWheel = await render('NumberDrought', { num: '17', view: { ...base, counter: 'percentile' } });
  assert.match(noWheel, />30<\/div>$/);
});

// -- DroughtPanel and the section tiles: each reading in a reserved slot --

// The markup with only each value's text and visibility normalised. Two renders that compare equal through this have the
// same reserved slots, sizes and structure; only the values and their visibility differ.
// Colours follow the tier (a value), and a tile's aria-label carries its values, so both are normalised too.
const sameSlots = (h) => h
  .replace(/ aria-hidden="true"/g, '')
  .replace(/aria-label="[^"]*"/g, '')
  .replace(/color:#[0-9a-fA-F]{3,6}/g, 'color:#')
  .replace(/visibility:(hidden|visible)/g, 'visibility')
  .replace(/P\d+<\/span>/g, 'P#</span>')
  .replace(/>[^<]*%</g, '>#%<');

test('DroughtPanel: each even-money count shows its percentile, and a missing one keeps its slot', async () => {
  const em = (key, label, drought, pct) => ({ key, label, color: '#ef4444', drought, pct });
  const emWith = [em('red', 'Red', 3, 42.7), em('black', 'Black', 9, 77.1)];
  const emWithout = emWith.map((e) => ({ ...e, pct: null }));
  const shown = await render('DroughtPanel', { emDroughts: emWith, dozD: [1, 2, 3], colD: [4, 5, 6], dozP: [42.7, 7.2, 99.9], colP: [88.4, null, 12.6] });
  const hidden = await render('DroughtPanel', { emDroughts: emWithout, dozD: [1, 2, 3], colD: [4, 5, 6], dozP: [null, null, null], colP: [null, null, null] });
  assert.match(shown, />3<span style="[^"]*visibility:visible[^"]*">P42<\/span>/, 'even money: the count and its percentile');
  assert.match(shown, />9<span style="[^"]*visibility:visible[^"]*">P77<\/span>/);
  assert.match(hidden, />3<span aria-hidden="true" style="[^"]*visibility:hidden[^"]*">P99<\/span>/, 'a missing percentile is hidden, its width kept');
  assert.equal(sameSlots(hidden), sameSlots(shown), 'with and without percentiles, the same markup apart from the values and visibility');
});

test('DroughtPanel: each dozen and column tile shows its streak percentile in a reserved row, and a missing one keeps its slot', async () => {
  const em = (key, label, drought, pct) => ({ key, label, color: '#ef4444', drought, pct });
  const emWith = [em('red', 'Red', 3, 42.7), em('black', 'Black', 9, 77.1)];
  const shown = await render('DroughtPanel', { emDroughts: emWith, dozD: [1, 2, 3], colD: [4, 5, 6], dozP: [42.7, 7.2, 99.9], colP: [88.4, null, 12.6] });
  const hidden = await render('DroughtPanel', { emDroughts: emWith.map((e) => ({ ...e, pct: null })), dozD: [1, 2, 3], colD: [4, 5, 6], dozP: [null, null, null], colP: [null, null, null] });
  assert.equal(shown.match(/aria-haspopup="dialog"/g).length, 6, 'three dozen tiles and three column tiles, each a button that opens its detail');
  for (const pct of ['42.7%', '7.2%', '99.9%', '88.4%', '12.6%']) assert.ok(shown.includes('>' + pct + '<'), `tile shows ${pct}`);
  assert.equal(shown.match(/height:152px;/g).length, 6, 'every tile has the same fixed height');
  assert.match(shown, /aria-hidden="true" style="[^"]*visibility:hidden[^"]*">P98<\/span>/, 'a missing tier is hidden, its width kept');
  assert.match(shown, />P98<\/span>/, 'the tier of 99.9 shows its corner badge');
  assert.match(shown, />P75<\/span>/, 'the tier of 88.4 in a column shows its badge');
  assert.equal(sameSlots(hidden), sameSlots(shown), 'the same panel with and without the percentiles');
});


test('the Counter setting changes what each number shows, on the roulette board and the progression grid, on both wheels', async () => {
  for (const roulette of WHEELS) {
    const { ctx, sess } = await fixture(roulette);
    const nums = ctx.getWheelNumbers(roulette);
    sess.droughts = Object.fromEntries(nums.map((n, i) => [n, i * 2 + 1]));
    sess.spins = ['17', '0'];
    // What a number should show. Spins: its count, and an unseen number's head start as "~" plus the wheel size.
    // Percentile: the percentile of that same length, read from this number's table on this wheel.
    const expected = (label, mode) => {
      const unseen = !sess.spins.includes(label);
      const length = sess.droughts[label] + (unseen ? nums.length : 0);
      const text = mode === 'percentile'
        ? ctx.percentTag(ctx.streakPercentile('straight:' + label, roulette, length))
        : String(length);
      return (unseen ? '~' : '') + text;
    };
    const stripCounterText = (h) => h.replace(new RegExp(`(<div style="${SLOT}[^"]*">)[^<]*(</div>)`, 'g'), '$1$2');

    // The default reads as Spins; one tap of the Settings button gives Percentile.
    const settings = plain(ctx.defaultSettings());
    const spinsSetting = settings.counterShows;
    settings.counterShows = ctx.nextCounterShows(spinsSetting);
    const percentileSetting = settings.counterShows;
    assert.equal(spinsSetting, 'spins');
    assert.equal(percentileSetting, 'percentile');

    const boards = {
      board: { name: 'RouletteBoard', props: (counterShows) => boardProps(sess, { showDroughts: true, headStart: true, counterShows }), pairs: boardPairs },
      grid: { name: 'FibGrid', props: (counterShows) => fibProps(sess, { showDroughts: true, headStart: true, counterShows }), pairs: fibPairs },
    };
    // The wheel's own pockets only. FibGrid's zeros row takes the wheel's own zeros, so a European grid has no 00 counter.
    const onWheel = (pairs) => pairs.filter(([label]) => nums.includes(label));
    for (const [kind, { name, props, pairs }] of Object.entries(boards)) {
      const htmlSpins = await render(name, props(spinsSetting));
      const htmlPct = await render(name, props(percentileSetting));
      const spinsPairs = pairs(htmlSpins);
      const pctPairs = pairs(htmlPct);
      assert.equal(spinsPairs.length, nums.length, `${roulette} ${kind}: one counter per pocket of this wheel, and no 00 on European`);
      assert.equal(onWheel(spinsPairs).length, nums.length, `${roulette} ${kind}: one counter per pocket on this wheel`);
      assert.equal(onWheel(pctPairs).length, nums.length, `${roulette} ${kind}: one counter per pocket, Percentile`);
      for (const [label, value] of onWheel(spinsPairs)) assert.equal(value, expected(label, 'spins'), `${roulette} ${kind} ${label}, Spins`);
      for (const [label, value] of onWheel(pctPairs)) assert.equal(value, expected(label, 'percentile'), `${roulette} ${kind} ${label}, Percentile`);
      assert.notDeepEqual(onWheel(pctPairs).map(([, v]) => v), onWheel(spinsPairs).map(([, v]) => v), `${roulette} ${kind}: the setting changes the text`);
      assert.equal(stripCounterText(htmlPct), stripCounterText(htmlSpins), `${roulette} ${kind}: only the counter text differs between the modes`);
      assert.deepEqual(pairs(await render(name, props(undefined))), spinsPairs, `${roulette} ${kind}: a saved setting with no key reads as Spins`);
    }
  }
});

test('wiring: every roulette board and progression grid in the app receives the Counter setting, and every drought panel its percentiles', async () => {
  let boards = 0;
  for (const file of ['App.jsx', 'components/GamePage.jsx']) {
    const text = await readFile(new URL(file, SRC), 'utf8');
    for (const m of text.matchAll(/<(RouletteBoard|FibGrid)\b/g)) {
      const tag = text.slice(m.index, text.indexOf('/>', m.index));
      assert.match(tag, /counterShows=\{settings\.counterShows\}/, `${file} ${m[1]} at ${m.index}`);
      boards += 1;
    }
    for (const m of text.matchAll(/<DroughtPanel\b[^>]*\/>/g)) {
      assert.match(m[0], /dozP=\{dozP\} colP=\{colP\}/, `${file} DroughtPanel`);
    }
  }
  assert.equal(boards, 3, 'two boards in App and one in GamePage');
});

// -- Stats table --

test('Streak percentiles table: every bet on the current wheel with P50 to P98, and the simulation size and seed in small print', async () => {
  const { ctx } = await load();
  const rowsOf = (html) => (html.match(/<tr>/g) || []).length - 1;
  const american = await render('StreakPercentileTable', { wheel: 'american' });
  const european = await render('StreakPercentileTable', { wheel: 'european' });
  assert.equal(rowsOf(american), betCategories('american').length);
  assert.equal(rowsOf(european), betCategories('european').length);
  assert.match(american, />Basket 0, 00, 1, 2, 3</);
  assert.doesNotMatch(european, /Basket/);
  for (const label of ['P50', 'P75', 'P90', 'P95', 'P98']) assert.match(american, new RegExp(`>${label}<`));

  const cells = (html, label) => {
    const start = html.indexOf(`>${label}</td>`);
    assert.ok(start >= 0, label);
    // The slice starts at the label's text, so the first cell matched is the P50 cell.
    const row = html.slice(start, html.indexOf('</tr>', start));
    return [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => Number(m[1]));
  };
  // The table's arrays are from the sandbox realm, so they are copied into this one before the comparison.
  assert.deepEqual(cells(american, 'Red'), [...ctx.STREAK_PERCENTILE_DATA.american.red.p]);
  assert.deepEqual(cells(european, '#17'), [...ctx.STREAK_PERCENTILE_DATA.european['straight:17'].p]);
  assert.match(american, /1,000 sessions x 1,000,000 spins per wheel/);
  assert.ok(american.includes(SEED_LABEL), 'the seed label is printed');
  const secondary = await readFile(new URL('components/SecondaryPages.jsx', SRC), 'utf8');
  const stats = secondary.slice(secondary.indexOf('function StatsPage('), secondary.indexOf('function SettingsPage('));
  assert.match(stats, /<StreakPercentileTable wheel=\{sess\.roulette\}\/>/, 'the Stats page mounts the table on the current wheel');
});

// -- Build --

test('build: the table and its lookup compile before NumberDrought.jsx, and the built bundle contains them', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const output = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('streak-percentiles.js') > 0, 'the table is in the FILES list');
  assert.ok(at('streak-percentiles.js') < at('percentile.js'));
  assert.ok(at('percentile.js') < at('components/NumberDrought.jsx'));
  assert.match(output, /var STREAK_PERCENTILE_DATA ?= ?\{/, 'babel may compact the spacing');
  assert.match(output, /function streakPercentile\(/);
  assert.match(output, /function PercentTag\(/);
});

test('no odds or house-edge commentary in the new code, its comments or the generated header', async () => {
  const files = [
    '../nexus-src/src/percentile.js',
    '../tools/gen-streak-percentiles.mjs',
    '../nexus-src/src/components/NumberDrought.jsx',
    '../nexus-src/src/components/DroughtPanel.jsx',
    '../nexus-src/src/streak-percentiles.js',
  ];
  for (const f of files) {
    const text = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /house[ -]edge|\bodds\b|expected value|expected return/i, f);
  }
});
