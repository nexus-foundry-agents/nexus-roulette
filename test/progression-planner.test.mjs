import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const NOOP = () => {};

// The files the bundle concatenates ahead of the Full Table page, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs',
  'components/NumberDrought.jsx', 'components/ui.jsx', 'components/TablePage.jsx',
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

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value)); // vm-realm objects compare by prototype otherwise

function trackOf(id, config, level, color) {
  return { id, type: config.type, color, state: 'active', config, level, pnl: 0, bets: [], createdAtSpin: 0, closedAtSpin: null, wins: 0, sequences: 0 };
}

// selectedLevel is {trackId, index} as App keeps it, or null for the track's current level.
function renderPage(ctx, tracks, selectedTrackId, selectedLevel = null) {
  const props = {
    sess: { tracks },
    selectedTrackId,
    setSelectedTrackId: NOOP,
    nonClosedTracks: tracks,
    cur: ctx.getCurrency('USD'),
    selectedLevel,
    setSelectedLevel: NOOP,
  };
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.TablePageView, props));
}

const FIB = { type: 'fibonacci', unit: 1, roi: 15, betMode: 'progression', dozenTargets: [1], colTargets: [], evenTargets: [], stopLoss: 200 };
const FIB_MIX = { ...FIB, colTargets: [2] };
const FIB_FLAT = { ...FIB, betMode: 'flat' };
const SOL = { type: 'solution', unit: 1, roi: 10, entryThreshold: 120, stopLoss: 200, activeBets: [{ number: 17, level: 0 }] };

// Non-custom fixtures: each returns the page markup for one state of a Progression Bet or The Solution track.
function nonCustomFixtures(ctx) {
  const single = [trackOf('fib-1', FIB, 2, '#60a5fa')];
  const withTabs = [trackOf('fib-2', FIB_MIX, 1, '#f87171'), trackOf('sol-2', SOL, 0, '#fbbf24')];
  return {
    'progression-single': renderPage(ctx, single, 'fib-1'),
    'progression-mix-with-tabs': renderPage(ctx, withTabs, 'fib-2'),
    'solution-with-tabs': renderPage(ctx, withTabs, 'sol-2'),
    'progression-flat': renderPage(ctx, [trackOf('fib-3', FIB_FLAT, 0, '#a78bfa')], 'fib-3'),
  };
}

// Recorded from the Full Table page before any Custom Bet change, on the branch this work was cut from.
// Any change to a non-custom render must come with a new recording and a reason in the changelog.
const NON_CUSTOM_BASELINE = {
  'progression-single': '9977a6f23dd645eefff13059044fd097b28b235cc421858a532a134a7f35a287',
  'progression-mix-with-tabs': 'b495ebde37e49bb77c4762c5e5aa9bd7866e1bc30e132ce4a25b14f8e69e5d48',
  'solution-with-tabs': '20816203e433a0587c473247e08a566e97fadc8f7696ac564278b8e067de5b46',
  'progression-flat': 'eaf6b4f5ee40721cb17e577f90f2828ca648de4f9126680f2ebe4d2d10b798a7',
};

test('non-custom tracks render exactly as before the Custom Bet changes', async () => {
  const { ctx } = await load();
  const rendered = nonCustomFixtures(ctx);
  const digests = Object.fromEntries(Object.entries(rendered).map(([name, html]) => [name, sha256(html)]));
  assert.deepEqual(digests, NON_CUSTOM_BASELINE);
  for (const html of Object.values(rendered)) {
    assert.doesNotMatch(html, /Bankroll needed/, 'non-custom tracks keep the Invested heading');
    assert.doesNotMatch(html, /data-spot-card/, 'non-custom tracks have no per-spot card');
    assert.doesNotMatch(html, /data-level=/, 'non-custom level rows are not selectable');
  }
});

// -- Custom Bet progression planner: per-spot arithmetic --

const straight = (target, baseAmount) => ({ type: 'straight', target, baseAmount });
const split = (target, baseAmount) => ({ type: 'split', target, baseAmount });
const corner = (target, baseAmount) => ({ type: 'corner', target, baseAmount });
const dozen = (target, baseAmount) => ({ type: 'dozen', target, baseAmount });

test('computeSpotBreakdown: a single straight', async () => {
  const { ctx } = await load();
  // Straight on 17, base 1. Level c = 2, bankroll needed 6 chips, unit 1.
  // Gross on 17 = 1 × 2 × 36 = 72. Bet per spot = 1 × 2 × 1 = 2. Payout = 72. Net = 72 − 6 = 66.
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown([straight('17', 1)], { c: 2, totalBet: 2, totalInvest: 6 }, 1)),
    [{ betPerSpot: 2, payout: 72, net: 66 }],
  );
});

