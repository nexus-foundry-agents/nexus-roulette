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
  MAX_TLV, PERCENTILES, SEED_LABEL, WHEELS, avgTenths as generatorAvgTenths, fnv1a32, pocketLabels, renderModule,
  runShard, sessionState, sectionMembership, simulate, winTable, xoshiroNext,
} from '../tools/gen-streak-percentiles.mjs';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const GENERATED = new URL('streak-percentiles.js', SRC);
const plain = (value) => JSON.parse(JSON.stringify(value));
const NOOP = () => {};

// The files the bundle concatenates ahead of what these tests render, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'streak-percentiles.js', 'percentile.js', 'tlv.js',
  'roulette-bets.mjs', 'components/NumberDrought.jsx', 'components/ui.jsx', 'components/grids.jsx',
  'components/TlvSparkline.jsx', 'components/SectionTile.jsx', 'components/DroughtPanel.jsx',
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

// The shared Modal from ui.jsx, transpiled from source against a stand-in React (as modal-backdrop.test.mjs does), so its
// own press handling runs. Only the handlers are called, so no real rendering happens.
async function loadModalHarness() {
  const source = await readFile(new URL('components/ui.jsx', SRC), 'utf8');
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: 'ui.jsx',
    presets: [[presetReact, { runtime: 'classic' }]],
  });
  const stand = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useRef: (current) => ({ current }),
  };
  return new Function('React', `${code}\nreturn Modal;`)(stand);
}

