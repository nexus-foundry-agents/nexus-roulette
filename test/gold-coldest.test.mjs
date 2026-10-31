import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// F18: the coldest number of each dozen and column is gold, on the board and on its section tile.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const NOOP = () => {};
const GOLD = '#ffd700';
const OUTLINE_P98 = '#f87171';

// The files the bundle concatenates ahead of what these tests render, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'streak-percentiles.js', 'percentile.js', 'tlv.js',
  'roulette-bets.mjs', 'components/NumberDrought.jsx', 'components/ui.jsx', 'components/grids.jsx', 'components/SecondaryPages.jsx',
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

async function render(name, props) {
  const { ctx } = await load();
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx[name], props));
}

// The number squares of a RouletteBoard element tree, keyed by label. The column and dozen buttons also carry keys, so a
// square is the keyed button whose first child is the number's face, and that face's first child is the label.
function squaresByLabel(node, out = new Map()) {
  if (Array.isArray(node)) { node.forEach((n) => squaresByLabel(n, out)); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (node.key != null && typeof node.props.onClick === 'function') {
    const face = Array.isArray(node.props.children) ? node.props.children[0] : node.props.children;
    if (face && face.props && Array.isArray(face.props.children) && face.props.children[0] === String(node.key)) {
      out.set(String(node.key), node);
    }
  }
  squaresByLabel(node.props.children, out);
  return out;
}

// Every element in an element tree that satisfies the predicate, depth first.
function elementsWhere(node, pred, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => elementsWhere(n, pred, out)); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (pred(node)) out.push(node);
  elementsWhere(node.props.children, pred, out);
  return out;
}

const board = (droughts, extra = {}) => ({
  roulette: 'american', droughts, spins: [], spinning: false, onBet: NOOP, showDroughts: true, ...extra,
});

// The labels the board draws in gold text, and the labels that carry a gold pip. Both sorted.
function goldMarks(ctx, props) {
  const text = [];
  const pips = [];
  for (const [label, square] of squaresByLabel(ctx.RouletteBoard(props))) {
    if (square.props.style.color === GOLD) text.push(label);
    if (elementsWhere(square.props.children, (n) => n.props.style && n.props.style.background === GOLD).length) pips.push(label);
  }
  return { text: text.sort(), pips: pips.sort() };
}

// The coldest numbers of the six sections, worked out by brute force here rather than through sectionColdest.
function bruteColdest(ctx, kind, index, droughts) {
  const numbers = plain(ctx.sectionNumbers(kind, index));
  const loss = (n) => droughts[n] || 0;
  const top = Math.max(...numbers.map(loss));
  return top > 0 ? numbers.filter((n) => loss(n) === top) : [];
}
function expectedGold(ctx, droughts) {
  const out = new Set();
  for (const kind of ['dozen', 'column']) {
    for (let i = 0; i < 3; i++) bruteColdest(ctx, kind, i, droughts).forEach((n) => out.add(n));
  }
  return [...out].sort();
}

// A deterministic set of loss levels with several ties, every number 1 to 36 present.
function spreadDroughts() {
  const droughts = {};
  for (let n = 1; n <= 36; n++) droughts[n] = (n * 7) % 23;
  return droughts;
}

// The shortest losing streak that reads in the top outline band (P98) of this number's single-number percentile.
function lengthAtP98(ctx, label, wheel) {
  for (let len = 0; len <= 400; len += 1) {
    if (ctx.streakPercentile('straight:' + label, wheel, len) >= 98) return len;
  }
  throw new Error(`no length of ${label} on ${wheel} reads at P98`);
}

// -- sectionColdest --

test('sectionColdest: the one coldest number of a dozen, and of a column, with its loss level', async () => {
  const { ctx } = await load();
  assert.deepEqual(plain(ctx.sectionColdest('dozen', 2, { '25': 9, '1': 4, '20': 3 })), { level: 9, numbers: ['25'] }, 'the third dozen');
  // Column 0 holds 1, 4, 7 ... 34; column 2 holds 3, 6, 9 ... 36; column 1 holds 2, 5, 8 ... 35.
  const droughts = { '4': 12, '7': 5, '3': 40 };
  assert.deepEqual(plain(ctx.sectionColdest('column', 0, droughts)), { level: 12, numbers: ['4'] }, 'the first column');
  assert.deepEqual(plain(ctx.sectionColdest('column', 2, droughts)), { level: 40, numbers: ['3'] }, 'the third column');
  assert.deepEqual(plain(ctx.sectionColdest('column', 1, droughts)), { level: 0, numbers: [] }, 'a column with no loss has none');
});

