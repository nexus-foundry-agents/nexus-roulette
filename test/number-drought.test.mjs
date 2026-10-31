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
const NOOP = () => {};

// The files the bundle concatenates ahead of the pieces these tests render, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs',
  'components/NumberDrought.jsx', 'components/ui.jsx', 'components/grids.jsx', 'components/SecondaryPages.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global
// scope. The bundle's React and hooks are answered by the React this file imports, so the markup these
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
  sandbox.window.parent = sandbox; // standalone page: window.parent === window
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

// The counter's style as the server renders it. Its opening tag is the reserved slot; only its text varies.
const SLOT = 'font-size:7px;font-weight:400;line-height:8px;height:8px;';
const slotTags = (html) => html.match(new RegExp(`<div[^>]*${SLOT}[^>]*>`, 'g')) || [];

// [label, count] for each counter in a stacked RouletteBoard cell (number, then its count).
const boardPairs = (html) => [...html.matchAll(
  new RegExp(`align-items:center">([^<]+)<div style="${SLOT}[^"]*">([^<]*)</div></div>`, 'g'),
)].map((m) => [m[1], m[2]]);

// [label, count] for each counter in a FibGrid cell: a numbered div (or <div> for 0 and 00), then its count.
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

test('build order: the count module compiles before the boards that use it, and the committed bundle contains it', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const output = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('components/NumberDrought.jsx') > 0, 'NumberDrought.jsx is in the FILES list');
  assert.ok(at('components/NumberDrought.jsx') < at('components/ui.jsx'));
  assert.ok(at('components/ui.jsx') < at('components/grids.jsx'));
  assert.match(output, /function displayDrought\(/);
  assert.match(output, /function NumberDrought\(/);
});

test('displayDrought: an unseen number shows its drought plus the wheel size, marked ~, only when the head start is on', async () => {
  const { ctx } = await load();
  assert.equal(ctx.displayDrought('17', { 17: 3 }, ['5', '9'], 38, true), '~41');
  assert.equal(ctx.displayDrought('17', { 17: 3 }, ['5', '9'], 38, false), '3');
  // A saved setting with no key reads as off, so an absent value is the plain drought.
  assert.equal(ctx.displayDrought('17', { 17: 3 }, ['5', '9'], 38, undefined), '3');
});

test('displayDrought: a number that has come up shows its true drought, with the head start on or off', async () => {
  const { ctx } = await load();
  assert.equal(ctx.displayDrought('17', { 17: 2 }, ['5', '17'], 38, true), '2');
  assert.equal(ctx.displayDrought('17', { 17: 2 }, ['5', '17'], 38, false), '2');
});

test('displayDrought: 0 and 00 take the same arithmetic, and a hit zero is seen', async () => {
  const { ctx } = await load();
  const d = { '0': 5, '00': 7 };
  assert.equal(ctx.displayDrought('0', d, [], 38, true), '~43');
  assert.equal(ctx.displayDrought('00', d, [], 38, true), '~45');
  assert.equal(ctx.displayDrought('0', d, [], 38, false), '5');
  assert.equal(ctx.displayDrought('00', d, [], 38, false), '7');
  assert.equal(ctx.displayDrought('0', d, ['0'], 38, true), '5', 'a hit 0 shows its true count');
  assert.equal(ctx.displayDrought('00', d, ['0'], 38, true), '~45', '00 is still unseen');
});

test('displayDrought: the wheel size comes from the wheel list, 38 on American and 37 on European', async () => {
  const { ctx } = await load();
  const american = ctx.getWheelNumbers('american').length;
  const european = ctx.getWheelNumbers('european').length;
  assert.equal(american, 38);
  assert.equal(european, 37);
  assert.equal(ctx.displayDrought('1', { 1: 0 }, [], american, true), '~38');
  assert.equal(ctx.displayDrought('1', { 1: 0 }, [], european, true), '~37');
});