// Every element in an element tree whose type matches, depth first.
function findAll(node, pred, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => findAll(n, pred, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (node.type !== undefined && pred(node)) out.push(node);
  if (node.props && node.props.children !== undefined) findAll(node.props.children, pred, out);
  return out;
}

// Spins as the app records them, from a seeded generator: pocket labels of the wheel.
function randomSpins(wheel, count, sessionIndex = 0) {
  const tbl = winTable(wheel);
  const state = sessionState(fnv1a32(SEED_LABEL), WHEELS.indexOf(wheel), sessionIndex);
  const out = [];
  for (let i = 0; i < count; i++) out.push(tbl.labels[Math.floor((xoshiroNext(state) * tbl.nP) / 4294967296)]);
  return out;
}

// The loss level of every pocket as the app keeps it: every number goes up one, and the number that hits goes to zero.
function applySpin(droughts, label) {
  for (const k of Object.keys(droughts)) droughts[k] = k === label ? 0 : droughts[k] + 1;
  return droughts;
}
const zeroDroughts = (wheel) => Object.fromEntries(pocketLabels(wheel).map((l) => [l, 0]));

// The count of consecutive spins at the end that the section missed.
function trailingMisses(spins, numbers) {
  let k = 0;
  for (let i = spins.length - 1; i >= 0 && !numbers.includes(String(spins[i])); i--) k += 1;
  return k;
}

// -- The TLV update, by hand --

test('tlvAfterSpin: a miss adds 12, and a hit adds 11 minus the loss level of the number that hit', async () => {
  const { ctx } = await load();
  assert.equal(ctx.tlvAfterSpin(100, false, 0), 112, 'a miss: each of the 12 numbers gains one');
  assert.equal(ctx.tlvAfterSpin(100, false, 30), 112, 'a miss ignores the loss levels');
  assert.equal(ctx.tlvAfterSpin(0, true, 0), 11, 'the first hit: the other 11 numbers were at 0 and each gain one');
});

test('tlvAfterSpin: a hit by the coldest number gives the largest drop; a repeat hit by a 0-level number gives +11', async () => {
  const { ctx } = await load();
  const drop = (loss) => 100 - ctx.tlvAfterSpin(100, true, loss);
  assert.equal(drop(30), 19, 'hit by a number at loss level 30: 100 + 11 - 30 = 81');
  assert.equal(drop(5), -6, 'hit by a number at loss level 5: 100 + 11 - 5 = 106');
  assert.ok(drop(30) > drop(12) && drop(12) > drop(5), 'the drop grows with the loss level of the number that hit');
  assert.equal(ctx.tlvAfterSpin(100, true, 0), 111, 'a repeat hit by a number at 0: +11');
});

test('section readings: TLV is the sum of the 12 loss levels; average is TLV / 12 to one decimal; the maximum is the coldest, first on a tie', async () => {
  const { ctx } = await load();
  const dozen0 = plain(ctx.sectionNumbers('dozen', 0));
  assert.deepEqual(dozen0, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  assert.deepEqual(plain(ctx.sectionNumbers('column', 0)), ['1', '4', '7', '10', '13', '16', '19', '22', '25', '28', '31', '34']);
  assert.deepEqual(plain(ctx.sectionNumbers('column', 2)), ['3', '6', '9', '12', '15', '18', '21', '24', '27', '30', '33', '36']);
  assert.equal(ctx.sectionTLV({ '1': 3, '2': 4 }, dozen0), 7, 'the numbers not listed count as 0');
  assert.equal(ctx.sectionAvg(444), 37, '444 / 12');
  assert.equal(ctx.sectionAvg(445), 37.1, '445 / 12 is 37.08..., to one decimal 37.1');
  assert.equal(ctx.sectionAvg(446), 37.2, '446 / 12 is 37.17..., to one decimal 37.2');
  assert.deepEqual(plain(ctx.sectionMax({ '1': 5, '7': 9, '12': 9 }, dozen0)), { loss: 9, number: '7' }, 'the first of the two 9s');
  assert.deepEqual(plain(ctx.sectionMax({}, dozen0)), { loss: 0, number: '1' }, 'no losses: 0, on the first number');
  assert.deepEqual(plain(ctx.sectionMax({}, [])), { loss: 0, number: null }, 'an empty section has no coldest number');
});

test('the TLV history by hand: each spin of a dozen run from the first spin, and the TLV the loss levels give', async () => {
  const { ctx } = await load();
  const dozen0 = plain(ctx.sectionNumbers('dozen', 0));
  // Spin 1 hits 1 (TLV 11). Spin 2 hits 2, whose loss level was 1: 11 + 11 - 1 = 21. Spin 3 hits 13, a miss: 33.
  const series = plain(ctx.tlvSeries(['1', '2', '13'], dozen0));
  assert.deepEqual(series, [11, 21, 33]);
  const droughts = { '1': 2, '2': 1, '3': 3, '4': 3, '5': 3, '6': 3, '7': 3, '8': 3, '9': 3, '10': 3, '11': 3, '12': 3 };
  assert.equal(ctx.sectionTLV(droughts, dozen0), series[series.length - 1], 'the history ends where the loss levels sum');
});

test('the TLV history across a streak: from the spin that began it, and the last 50 spins when there is no streak', async () => {
  const { ctx } = await load();
  const dozen0 = plain(ctx.sectionNumbers('dozen', 0));
  // Hit at spin 1 (TLV 11), then three misses: 23, 35, 47. The losing streak is 3, and it began at spin 1.
  const series = plain(ctx.tlvSeries(['5', '20', '21', '22'], dozen0));
  assert.deepEqual(series, [11, 23, 35, 47]);
  const streak = trailingMisses(['5', '20', '21', '22'], dozen0);
  assert.equal(streak, 3);
  const window = plain(ctx.tlvWindow(series, streak));
  assert.deepEqual(window.values, [11, 23, 35, 47], 'since the streak began, from its hit spin to now');
  assert.equal(window.start, 0);

  // Sixty misses, then a hit: no streak, so the history is the last 50 spins.
  const long = [...Array(60).fill('20'), '5'];
  const longSeries = plain(ctx.tlvSeries(long, dozen0));
  assert.equal(longSeries[longSeries.length - 1], 671, 'the hit by a number at 60: 720 + 11 - 60');
  assert.equal(trailingMisses(long, dozen0), 0);
  const fallback = plain(ctx.tlvWindow(longSeries, 0));
  assert.equal(fallback.values.length, 50);
  assert.equal(fallback.start, 11);
  assert.equal(fallback.values[0], 144, 'the 12th spin: 12 misses at 12 each');
  assert.equal(fallback.values[49], 671);

  // Sixty misses and no hit at all: the streak is the whole session, and its history starts at the first spin.
  const none = Array(60).fill('20');
  const noneSeries = plain(ctx.tlvSeries(none, dozen0));
  const whole = plain(ctx.tlvWindow(noneSeries, trailingMisses(none, dozen0)));
  assert.equal(whole.values.length, 60);
  assert.equal(whole.start, 0);
});

test('the TLV history matches the loss levels after every spin, on both wheels, for every section', async () => {
  const { ctx } = await load();
  for (const wheel of WHEELS) {
    const spins = randomSpins(wheel, 2000, 1);
    const sections = [];
    for (const kind of ['dozen', 'column']) for (let i = 0; i < 3; i++) sections.push({ kind, i, numbers: ctx.sectionNumbers(kind, i) });
    const series = sections.map((s) => ctx.tlvSeries(spins, s.numbers));
    const droughts = zeroDroughts(wheel);
    spins.forEach((label, t) => {
      applySpin(droughts, label);
      sections.forEach((s, k) => {
        assert.equal(series[k][t], ctx.sectionTLV(droughts, s.numbers), `${wheel} ${s.kind} ${s.i} after spin ${t + 1}`);
      });
    });
  }
});

// -- Tiers --

test('tier mapping: the badge shows the highest of P25, P50, P75, P95 and P98 a percentile has reached', async () => {
  const { ctx } = await load();
  const cases = [[0, null], [24.9, null], [25, 25], [49.9, 25], [50, 50], [74.9, 50], [75, 75], [90, 75], [94.9, 75], [95, 95],
    [97.9, 95], [98, 98], [99.9, 98], [100, 98]];
  for (const [pct, tier] of cases) assert.equal(ctx.percentileTier(pct), tier, `percentile ${pct}`);
  assert.equal(ctx.percentileTier(null), null, 'no percentile, no tier');
  assert.equal(ctx.percentileTier(undefined), null);
  assert.equal(ctx.percentileTier(NaN), null);
  assert.equal(ctx.tierTag(75), 'P75');
  assert.equal(ctx.tierTag(null), '');
});

test('the tile figures are tested against the generated tables: the TLV and average tiers and the single-number P95 count', async () => {
  const { ctx } = await load();
  const table = ctx.STREAK_PERCENTILE_DATA;
  for (const kind of ['dozen', 'column']) {
    const tlvP = table.tlv.american[kind].p;
    const avgP = table.avg.american[kind].p;
    assert.equal(tlvP.length, PERCENTILES.length);
    const at = (v) => ctx.distPercentile(table.tlv.american[kind], v);
    assert.ok(at(tlvP[1]) >= 50 && at(tlvP[1] - 1) < 50, `${kind} TLV: P50 reads at least 50, the value below reads below`);
    assert.ok(at(tlvP[5]) >= 98 && at(tlvP[5] - 1) < 98, `${kind} TLV: P98 reads at least 98, the value below reads below`);
    const avgAt = (tenths) => ctx.distPercentile(table.avg.american[kind], tenths);
    assert.ok(avgAt(Math.round(avgP[2] * 10)) >= 75, `${kind} average: P75 reads at least 75`);
    assert.ok(avgAt(Math.round(avgP[2] * 10) - 1) < 75, `${kind} average: the tenth below P75 reads below 75`);
  }
  // The count at or above the single-number P95: a number at its P95 length counts, and one just below it does not.
  const p95 = table.american['straight:2'].p[4];
  const p98 = table.american['straight:5'].p[5];
  const droughts = { '2': p95, '3': p95 - 1, '5': p98 };
  assert.equal(ctx.coldCount(droughts, ['2', '3', '5', '9'], 'american'), 2, 'the numbers at P95 and at P98 count; the one below P95 does not');
  assert.equal(ctx.coldCount({}, ['1', '2'], 'american'), 0, 'no losses, no count');
});

test('the generated section tables: the same P25 to P98 set as the streak tables, ascending, with cumulative shares reaching 99.99%', async () => {
  const table = plain(vm.runInNewContext(`${await readFile(GENERATED, 'utf8')}\nSTREAK_PERCENTILE_DATA`, {}));
  assert.deepEqual(table.meta.percentiles, [25, 50, 75, 90, 95, 98]);
  for (const block of ['tlv', 'avg']) {
    for (const wheel of WHEELS) {
      for (const kind of ['dozen', 'column']) {
        const e = table[block][wheel][kind];
        const where = `${block} ${wheel} ${kind}`;
        assert.equal(e.p.length, PERCENTILES.length, where);
        for (let i = 1; i < e.p.length; i++) assert.ok(e.p[i] >= e.p[i - 1], `${where}: values rise`);
        for (let i = 1; i < e.cum.length; i++) assert.ok(e.cum[i] >= e.cum[i - 1], `${where}: cumulative never falls`);
        const last = e.cum[e.cum.length - 1];
        assert.ok(last >= 999900 && last <= 1000000, `${where}: reaches 99.99%`);
        assert.equal(e.n, 3000000000, `${where}: every spin of the run, for each of the three sections of its type`);
      }
    }
  }
  assert.ok(table.tlv.american.dozen.p[0] > 0);
  assert.ok(table.avg.european.column.p[5] < 100, 'the average is in loss levels, not tenths');
});

// -- The generator --

test('generator: the TLV sampled after every spin equals a direct count of the loss levels, on both wheels', () => {
  const master = fnv1a32(SEED_LABEL);
  for (const wheel of WHEELS) {
    const sessions = 3;
    const spins = 30000;
    const got = runShard({ master, sessions, spins, wheels: [wheel], shard: 0, shards: 1 });
    const labels = pocketLabels(wheel);
    const member = sectionMembership(wheel);
    const ref = new Float64Array(2 * MAX_TLV);
    for (let s = 0; s < sessions; s++) {
      const tbl = winTable(wheel);
      const state = sessionState(master, WHEELS.indexOf(wheel), s);
      const droughts = zeroDroughts(wheel);
      for (let i = 0; i < spins; i++) {
        const label = tbl.labels[Math.floor((xoshiroNext(state) * tbl.nP) / 4294967296)];
        applySpin(droughts, label);
        for (let sec = 0; sec < 6; sec++) {
          let tot = 0;
          labels.forEach((l, p) => { if (member[p * 6 + sec] === 1) tot += droughts[l]; });
          ref[(sec < 3 ? 0 : MAX_TLV) + tot] += 1;
        }
      }
    }
    const a = got.tlv[wheel];
    let differ = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== ref[i]) differ += 1;
    assert.equal(differ, 0, `${wheel}: every TLV bin matches the direct count`);
    assert.equal(a.reduce((x, y) => x + y, 0), sessions * spins * 6, 'six samples per spin: three dozens and three columns');
    assert.equal(got.tlvOverflow, 0);
  }
});

test('generator: the average rounding in the generator and in the app is the same function', async () => {
  const { ctx } = await load();
  for (let tlv = 0; tlv <= 2000; tlv++) {
    assert.equal(ctx.avgTenths(tlv), generatorAvgTenths(tlv), `TLV ${tlv}`);
  }
});

test('generator: the module text has the section tables for both wheels and the P25 to P98 set', async () => {
  const reduced = await simulate({ sessions: 2, spins: 50000, workers: 2 });
  const text = renderModule(reduced, 'fixed');
  assert.match(text, /^\/\/ tlv\[wheel\]\.dozen and \.column:/m, 'the header describes the section tables');
  assert.match(text, /"tlv":\{/);
  assert.match(text, /"avg":\{/);
  assert.doesNotMatch(text, /\bfunction\b|=>/, 'the module is data, not code');
  assert.equal(reduced.tlv.european.dozen.n, 2 * 50000 * 3);
});

// -- Session readings --

test('sectionReadout: the tile figures agree with the session they were read from', async () => {
  const { ctx } = await load();
  for (const wheel of WHEELS) {
    const spins = randomSpins(wheel, 600, 2);
    const droughts = zeroDroughts(wheel);
    spins.forEach((label) => applySpin(droughts, label));
    for (const kind of ['dozen', 'column']) {
      for (let i = 0; i < 3; i++) {
        const numbers = ctx.sectionNumbers(kind, i);
        const streak = trailingMisses(spins, numbers);
        const r = ctx.sectionReadout({ kind, index: i, wheel, spins, droughts, streak }, undefined);
        const where = `${wheel} ${kind} ${i}`;
        assert.equal(r.tlv, ctx.sectionTLV(droughts, numbers), `${where}: TLV is the sum of the loss levels`);
        assert.equal(r.tlv, r.series[r.series.length - 1], `${where}: and the history ends on it`);
        assert.equal(r.series.length, spins.length, `${where}: one TLV per spin`);
        assert.equal(r.windowValues[r.windowValues.length - 1], r.tlv, `${where}: the sparkline ends on the TLV`);
        assert.equal(r.max, ctx.sectionMax(droughts, numbers).loss, `${where}: the maximum`);
        assert.equal(r.cold, ctx.coldCount(droughts, numbers, wheel), `${where}: the count at P95`);
        assert.equal(r.perNumber.length, 12, `${where}: the twelve numbers`);
        for (let k = 1; k < r.perNumber.length; k++) {
          assert.ok(r.perNumber[k - 1].loss >= r.perNumber[k].loss, `${where}: coldest first`);
        }
        assert.equal(r.avg, ctx.sectionAvg(r.tlv), `${where}: average`);
        assert.equal(r.streak, streak);
        assert.equal(r.shadeFrom, streak > 0 ? spins.length - 1 - streak : null);
      }
    }
  }
});

// -- Tile and detail layout --

test('SectionTile: the same tile with values and without has the same reserved rows and the same heights', async () => {
  const { ctx } = await load();
  const wheel = 'american';
  const numbers = ctx.sectionNumbers('dozen', 0);
  const spins = randomSpins(wheel, 300, 3);
  const droughts = zeroDroughts(wheel);
  spins.forEach((label) => applySpin(droughts, label));
  const full = ctx.sectionReadout({ kind: 'dozen', index: 0, wheel, spins, droughts, streak: trailingMisses(spins, numbers) }, undefined);
  const empty = ctx.sectionReadout({ kind: 'dozen', index: 0, wheel, spins: [], droughts: zeroDroughts(wheel), streak: 0 }, undefined);
  const html = (r) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionTile, { r, onOpen: NOOP }));
  const withValues = html(full);
  const withoutValues = html(empty);
  // Colours follow the tier, which is a value, so they are normalised with the text; the layout is what is compared.
  const slotsOnly = (h) => h
    .replace(/aria-label="[^"]*"/g, '')
    .replace(/color:#[0-9a-fA-F]{3,6}/g, 'color:#')
    .replace(/<polyline[^>]*>(<\/polyline>)?/g, '')
    .replace(/<circle[^>]*>(<\/circle>)?/g, '')
    .replace(/ aria-hidden="true"/g, '')
    .replace(/visibility:(hidden|visible)/g, 'visibility')
    .replace(/>[^<]+</g, '>#<');
  assert.equal(slotsOnly(withValues), slotsOnly(withoutValues), 'the same reserved slots, with the values and their visibility the only difference');
  const heights = (h) => h.match(/height:[\d.]+px/g);
  assert.deepEqual(heights(withValues), heights(withoutValues), 'every row keeps its height as values change');
  assert.match(withValues, /<button type="button" aria-haspopup="dialog"/, 'one button, which opens the detail view');
  assert.match(withValues, /overflow:hidden/, 'the tile clips rather than grows');
  assert.ok(withValues.includes('height:152px'), 'the tile has its fixed height');
});

test('SectionDetail: the twelve numbers, coldest first, with each loss level and single-number percentile, and the count at P95', async () => {
  const { ctx } = await load();
  const wheel = 'european';
  const spins = randomSpins(wheel, 800, 4);
  const droughts = zeroDroughts(wheel);
  spins.forEach((label) => applySpin(droughts, label));
  const numbers = ctx.sectionNumbers('column', 1);
  const r = ctx.sectionReadout({ kind: 'column', index: 1, wheel, spins, droughts, streak: trailingMisses(spins, numbers) }, undefined);
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionDetail, { r, onClose: NOOP }));
  const rows = html.split('height:24px;line-height:24px').slice(1).map((chunk) =>
    [...chunk.matchAll(/<div[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]).slice(0, 4));
  assert.equal(rows.length, 12, 'twelve rows');
  assert.deepEqual(rows.map((row) => row[0]).sort((a, b) => +a - +b), [...numbers].sort((a, b) => +a - +b), 'the section\'s own numbers');
  assert.deepEqual(rows.map((row) => +row[1]), plain(r.perNumber.map((row) => row.loss)), 'coldest first, as the readout orders them');
  assert.equal(rows[0][0], r.perNumber[0].number);
  assert.match(html, new RegExp(`${r.cold} of 12`), 'the count at or above P95');
  assert.match(html, /Losing streak/);
  assert.match(html, /Average loss level/);
  assert.match(html, /Maximum loss level/);
  assert.match(html, /TLV after each spin of this session/);
  assert.match(html, /stroke-dasharray="3 3"/, 'the reference lines are drawn');
  assert.match(html, />P98</, 'the reference line label at P98');
});

test('SectionDetail: the streak is shaded in the session chart while a streak is running, and not when none is', async () => {
  const { ctx } = await load();
  const numbers = ctx.sectionNumbers('dozen', 2);
  const spins = ['1', '2', '25', '26', '27'];
  const droughts = zeroDroughts('american');
  spins.forEach((label) => applySpin(droughts, label));
  const running = ctx.sectionReadout({ kind: 'dozen', index: 2, wheel: 'american', spins, droughts, streak: trailingMisses(spins, numbers) }, undefined);
  assert.equal(running.streak, 0, 'the last spin is 27, in the third dozen');
  const html = (r) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionDetail, { r, onClose: NOOP }));
  assert.doesNotMatch(html(running), /fill-opacity="0.16"/, 'no streak, no shading');
  const r2 = ctx.sectionReadout({ kind: 'dozen', index: 0, wheel: 'american', spins, droughts, streak: trailingMisses(spins, ctx.sectionNumbers('dozen', 0)) }, undefined);
  assert.equal(r2.streak, 3);
  assert.match(html(r2), /fill-opacity="0.16"/, 'a running streak is shaded');
});