test('sectionColdest: a tie returns every tied number, in list order', async () => {
  const { ctx } = await load();
  assert.deepEqual(plain(ctx.sectionColdest('dozen', 0, { '11': 8, '3': 8, '5': 2 })), { level: 8, numbers: ['3', '11'] });
  assert.deepEqual(plain(ctx.sectionColdest('column', 1, { '2': 6, '35': 6, '5': 6, '8': 1 })), { level: 6, numbers: ['2', '5', '35'] });
});

test('sectionColdest: when the highest loss level is 0 there is no coldest number, for every section', async () => {
  const { ctx } = await load();
  for (const kind of ['dozen', 'column']) {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(plain(ctx.sectionColdest(kind, i, {})), { level: 0, numbers: [] }, `${kind} ${i} with no droughts`);
      assert.deepEqual(plain(ctx.sectionColdest(kind, i, { '1': 0, '2': 0 })), { level: 0, numbers: [] }, `${kind} ${i} with zeros`);
    }
  }
});

test('sectionColdest: 0 and 00 are never in a section, however cold they are, and the board never marks them', async () => {
  const { ctx } = await load();
  const droughts = { '0': 90, '00': 95 };
  for (const kind of ['dozen', 'column']) {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(plain(ctx.sectionColdest(kind, i, droughts)), { level: 0, numbers: [] }, `${kind} ${i}`);
      assert.ok(!plain(ctx.sectionNumbers(kind, i)).some((n) => n === '0' || n === '00'), `${kind} ${i} lists no zero`);
    }
  }
  assert.deepEqual(plain(ctx.coldestGoldNumbers(droughts)), {}, 'no zero is gold');
  assert.deepEqual(goldMarks(ctx, board(droughts, { coldestGold: true })), { text: [], pips: [] }, 'nor on the board');
});

// -- The board --

test('coldestGoldNumbers: the union of the six sections\' coldest numbers, and nothing else', async () => {
  const { ctx } = await load();
  const droughts = spreadDroughts();
  assert.deepEqual(Object.keys(plain(ctx.coldestGoldNumbers(droughts))).sort(), expectedGold(ctx, droughts));
});

test('the board marks gold exactly the union of the six sections\' coldest numbers, as text and as a pip', async () => {
  const { ctx } = await load();
  const droughts = spreadDroughts();
  const want = expectedGold(ctx, droughts);
  assert.ok(want.length >= 2, `more than one coldest number to mark (${want.length})`);
  const marks = goldMarks(ctx, board(droughts, { coldestGold: true }));
  assert.deepEqual(marks.text, want, 'gold text');
  assert.deepEqual(marks.pips, want, 'gold pips');
});

test('gold follows the droughts: a spin, an undo and a correction each move it, because the board reads droughts on every render', async () => {
  const { ctx } = await load();
  const before = { '5': 6 };
  const afterSpin = { '5': 6, '7': 9 };
  assert.deepEqual(goldMarks(ctx, board(before, { coldestGold: true })).text, ['5'], 'before');
  assert.deepEqual(goldMarks(ctx, board(afterSpin, { coldestGold: true })).text, ['5', '7'], 'after a spin that lengthens 7');
  assert.deepEqual(goldMarks(ctx, board(before, { coldestGold: true })).text, ['5'], 'after the undo');
  assert.deepEqual(goldMarks(ctx, board({ '5': 1 }, { coldestGold: true })).text, ['5'], 'after a correction of 5');
});