test('computeSpotBreakdown: a split and a straight that overlap on 17', async () => {
  const { ctx } = await load();
  // Straight 17 base 1, split 17-20 base 2. Level c = 1, bankroll needed 3 chips, unit 1.
  // Gross on 17 = 1×1×36 + 2×1×18 = 72. Gross on 20 = 2×1×18 = 36.
  // Straight: its only number is 17, so payout 72, bet 1, net 72 − 3 = 69.
  // Split: covers 17 and 20, the worst is 20, so payout 36, bet 2, net 36 − 3 = 33.
  const positions = [straight('17', 1), split('17-20', 2)];
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown(positions, { c: 1, totalBet: 3, totalInvest: 3 }, 1)),
    [
      { betPerSpot: 1, payout: 72, net: 69 },
      { betPerSpot: 2, payout: 36, net: 33 },
    ],
  );
});

test('computeSpotBreakdown: a corner', async () => {
  const { ctx } = await load();
  // Corner 17-18-20-21 base 1, alone. Level c = 1, bankroll needed 1 chip, unit 1.
  // Each covered number grosses 1×1×9 = 9, so payout 9, bet 1, net 9 − 1 = 8.
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown([corner('17-18-20-21', 1)], { c: 1, totalBet: 1, totalInvest: 1 }, 1)),
    [{ betPerSpot: 1, payout: 9, net: 8 }],
  );
});

test('computeSpotBreakdown: mixed amounts in a unit of 2', async () => {
  const { ctx } = await load();
  // Straight 17 base 1, split 17-20 base 2. Level c = 3, bankroll needed 10 chips, unit 2.
  // Gross on 17 = 1×3×36 + 2×3×18 = 216 chips. Gross on 20 = 2×3×18 = 108 chips.
  // Straight: bet 1×3×2 = 6, payout 216×2 = 432, net 432 − 10×2 = 412.
  // Split: bet 2×3×2 = 12, worst is 20 so payout 108×2 = 216, net 216 − 20 = 196.
  const positions = [straight('17', 1), split('17-20', 2)];
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown(positions, { c: 3, totalBet: 9, totalInvest: 10 }, 2)),
    [
      { betPerSpot: 6, payout: 432, net: 412 },
      { betPerSpot: 12, payout: 216, net: 196 },
    ],
  );
});

test('computeSpotBreakdown: a fractional unit gives clean currency values', async () => {
  const { ctx } = await load();
  // Straight 17 base 3. Level c = 1, bankroll needed 3 chips, unit 0.1.
  // Bet = 3×1×0.1 = 0.3. Gross on 17 = 3×1×36 = 108 chips, payout 108×0.1 = 10.8. Net = 10.8 − 0.3 = 10.5.
  // Raw float arithmetic gives 0.30000000000000004 for the bet, so the values are rounded to clear the noise.
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown([straight('17', 3)], { c: 1, totalBet: 3, totalInvest: 3 }, 0.1)),
    [{ betPerSpot: 0.3, payout: 10.8, net: 10.5 }],
  );
});

test('computeSpotBreakdown: a flat-mode track, one level from computeTableForTrack', async () => {
  const { ctx } = await load();
  // Straight 17 base 1 and straight 5 base 1, flat. Base total 2, so the one level has c = 1 and bankroll 2.
  // Each straight covers one number that pays 36 gross: bet 1, payout 36, net 36 − 2 = 34.
  const track = { id: 'flat-17-5', type: 'custom', config: { type: 'custom', unit: 1, roi: 15, betMode: 'flat', stopLoss: 200, positions: [straight('17', 1), straight('5', 1)] } };
  const [level] = plain(ctx.computeTableForTrack(track));
  assert.deepEqual([level.c, level.totalInvest], [1, 2]);
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown(track.config.positions, level, 1)),
    [
      { betPerSpot: 1, payout: 36, net: 34 },
      { betPerSpot: 1, payout: 36, net: 34 },
    ],
  );
});