test('displayDrought and both boards only read sess.droughts: nothing is written back', async () => {
  const { ctx, sess } = await fixture('american');
  sess.droughts = plain(ctx.initDroughts('american'));
  sess.droughts['17'] = 4;
  sess.spins = ['5'];
  // Frozen, so a write fails loudly in strict code; the JSON comparison catches a silent one too.
  Object.freeze(sess.droughts);
  Object.freeze(sess.spins);
  const before = JSON.stringify(sess.droughts);
  for (const n of ctx.getWheelNumbers('american')) ctx.displayDrought(n, sess.droughts, sess.spins, 38, true);
  await render('RouletteBoard', boardProps(sess, { showDroughts: true, headStart: true }));
  await render('FibGrid', fibProps(sess, { showDroughts: true, headStart: true }));
  assert.equal(JSON.stringify(sess.droughts), before);
});

test('NumberDrought: the count on and off reserve the same slot, and ~99 fits that same slot', async () => {
  const view = (extra) => ({ droughts: { 17: 61 }, spins: [], wheelSize: 38, headStart: true, on: true, ...extra });
  const onHtml = await render('NumberDrought', { num: '17', view: view({}) });
  const offHtml = await render('NumberDrought', { num: '17', view: view({ on: false }) });
  const plainHtml = await render('NumberDrought', { num: '17', view: view({ headStart: false, droughts: { 17: 7 } }) });

  assert.match(onHtml, />~99<\/div>$/, 'an unseen number with the head start shows ~99');
  assert.match(plainHtml, />7<\/div>$/);
  const slotOf = (html) => html.match(/^<div[^>]*>/)[0];
  assert.equal(slotOf(onHtml), slotOf(plainHtml), '~99 and 7 take the same reserved slot');
  assert.match(onHtml, /white-space:nowrap/, 'the count cannot wrap onto a second line');
  assert.match(onHtml, /height:8px;/, 'the slot has a fixed height');

  assert.doesNotMatch(onHtml, /visibility:hidden|aria-hidden/);
  assert.match(offHtml, /aria-hidden="true"/);
  assert.match(offHtml, /visibility:hidden/);
  const strip = (h) => h.replace(/ aria-hidden="true"/g, '').replace(/visibility:(hidden|visible)/g, 'visibility');
  assert.equal(strip(offHtml), strip(onHtml), 'off and on differ only in visibility');
});

test('RouletteBoard: every number, 0 and 00 shows its own count; unseen numbers get the head start on the wheel size', async () => {
  for (const roulette of ['american', 'european']) {
    const { ctx, sess } = await fixture(roulette);
    const nums = ctx.getWheelNumbers(roulette);
    sess.droughts = Object.fromEntries(nums.map((n, i) => [n, i * 2 + 1]));
    sess.spins = ['17', '0'];
    const pairs = boardPairs(await render('RouletteBoard', boardProps(sess, { showDroughts: true, headStart: true })));
    assert.equal(pairs.length, nums.length, `${roulette}: one counter per wheel number`);
    assert.deepEqual(pairs.map(([l]) => l).sort(), [...nums].sort());
    for (const [label, value] of pairs) {
      const plainCount = sess.droughts[label];
      const seen = sess.spins.includes(label);
      assert.equal(value, seen ? String(plainCount) : `~${plainCount + nums.length}`, `${roulette} ${label}`);
    }
  }
});

test('RouletteBoard: count off keeps every cell and its count slot the same, and hides the count with visibility and aria-hidden', async () => {
  const { sess } = await fixture('american');
  const on = await render('RouletteBoard', boardProps(sess, { showDroughts: true }));
  const off = await render('RouletteBoard', boardProps(sess, { showDroughts: false }));
  assert.equal(slotTags(on).length, 38);
  assert.equal(slotTags(off).length, 38);
  assert.equal((on.match(/visibility:hidden/g) || []).length, 0);
  assert.equal((off.match(/visibility:hidden/g) || []).length, 38);
  assert.equal((off.match(/aria-hidden="true"/g) || []).length, 38);
  const strip = (h) => h.replace(/ aria-hidden="true"/g, '').replace(/visibility:(hidden|visible)/g, 'visibility');
  assert.equal(strip(off), strip(on));
});