test('a square that is both coldest and outlined: gold is its text colour and a pip, the F10 outline is untouched, and nothing changes its box', async () => {
  const { ctx } = await load();
  const droughts = { '17': lengthAtP98(ctx, '17', 'american') };
  const on = squaresByLabel(ctx.RouletteBoard(board(droughts, { coldestGold: true }))).get('17');
  const off = squaresByLabel(ctx.RouletteBoard(board(droughts, { coldestGold: false }))).get('17');
  assert.equal(on.props.style.outline, `2px solid ${OUTLINE_P98}`, 'the outline is the F10 red');
  assert.equal(on.props.style.color, GOLD, 'the gold is the text colour');
  assert.notEqual(on.props.style.outline, `2px solid ${GOLD}`, 'the outline is not gold');
  assert.equal(elementsWhere(on.props.children, (n) => n.props.style && n.props.style.background === GOLD).length, 1, 'one gold pip');
  assert.equal(off.props.style.color, 'white', 'without gold the text is the usual white');
  assert.deepEqual(Object.keys(on.props.style), Object.keys(off.props.style), 'the same style properties with gold on and off');
  for (const key of Object.keys(on.props.style)) {
    if (key !== 'color') assert.deepEqual(on.props.style[key], off.props.style[key], `${key} is the same with gold on`);
  }
});

test('the toggle hides the gold: off draws none, a page that passes no setting draws none, and on draws the union', async () => {
  const { ctx } = await load();
  const droughts = { '5': 6, '7': 9 };
  const want = expectedGold(ctx, droughts);
  assert.ok(want.length > 0);
  assert.deepEqual(goldMarks(ctx, board(droughts, { coldestGold: false })), { text: [], pips: [] }, 'off');
  assert.deepEqual(goldMarks(ctx, board(droughts, {})), { text: [], pips: [] }, 'no setting passed');
  assert.deepEqual(goldMarks(ctx, board(droughts, { coldestGold: true })).text, want, 'on');
});

// -- The tile and its detail view --

// The opening tag of the coldest row, found from its label.
const coldestRowTag = (html) => {
  const at = html.indexOf('>COLDEST<');
  const start = html.lastIndexOf('<div', at);
  return html.slice(start, html.indexOf('>', start) + 1);
};

test('the coldest row keeps its slot with a value and without one: the same heights, and only its visibility changes', async () => {
  const { ctx } = await load();
  const readout = (droughts) => ctx.sectionReadout({ kind: 'dozen', index: 0, wheel: 'american', spins: [], droughts, streak: 0 }, undefined);
  const html = (r) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionTile, { r, onOpen: NOOP }));
  const withValue = html(readout({ '3': 8, '11': 8 }));
  const withoutValue = html(readout({}));

  assert.ok(withValue.includes('>3, 11 · 8<'), 'the coldest numbers and their level are the row text');
  assert.match(coldestRowTag(withValue), /visibility:visible/);
  assert.doesNotMatch(coldestRowTag(withValue), /aria-hidden/);
  assert.match(coldestRowTag(withValue), /height:10px/);
  assert.match(withValue, new RegExp(`color:${GOLD}[^>]*>3, 11 · 8<`), 'the value is gold');

  assert.match(coldestRowTag(withoutValue), /visibility:hidden/, 'with no coldest number the row is hidden');
  assert.match(coldestRowTag(withoutValue), /aria-hidden="true"/);
  assert.match(withoutValue, />00 · 00</, 'the hidden row reserves the width of a value');

  const heights = (h) => h.match(/height:[\d.]+px/g);
  assert.deepEqual(heights(withValue), heights(withoutValue), 'every row keeps its height as the values change');
  assert.ok(withValue.includes('height:152px'), 'the tile keeps its fixed height');
});

test('the tile\'s rows fit its fixed height, with the coldest row included', async () => {
  const { ctx } = await load();
  const r = ctx.sectionReadout({ kind: 'column', index: 1, wheel: 'american', spins: [], droughts: { '2': 4 }, streak: 0 }, undefined);
  const tile = ctx.SectionTile({ r, onOpen: NOOP });
  const rows = tile.props.children.filter((c) => c && c.props && c.props.style);
  assert.equal(rows.length, 10, 'the label, range, streak, percentile, sparkline, three readings, the P95 count and the coldest row');
  const used = rows.reduce((sum, c) => sum + (c.props.style.height || 0) + (c.props.style.marginTop || 0), 0);
  const contentBox = 152 - 2 - 10; // TILE_H, less the 1px border each side and the 5px padding top and bottom
  assert.ok(used <= contentBox, `the rows use ${used} px of the ${contentBox} px content box`);
});