test('computeSpotBreakdown: the first level of a progression from computeTableForTrack', async () => {
  const { ctx } = await load();
  // Straight 17 base 1 and split 17-20 base 1, progression, roi 15, stop 200, unit 1.
  // Base total 2. Gross on 20 = 18 (split only). Gross on 17 = 36 + 18 = 54. Smallest payout is 18.
  // Level 1 is c = 1, bankroll needed 2. Straight: payout 54, bet 1, net 52.
  // Split: worst number is 20, payout 18, bet 1, net 18 − 2 = 16.
  const track = { id: 'prog-17-20', type: 'custom', config: { type: 'custom', unit: 1, roi: 15, betMode: 'progression', stopLoss: 200, positions: [straight('17', 1), split('17-20', 1)] } };
  const [level] = plain(ctx.computeTableForTrack(track));
  assert.deepEqual([level.c, level.totalInvest], [1, 2]);
  assert.deepEqual(
    plain(ctx.computeSpotBreakdown(track.config.positions, level, 1)),
    [
      { betPerSpot: 1, payout: 54, net: 52 },
      { betPerSpot: 1, payout: 18, net: 16 },
    ],
  );
});

test('computeSpotBreakdown leaves its positions and level row unchanged', async () => {
  const { ctx } = await load();
  const positions = [straight('17', 1), split('17-20', 2)];
  const row = { c: 1, totalBet: 3, totalInvest: 3 };
  const before = JSON.stringify([positions, row]);
  ctx.computeSpotBreakdown(positions, row, 1);
  ctx.computeSpotBreakdown(positions, row, 2);
  assert.equal(JSON.stringify([positions, row]), before);
});

// -- The Full Table page: the per-spot card and level selection --

// CUSTOM_PROGRESSION is straight 17 base 1 plus split 17-20 base 1, roi 15, stop 200, unit 1.
// Base total 2. The smallest winning payout is 18: number 20 is covered only by the split (gross 18),
// and 17 grosses 54. So denom = 18 − 2 × 1.15 = 15.7 and c = ceil(invest × 1.15 / 15.7).
// c stays 1 while invest is at most 13, so levels 1 to 7 bet 2 each (totalInvest 2, 4 … 14).
// Level 8 has invest 14 before it, c = ceil(16.1 / 15.7) = 2, and totalInvest 18.
// So: index 0 is level 1 (c 1, totalInvest 2), index 2 is level 3 (c 1, totalInvest 6), index 7 is level 8 (c 2, totalInvest 18).
const CUSTOM_PROGRESSION = [straight('17', 1), split('17-20', 1)];

function customTrack(id, positions, level, betMode = 'progression') {
  return trackOf(id, { type: 'custom', unit: 1, roi: 15, betMode, stopLoss: 200, positions }, level, '#8b5cf6');
}

const usd = (ctx) => ctx.getCurrency('USD');
const money = (ctx, v) => usd(ctx).symbol + v.toFixed(usd(ctx).dec);
const signed = (ctx, v) => (v >= 0 ? '+' : '-') + usd(ctx).symbol + Math.abs(v).toFixed(usd(ctx).dec);

// The markup of the element that opens at the first occurrence of marker, through its matching close tag.
function elementAt(html, marker) {
  const mark = html.indexOf(marker);
  if (mark < 0) return null;
  const start = html.lastIndexOf('<div', mark);
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error('unbalanced markup');
}

// The text between tags, in order, of a fragment of markup.
const textNodes = (html) => [...html.matchAll(/>([^<>]+)</g)].map((m) => m[1]);

// The reserved box of the card: the opening tags of the card and of its spot list, which carry its sizes,
// and how many spot rows it holds.
function cardBox(html) {
  const card = elementAt(html, 'data-spot-card');
  const rows = elementAt(html, 'data-spot-rows');
  return {
    card: card.slice(0, card.indexOf('>') + 1),
    rows: rows.slice(0, rows.indexOf('>') + 1),
    spotRows: (card.match(/data-spot-row=""/g) || []).length,
  };
}

// The opening tag of the level row numbered level, as markup.
function levelRowTag(html, level) {
  const at = html.indexOf(`data-level="${level}"`);
  return html.slice(at, html.indexOf('>', at));
}

// Walks a React element tree and returns the elements that match. Used to reach the tap handlers, which
// renderToStaticMarkup does not render.
function findElements(node, match, found = []) {
  if (Array.isArray(node)) { node.forEach((child) => findElements(child, match, found)); return found; }
  if (!node || typeof node !== 'object' || !node.props) return found;
  if (match(node)) found.push(node);
  findElements(node.props.children, match, found);
  return found;
}