test('FibGrid: every number, 0 and 00 shows its own count, and the slot is the same with a track overlay on the number or not', async () => {
  const { ctx, sess } = await fixture('american');
  sess.droughts = Object.fromEntries(ctx.getWheelNumbers('american').map((n, i) => [n, i + 3]));
  sess.spins = ['2'];
  const plainHtml = await render('FibGrid', fibProps(sess));
  const pairs = fibPairs(plainHtml);
  assert.equal(pairs.length, 38, 'one counter per wheel number, 0 and 00 included');
  for (const [label, value] of pairs) assert.equal(value, String(sess.droughts[label]), label);

  const overlay = [{ type: 'solution', color: '#f0abfc', activeBets: [{ number: '17' }] }];
  const withOverlay = await render('FibGrid', fibProps(sess, { trackOverlays: overlay }));
  assert.ok(withOverlay.includes('border-radius:50%'), 'the overlay dot is rendered');
  assert.ok(!plainHtml.includes('border-radius:50%'), 'the plain grid has no overlay dot');
  assert.deepEqual(slotTags(withOverlay), slotTags(plainHtml));
});

test('FibGrid: a count and its overlay dots fit inside the 42px minimum cell height', async () => {
  const { sess } = await fixture('american');
  const html = await render('FibGrid', fibProps(sess, {
    trackOverlays: [{ type: 'solution', color: '#f0abfc', activeBets: [{ number: '17' }] }],
  }));
  // The cell with the overlay dot. Buttons size border-box, so the room for content is minHeight less
  // the border and the vertical padding on both sides.
  const button = html.split('<button').find((piece) => piece.includes('border-radius:50%'));
  assert.ok(button, 'the number 17 cell with its overlay dot is rendered');
  const px = (re) => Number(button.match(re)[1]);
  const pad = px(/padding:(\d+)px 0/);
  const minH = px(/min-height:(\d+)px/);
  const border = px(/border:(\d+)px solid/);
  const numberLine = px(/line-height:(\d+)px">17</);
  const counter = px(/line-height:8px;height:(\d+)px/);
  const dotGap = px(/margin-top:(\d+)px/);
  const dotH = px(/width:5px;height:(\d+)px;/);
  const room = minH - 2 * border - 2 * pad;
  const content = numberLine + counter + dotGap + dotH;
  assert.ok(content <= room, `content ${content}px must fit the ${room}px left in a ${minH}px cell`);
});

test('Settings: the count row and the head start row sit directly under Vibration, and a saved setting with no key reads as the default', async () => {
  const { ctx } = await load();
  const cur = ctx.getCurrency('USD');
  const sess = plain(ctx.newSession('american', 500));
  const page = (settings) => render('SettingsPage', {
    settings, updSettings: NOOP, setCurrencyOpen: NOOP, currency: 'USD', cur, updSess: NOOP, sess,
    setChangelogOpen: NOOP, updApp: NOOP, importJSON: NOOP, setHardResetOpen: NOOP,
  });
  // Settings as saved before either key existed.
  const legacy = await page({ currency: 'USD', defaultBuyIn: 100, onboarded: true, vibration: true, tableMinBet: 10, tableMaxBet: 500, tableMaxTotal: 10000 });
  const toggled = await page({ ...ctx.defaultSettings(), showDroughtCounts: false, headStartUnseen: true });
  const toggleAfter = (html, label) => html.slice(html.indexOf(label)).match(/>(ON|OFF)<\/button>/)[1];

  assert.ok(legacy.indexOf('Vibration Feedback') < legacy.indexOf('Spins Since Last Hit'));
  assert.ok(legacy.indexOf('Spins Since Last Hit') < legacy.indexOf('Head start for unseen numbers'));
  const between = legacy.slice(legacy.indexOf('Spins Since Last Hit'), legacy.indexOf('Head start for unseen numbers'));
  assert.equal(between.split('<span').length - 1, 1, 'no other row sits between the two');

  assert.equal(toggleAfter(legacy, 'Spins Since Last Hit'), 'ON', 'a missing key reads as on');
  assert.equal(toggleAfter(legacy, 'Head start for unseen numbers'), 'OFF', 'a missing key reads as off');
  assert.equal(toggleAfter(toggled, 'Spins Since Last Hit'), 'OFF');
  assert.equal(toggleAfter(toggled, 'Head start for unseen numbers'), 'ON');

  assert.equal(ctx.defaultSettings().showDroughtCounts, true);
  assert.equal(ctx.defaultSettings().headStartUnseen, false);
});

// WCAG relative luminance and contrast ratio, for the counter colour against the cell fills.
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

test('the count reads on the green, red and black number cells the board uses (contrast of at least 3 to 1)', async () => {
  const { sess } = await fixture('american');
  const board = await render('RouletteBoard', boardProps(sess, { showDroughts: true }));
  // The zero, red and black fills from RouletteBoard's cell styles.
  const fills = ['#166534', '#991b1b', '#1e293b'];
  for (const bg of fills) assert.ok(board.includes(`background:${bg}`), `the board renders a ${bg} cell`);
  const one = await render('NumberDrought', { num: '17', view: { droughts: {}, spins: [], wheelSize: 38, headStart: false, on: true } });
  const color = one.match(/color:(#[0-9a-f]{6})/)[1];
  for (const bg of fills) {
    assert.ok(contrast(color, bg) >= 3, `${color} on ${bg} is ${contrast(color, bg).toFixed(2)}:1`);
  }
});

// Picking a hit: the counter sits in the lower edge zone of each square, which reads as a split or a corner
// when placing a bet. While the board is picking a winning number, a tap anywhere in a square is that number.
function cellsByKey(node, out = new Map()) {
  if (Array.isArray(node)) { node.forEach((n) => cellsByKey(n, out)); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (node.key != null && typeof node.props.onClick === 'function') out.set(String(node.key), node);
  cellsByKey(node.props.children, out);
  return out;
}
const tapAt = (cell, fx, fy) => cell.props.onClick({
  currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 30, height: 30 }) },
  clientX: 30 * fx, clientY: 30 * fy, target: null, stopPropagation() {},
});
function boardTaps(ctx, pickNumbers) {
  const bets = [];
  const tree = ctx.RouletteBoard({ roulette: 'american', onBet: (type, target) => bets.push([type, target]), spinning: false, pickNumbers, droughts: {}, spins: [] });
  return { cells: cellsByKey(tree), bets };
}

test('picking a hit: a tap low in a number square (on the counter) selects that number', async () => {
  const { ctx } = await load();
  const { cells, bets } = boardTaps(ctx, true);
  const seventeen = cells.get('17');
  assert.ok(seventeen, 'the 17 square is found');
  tapAt(seventeen, 0.5, 0.92); // on the counter, the bottom edge
  tapAt(seventeen, 0.05, 0.05); // a corner
  assert.deepEqual(bets, [['straight', '17'], ['straight', '17']]);
});

test('placing bets is unchanged: a corner tap on a number square is still not a straight bet', async () => {
  const { ctx } = await load();
  const { cells, bets } = boardTaps(ctx, false);
  tapAt(cells.get('17'), 0.02, 0.02);
  assert.equal(bets.length, 1);
  assert.notEqual(bets[0][0], 'straight');
});

// -- Percentile outlines: a square's outline from its single-number percentile (F10) --
const OUTLINE = { p75: '#16a34a', p95: '#fbbf24', p98: '#f87171' };
// The bands are written from the raw percentile here, so the expectations do not run through outlineTier.
const BANDS = {
  none: (p) => p < 75,
  p75: (p) => p >= 75 && p < 95,
  p95: (p) => p >= 95 && p < 98,
  p98: (p) => p >= 98,
};
// The shortest losing streak that reads in a band of this number's single-number percentile on the wheel.
function bandLength(ctx, label, wheel, band) {
  for (let len = 0; len <= 400; len += 1) {
    if (BANDS[band](ctx.streakPercentile('straight:' + label, wheel, len))) return len;
  }
  throw new Error(`no length of ${label} on ${wheel} reads in ${band}`);
}
const pocketLabels = (wheel) => ['0', ...Array.from({ length: 36 }, (_, i) => String(i + 1)), ...(wheel === 'american' ? ['00'] : [])];
const outlineBoard = (roulette, droughts, extra = {}) => ({
  roulette, droughts, spins: [], spinning: false, onBet: NOOP, showDroughts: true, ...extra,
});
// The number squares only, keyed by their label. The column and dozen buttons also carry keys 0, 1 and 2, so a square
// is the keyed button whose first child is the number's face, and that face's first child is the label.
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

test('percentile outlines: every square, 0 and 00 included, takes the outline of its own single-number band, on both wheels', async () => {
  const { ctx } = await load();
  const bands = ['none', 'p75', 'p95', 'p98'];
  for (const roulette of ['american', 'european']) {
    const labels = pocketLabels(roulette);
    const assigned = Object.fromEntries(labels.map((label, i) => [label, bands[i % bands.length]]));
    const droughts = Object.fromEntries(labels.map((label) => [label, bandLength(ctx, label, roulette, assigned[label])]));
    const squares = squaresByLabel(ctx.RouletteBoard(outlineBoard(roulette, droughts)));
    assert.equal(squares.size, labels.length, `${roulette}: one square per pocket`);
    for (const label of labels) {
      const band = assigned[label];
      const { style } = squares.get(label).props;
      assert.equal(style.outline, band === 'none' ? undefined : `2px solid ${OUTLINE[band]}`, `${roulette} ${label} (${band})`);
      assert.equal(style.outlineOffset, band === 'none' ? undefined : 0, `${roulette} ${label} outline offset`);
    }
  }
});

test('percentile outlines: the setting off draws none; a saved setting with no key, or on, draws them', async () => {
  const { ctx } = await load();
  const droughts = { '17': bandLength(ctx, '17', 'american', 'p98') };
  const outlineOf = (extra) => squaresByLabel(ctx.RouletteBoard(outlineBoard('american', droughts, extra))).get('17').props.style.outline;
  assert.equal(outlineOf({}), `2px solid ${OUTLINE.p98}`, 'no key reads as on');
  assert.equal(outlineOf({ percentileOutlines: true }), `2px solid ${OUTLINE.p98}`);
  assert.equal(outlineOf({ percentileOutlines: false }), undefined, 'off draws nothing');
});

test('percentile outlines: a square with each band has the same box as one without, in the markup the browser gets (no border, size or layout change)', async () => {
  const { ctx } = await load();
  const squareStyle = (html, label) => {
    const m = html.match(new RegExp(`<div style="([^"]*)">(?=<div style="display:flex;flex-direction:column;align-items:center">${label}<div)`));
    assert.ok(m, `the ${label} square is in the markup`);
    return m[1];
  };
  const withoutOutline = (style) => style.split(';').filter((decl) => !decl.startsWith('outline')).join(';');
  for (const label of ['17', '0', '00']) {
    const none = squareStyle(await render('RouletteBoard', outlineBoard('american', {})), label);
    assert.doesNotMatch(none, /outline/, `${label} with no band has no outline`);
    for (const band of ['p75', 'p95', 'p98']) {
      const html = await render('RouletteBoard', outlineBoard('american', { [label]: bandLength(ctx, label, 'american', band) }));
      const style = squareStyle(html, label);
      assert.ok(style.includes(`outline:2px solid ${OUTLINE[band]}`), `${label} ${band}: ${style}`);
      assert.equal(withoutOutline(style), none, `${label} ${band}: the box is the same as without an outline`);
    }
  }
});

test('percentile outlines: an outlined square still takes a tap anywhere in it (picking a hit), with no overlay on it', async () => {
  const { ctx } = await load();
  const droughts = {
    '17': bandLength(ctx, '17', 'american', 'p98'),
    '0': bandLength(ctx, '0', 'american', 'p75'),
    '00': bandLength(ctx, '00', 'american', 'p95'),
  };
  const bets = [];
  const squares = squaresByLabel(ctx.RouletteBoard(outlineBoard('american', droughts, {
    pickNumbers: true, onBet: (type, target) => bets.push([type, target]),
  })));
  for (const label of ['17', '0', '00']) {
    const square = squares.get(label);
    assert.ok(square.props.style.outline, `${label} is outlined`);
    tapAt(square, 0.5, 0.92); // on the counter, the bottom edge
    tapAt(square, 0.05, 0.05); // a corner
    tapAt(square, 0.5, 0.5); // the centre
  }
  assert.deepEqual(bets, [
    ['straight', '17'], ['straight', '17'], ['straight', '17'],
    ['straight', '0'], ['straight', '0'], ['straight', '0'],
    ['straight', '00'], ['straight', '00'], ['straight', '00'],
  ]);
});

test('Settings: Percentile outlines sits under Counter shows, reads ON with no key and OFF when off, and is on by default', async () => {
  const { ctx } = await load();
  const cur = ctx.getCurrency('USD');
  const sess = plain(ctx.newSession('american', 500));
  const page = (settings) => render('SettingsPage', {
    settings, updSettings: NOOP, setCurrencyOpen: NOOP, currency: 'USD', cur, updSess: NOOP, sess,
    setChangelogOpen: NOOP, updApp: NOOP, importJSON: NOOP, setHardResetOpen: NOOP,
  });
  // Settings as saved before the key existed.
  const legacy = await page({ currency: 'USD', defaultBuyIn: 100, onboarded: true, vibration: true, tableMinBet: 10, tableMaxBet: 500, tableMaxTotal: 10000 });
  const off = await page({ ...ctx.defaultSettings(), percentileOutlines: false });
  const toggleAfter = (html, label) => html.slice(html.indexOf(label)).match(/>(ON|OFF)<\/button>/)[1];

  assert.ok(legacy.indexOf('Counter shows') < legacy.indexOf('Percentile outlines'));
  const between = legacy.slice(legacy.indexOf('Counter shows'), legacy.indexOf('Percentile outlines'));
  assert.equal(between.split('<span').length - 1, 1, 'no other row sits between the two');

  assert.equal(toggleAfter(legacy, 'Percentile outlines'), 'ON', 'a missing key reads as on');
  assert.equal(toggleAfter(off, 'Percentile outlines'), 'OFF');
  assert.equal(ctx.defaultSettings().percentileOutlines, true);
  const secondary = await readFile(new URL('components/SecondaryPages.jsx', SRC), 'utf8');
  assert.match(secondary, /s\.settings\.percentileOutlines=s\.settings\.percentileOutlines===false/, 'the tap flips the one saved key');
});

test('wiring: the Live page and the Game page each pass the Percentile outlines setting to their roulette board', async () => {
  let boards = 0;
  for (const file of ['App.jsx', 'components/GamePage.jsx']) {
    const text = await readFile(new URL(file, SRC), 'utf8');
    for (const m of text.matchAll(/<RouletteBoard\b/g)) {
      const tag = text.slice(m.index, text.indexOf('/>', m.index));
      assert.match(tag, /percentileOutlines=\{settings\.percentileOutlines\}/, `${file} RouletteBoard at ${m.index}`);
      boards += 1;
    }
  }
  assert.equal(boards, 2, 'one roulette board on the Live page and one on the Game page');
});