// -- The drought panel: opening and closing --

test('a tap on a section tile opens its detail in the shared Modal, which closes from its backdrop and from Close', async () => {
  const { ctx } = await load();
  const wheel = 'american';
  const spins = randomSpins(wheel, 400, 5);
  const droughts = zeroDroughts(wheel);
  spins.forEach((label) => applySpin(droughts, label));
  const props = {
    emDroughts: [], dozD: [0, 0, 0], colD: [0, 0, 0], dozP: [null, null, null], colP: [null, null, null],
    spins, droughts, roulette: wheel,
  };
  // The bundle's babel commonjs step reads hooks from the React module object (`(0, _react.useState)`), so the stand-in
  // hooks go on that object for the length of this test and are restored after it.
  let state = null;
  const saved = { useState: React.useState, useMemo: React.useMemo };
  React.useState = (init) => [state === null ? init : state, (v) => { state = typeof v === 'function' ? v(state) : v; }];
  React.useMemo = (fn) => fn();
  try {
    const first = ctx.DroughtPanel(props);
    const tiles = findAll(first, (el) => el.type === ctx.SectionTile);
    assert.equal(tiles.length, 6, 'three dozen tiles and three column tiles');
    assert.equal(findAll(first, (el) => el.type === ctx.Modal).length, 0, 'nothing is open at first');

    tiles[0].props.onOpen(tiles[0].props.r.key);
    const opened = ctx.DroughtPanel(props);
    const modals = findAll(opened, (el) => el.type === ctx.Modal);
    assert.equal(modals.length, 1, 'the tap opens one Modal');
    const detail = findAll(modals[0], (el) => el.type === ctx.SectionDetail);
    assert.equal(detail.length, 1, 'the Modal holds the section detail');
    assert.equal(detail[0].props.r.key, 'dozen:0');
    assert.equal(detail[0].props.r.perNumber.length, 12, 'and the twelve numbers');

    // Backdrop: a press that starts and ends on the backdrop closes the Modal, through the shared Modal's own handlers.
    const Modal = await loadModalHarness();
    const onClose = modals[0].props.onClose;
    const backdrop = Modal({ onClose, children: null });
    const at = (target) => ({ target, currentTarget: backdrop, button: 0 });
    backdrop.props.onPointerDown(at(backdrop));
    backdrop.props.onPointerUp(at(backdrop));
    backdrop.props.onClick(at(backdrop));
    const afterBackdrop = ctx.DroughtPanel(props);
    assert.equal(findAll(afterBackdrop, (el) => el.type === ctx.Modal).length, 0, 'the backdrop press closed it');

    // A press that starts inside the dialog and is released on the backdrop does not close it.
    ctx.DroughtPanel(props);
    tiles[4].props.onOpen(tiles[4].props.r.key);
    const again = findAll(ctx.DroughtPanel(props), (el) => el.type === ctx.Modal);
    assert.equal(again.length, 1);
    const inside = Modal({ onClose: again[0].props.onClose, children: null });
    inside.props.onPointerDown({ target: { inside: true }, currentTarget: inside, button: 0 });
    inside.props.onPointerUp({ target: inside, currentTarget: inside, button: 0 });
    inside.props.onClick({ target: inside, currentTarget: inside, button: 0 });
    assert.equal(findAll(ctx.DroughtPanel(props), (el) => el.type === ctx.Modal).length, 1, 'a press from inside the dialog does not close it');

    // Close button: the detail's own Close calls the same close.
    const closeProps = findAll(ctx.DroughtPanel(props), (el) => el.type === ctx.SectionDetail)[0].props;
    closeProps.onClose();
    assert.equal(findAll(ctx.DroughtPanel(props), (el) => el.type === ctx.Modal).length, 0, 'Close closes it');
  } finally {
    React.useState = saved.useState;
    React.useMemo = saved.useMemo;
  }
});