test('the per-spot card renders for a Custom Bet track, reserved for its positions', async () => {
  const { ctx } = await load();
  const html = renderPage(ctx, [customTrack('cb-card', CUSTOM_PROGRESSION, 2)], 'cb-card');
  const box = cardBox(html);
  assert.equal(box.spotRows, 2, 'one row per position');
  assert.match(box.rows, /height:64px/, 'the spot list is 2 rows of 30px and a 4px gap');
  assert.equal((html.match(/data-spot-card=/g) || []).length, 1, 'one card per page');
  assert.match(html, />Bankroll needed</);
  assert.doesNotMatch(html, />Invested</, 'the Invested heading is replaced on custom tracks');
  assert.match(html, /Cumulative stake: the bankroll needed to play up to this level/);
  assert.match(html, /Total bet on all spots this spin/);
});

test('the card shows the current level by default', async () => {
  const { ctx } = await load();
  const html = renderPage(ctx, [customTrack('cb-default', CUSTOM_PROGRESSION, 2)], 'cb-default');
  assert.match(elementAt(html, 'data-spot-card'), /Level 3 - per spot/, 'the track is on index 2, shown as level 3');
  assert.match(levelRowTag(html, 3), /aria-pressed="true"/);
  assert.match(levelRowTag(html, 1), /aria-pressed="false"/);
});

test('selecting level 3 shows level 3 numbers, hand-computed', async () => {
  const { ctx } = await load();
  const html = renderPage(ctx, [customTrack('cb-l3', CUSTOM_PROGRESSION, 0)], 'cb-l3', { trackId: 'cb-l3', index: 2 });
  // Level 3: c 1, totalInvest 6. Straight 17: bet 1, payout 54 (17 grosses 54), net 54 − 6 = 48.
  // Split 17-20: bet 1, payout 18 (its worst number is 20), net 18 − 6 = 12.
  assert.deepEqual(textNodes(elementAt(html, 'data-spot-card')), [
    'Level 3 - per spot', 'Bet per spot', 'Payout if it hits', 'Net if it hits',
    '#17 straight', money(ctx, 1), money(ctx, 54), signed(ctx, 48),
    'Split 17/20', money(ctx, 1), money(ctx, 18), signed(ctx, 12),
  ]);
});

test('selecting level 1 and level 8 shows their own numbers', async () => {
  const { ctx } = await load();
  const track = customTrack('cb-l18', CUSTOM_PROGRESSION, 0);
  // The spot values start after the card's title and two caption lines: text index 4 is the first spot's label.
  const spotTexts = (html) => textNodes(elementAt(html, 'data-spot-card')).slice(4);
  // Level 1: c 1, totalInvest 2. Straight: payout 54, net 54 − 2 = 52. Split: payout 18, net 18 − 2 = 16.
  assert.deepEqual(
    spotTexts(renderPage(ctx, [track], 'cb-l18', { trackId: 'cb-l18', index: 0 })),
    ['#17 straight', money(ctx, 1), money(ctx, 54), signed(ctx, 52), 'Split 17/20', money(ctx, 1), money(ctx, 18), signed(ctx, 16)],
  );
  // Level 8: c 2, totalInvest 18. Straight: bet 2, payout 108 (17 grosses 2×36 + 2×18), net 108 − 18 = 90.
  // Split: bet 2, payout 36 (worst is 20 at 2×18), net 36 − 18 = 18.
  assert.deepEqual(
    spotTexts(renderPage(ctx, [track], 'cb-l18', { trackId: 'cb-l18', index: 7 })),
    ['#17 straight', money(ctx, 2), money(ctx, 108), signed(ctx, 90), 'Split 17/20', money(ctx, 2), money(ctx, 36), signed(ctx, 18)],
  );
});

test('selecting another level leaves the card box unchanged', async () => {
  const { ctx } = await load();
  const track = customTrack('cb-box', CUSTOM_PROGRESSION, 2);
  const boxes = [0, 2, 7].map((index) => cardBox(renderPage(ctx, [track], 'cb-box', { trackId: 'cb-box', index })));
  assert.deepEqual(boxes[1], boxes[0]);
  assert.deepEqual(boxes[2], boxes[0]);
  assert.equal(boxes[0].spotRows, 2);
});