test('the detail view lists the section\'s numbers coldest first, with every tied coldest number in gold', async () => {
  const { ctx } = await load();
  const r = ctx.sectionReadout({ kind: 'dozen', index: 0, wheel: 'american', spins: [], droughts: { '3': 8, '11': 8, '5': 2 }, streak: 0 }, undefined);
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionDetail, { r, onClose: NOOP }));
  const gold = [...html.matchAll(/<div style="font-weight:700;color:#ffd700">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(gold, ['3', '11'], 'the tied coldest numbers are gold, and no other');
  const order = [...html.matchAll(/<div style="font-weight:700[^"]*">(\d+)<\/div>/g)].map((m) => m[1]);
  assert.equal(order.length, 12, 'twelve numbers');
  assert.deepEqual(order, plain(r.perNumber).map((row) => row.number), 'coldest first, as the readout orders them');
  assert.deepEqual(plain(r.coldest), { level: 8, numbers: ['3', '11'] });
});

// -- Settings and wiring --

test('Settings: Gold for the coldest number sits under Percentile outlines, reads ON with no key, OFF when off, and the tap flips one key', async () => {
  const { ctx } = await load();
  const cur = ctx.getCurrency('USD');
  const sess = plain(ctx.newSession('american', 500));
  const page = (settings) => render('SettingsPage', {
    settings, updSettings: NOOP, setCurrencyOpen: NOOP, currency: 'USD', cur, updSess: NOOP, sess,
    setChangelogOpen: NOOP, updApp: NOOP, importJSON: NOOP, setHardResetOpen: NOOP,
  });
  const label = 'Gold for the coldest number in each dozen and column';
  // Settings as saved before the key existed.
  const legacy = await page({ currency: 'USD', defaultBuyIn: 100, onboarded: true, vibration: true, tableMinBet: 10, tableMaxBet: 500, tableMaxTotal: 10000 });
  const off = await page({ ...ctx.defaultSettings(), coldestGold: false });
  const toggleAfter = (html, text) => html.slice(html.indexOf(text)).match(/>(ON|OFF)<\/button>/)[1];

  assert.ok(legacy.indexOf('Percentile outlines') < legacy.indexOf(label), 'the row sits under the F10 toggle');
  assert.equal(toggleAfter(legacy, label), 'ON', 'a missing key reads as on');
  assert.equal(toggleAfter(off, label), 'OFF');
  const secondary = await readFile(new URL('components/SecondaryPages.jsx', SRC), 'utf8');
  assert.match(secondary, /s\.settings\.coldestGold=s\.settings\.coldestGold===false/, 'the tap flips the one saved key');
});

test('wiring: the Live page passes the setting to its roulette board', async () => {
  const text = await readFile(new URL('App.jsx', SRC), 'utf8');
  let boards = 0;
  for (const m of text.matchAll(/<RouletteBoard\b/g)) {
    const tag = text.slice(m.index, text.indexOf('/>', m.index));
    assert.match(tag, /coldestGold=\{settings\.coldestGold!==false\}/, `App.jsx RouletteBoard at ${m.index}`);
    boards += 1;
  }
  assert.equal(boards, 1, 'one roulette board on the Live page');
});

test('no odds or house-edge wording in the new copy: the tile, its detail, the board and the setting', async () => {
  const { ctx } = await load();
  const r = ctx.sectionReadout({ kind: 'dozen', index: 0, wheel: 'american', spins: [], droughts: { '3': 8 }, streak: 0 }, undefined);
  const copy = [
    ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionTile, { r, onOpen: NOOP })),
    ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SectionDetail, { r, onClose: NOOP })),
    ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.RouletteBoard, board({ '3': 8 }, { coldestGold: true }))),
    await render('SettingsPage', {
      settings: {}, updSettings: NOOP, setCurrencyOpen: NOOP, currency: 'USD', cur: ctx.getCurrency('USD'), updSess: NOOP,
      sess: plain(ctx.newSession('american', 500)), setChangelogOpen: NOOP, updApp: NOOP, importJSON: NOOP, setHardResetOpen: NOOP,
    }),
  ];
  for (const html of copy) assert.doesNotMatch(html, /odds|house edge|house-edge|probabilit|chance|payout|expected value/i);
});