// -- Height and wiring --

test('DROUGHT_PANEL_HEIGHT in SpinTools.jsx is the sum of the drought panel\'s fixed rows', async () => {
  const { ctx } = await load();
  const spinTools = await readFile(new URL('components/SpinTools.jsx', SRC), 'utf8');
  const declared = Number(spinTools.match(/const DROUGHT_PANEL_HEIGHT = (\d+);/)[1]);
  assert.equal(declared, ctx.droughtPanelHeight(), 'the reservation matches the rows');
  assert.equal(declared, 367, 'even-money row 44, gap 6, section rule 2 + 1 + 6, two tile rows of 152 and a gap of 4');
});

test('build: the section readings and the tiles compile in the order their dependencies need', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const output = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('percentile.js') < at('tlv.js'), 'tlv.js after the percentile lookup it reads');
  assert.ok(at('tlv.js') < at('components/DroughtPanel.jsx'));
  assert.ok(at('components/TlvSparkline.jsx') < at('components/SectionTile.jsx'));
  assert.ok(at('components/SectionTile.jsx') < at('components/DroughtPanel.jsx'));
  assert.ok(at('components/ui.jsx') < at('components/DroughtPanel.jsx'), 'the shared Modal is loaded before the panel uses it');
  assert.match(output, /function sectionReadout\(/);
  assert.match(output, /function TlvSparkline\(/);
  assert.match(output, /function SectionTile\(/);
  assert.match(output, /var STREAK_PERCENTILE_DATA ?= ?\{/);
});

test('no odds or house-edge commentary in the section readings, the tile, the sparkline or the generator', async () => {
  for (const f of ['tlv.js', 'components/TlvSparkline.jsx', 'components/SectionTile.jsx', 'components/DroughtPanel.jsx']) {
    const text = await readFile(new URL(f, SRC), 'utf8');
    assert.doesNotMatch(text, /house[ -]edge|\bodds\b|expected value|expected return/i, f);
  }
  const gen = await readFile(new URL('../tools/gen-streak-percentiles.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gen, /house[ -]edge|\bodds\b|expected value|expected return/i, 'the generator');
});