test('the selected row has the active highlight and an outline, and only one row is selected', async () => {
  const { ctx } = await load();
  const track = customTrack('cb-hl', CUSTOM_PROGRESSION, 2);
  const html = renderPage(ctx, [track], 'cb-hl', { trackId: 'cb-hl', index: 4 });
  assert.match(levelRowTag(html, 5), /aria-pressed="true"/);
  assert.match(levelRowTag(html, 5), /outline:2px solid #e2e8f0/);
  assert.match(levelRowTag(html, 3), /aria-pressed="false"/, 'the current row is not selected');
  assert.doesNotMatch(levelRowTag(html, 3), /outline/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
});

test('tapping a level row selects that level', async () => {
  const { ctx } = await load();
  const track = customTrack('cb-tap', CUSTOM_PROGRESSION, 2);
  const picks = [];
  const tree = ctx.TablePageView({
    sess: { tracks: [track] },
    selectedTrackId: 'cb-tap',
    setSelectedTrackId: NOOP,
    nonClosedTracks: [track],
    cur: usd(ctx),
    selectedLevel: null,
    setSelectedLevel: (v) => picks.push(plain(v)),
  });
  const rowFor4 = findElements(tree, (el) => el.props['data-level'] === 4)[0];
  rowFor4.props.onClick();
  assert.deepEqual(picks, [{ trackId: 'cb-tap', index: 3 }], 'level 4 is index 3');
});

test('a selection on one track does not carry to another track', async () => {
  const { ctx } = await load();
  const a = customTrack('cb-sel-a', CUSTOM_PROGRESSION, 0);
  const b = customTrack('cb-sel-b', CUSTOM_PROGRESSION, 4);
  // Track a has a selection of level 1; the page shows track b, so its own current level (level 5) is the card.
  const html = renderPage(ctx, [a, b], 'cb-sel-b', { trackId: 'cb-sel-a', index: 0 });
  assert.match(elementAt(html, 'data-spot-card'), /Level 5 - per spot/);
});

test('tapping a track tab changes only the track (App clears the level pick on that change)', async () => {
  const { ctx } = await load();
  const a = customTrack('cb-tab-a', CUSTOM_PROGRESSION, 2);
  const b = customTrack('cb-tab-b', CUSTOM_PROGRESSION, 0);
  const log = [];
  const tree = ctx.TablePageView({
    sess: { tracks: [a, b] },
    selectedTrackId: 'cb-tab-a',
    setSelectedTrackId: (id) => log.push(['track', id]),
    nonClosedTracks: [a, b],
    cur: usd(ctx),
    selectedLevel: { trackId: 'cb-tab-a', index: 4 },
    setSelectedLevel: (v) => log.push(['level', plain(v)]),
  });
  const tabs = findElements(tree, (el) => el.type === 'button' && typeof el.props.onClick === 'function');
  assert.equal(tabs.length, 2);
  // The tab itself only changes the track. App clears the level pick when the selected track changes.
  tabs[1].props.onClick();
  assert.deepEqual(log, [['track', 'cb-tab-b']]);
});

test('the flat Custom Bet track shows its one level in the card', async () => {
  const { ctx } = await load();
  // Dozen 1-12 base 40 and straight 17 base 1, flat: one level with bankroll needed 41.
  // Dozen: covers 1-12, each grossing 40×3 = 120. Bet 40, payout 120, net 120 − 41 = 79, a win (green).
  // Straight 17: bet 1, grosses 36. Payout 36, net 36 − 41 = −5, a loss (orange).
  const html = renderPage(ctx, [customTrack('cb-flat', [dozen('0', 40), straight('17', 1)], 0, 'flat')], 'cb-flat');
  const card = elementAt(html, 'data-spot-card');
  assert.match(card, /Level 1 - per spot/);
  assert.deepEqual(textNodes(card).slice(4), [
    '1st Dozen 1-12', money(ctx, 40), money(ctx, 120), signed(ctx, 79),
    '#17 straight', money(ctx, 1), money(ctx, 36), signed(ctx, -5),
  ]);
  assert.ok(card.includes(`color:#4ade80">${signed(ctx, 79)}<`), 'the dozen net is green');
  assert.ok(card.includes(`color:#f97316">${signed(ctx, -5)}<`), 'the straight net is orange');
  assert.match(levelRowTag(html, 1), /aria-pressed="true"/);
});

test('a Custom Bet track with no spots keeps the card, reserved for one row', async () => {
  const { ctx } = await load();
  const html = renderPage(ctx, [customTrack('cb-empty', [], 0)], 'cb-empty');
  const card = elementAt(html, 'data-spot-card');
  assert.match(card, /Per spot/);
  assert.match(card, /Add a spot to see its numbers/);
  assert.equal((card.match(/data-spot-row=""/g) || []).length, 0);
  assert.match(cardBox(html).rows, /height:30px/, 'reserved for one row, as a card with one position');
  assert.match(html, />Bankroll needed</);
});
