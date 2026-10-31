import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// The Game page mounts the shared recent-numbers strip (RecentNumbersStrip in SpinTools.jsx) and draws no ticker of its
// own. These tests load every file in build.js's FILES list, in that order, so GamePageView can be called for a session.
// The element the page returns for the strip is then mounted under a hook runner (the one test/strip-lazy.test.mjs uses),
// so its paging and long-press run as they do on the page. The bundle's React root is not loaded: it needs a DOM.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const PAGE = 40;   // RECENT_STRIP_PAGE in SpinTools.jsx
const CHIP = 28;   // a chip is 28 px, with a 4 px gap
const GAP = 4;
const VIEW = 300;  // the strip's visible width in these tests, in px
const SPINS = (n) => Array.from({ length: n }, (_, i) => String((i * 7) % 36 + 1));

// Answers the strip's hooks while mountStrip() renders it. Outside it the hooks are React's own.
let runner = null;
const delegate = (name) => (...args) => (runner ? runner[name](...args) : React[name](...args));
const runtime = {
  ...React,
  useState: delegate('useState'),
  useRef: delegate('useRef'),
  useMemo: delegate('useMemo'),
  useEffect: delegate('useEffect'),
  useContext: delegate('useContext'),
};

// The bundle's file list, read from build.js so this test cannot drift from what ships.
async function bundleFiles() {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const block = build.match(/const FILES = \[([\s\S]*?)\];/);
  assert.ok(block, 'build.js declares the FILES list');
  return [...block[1].matchAll(/^\s*'([^']+\.(?:js|jsx|mjs))',?(?:\s*\/\/.*)?\s*$/gm)].map((m) => m[1]);
}

let loaded = null;
const load = () => { if (!loaded) loaded = loadBundle(); return loaded; };

async function loadBundle() {
  const files = await bundleFiles();
  assert.ok(files.includes('components/GamePage.jsx') && files.includes('components/SpinTools.jsx'), 'the list has both pages');
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
  const timers = [];
  const store = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    React: runtime,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => (name === 'react' ? runtime : {}),
    navigator: { userAgent: 'test', vibrate() {} },
    // The long-press timers. Recorded, so a test fires the one it means to.
    setTimeout: (fn) => { timers.push({ fn, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    addEventListener() {},
    removeEventListener() {},
  };
  ctx.module = { exports: {} };
  ctx.exports = ctx.module.exports;
  ctx.window = ctx;
  ctx.window.parent = ctx; // a standalone page: window.parent === window (session.js reads it at load)
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'game-page-bundle.js' });
  return { ctx, timers };
}

// Every element in a tree that matches. Children may be single elements, arrays or text.
function findAll(node, match, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) findAll(child, match, out); return out; }
  if (match(node)) out.push(node);
  return findAll(node.props && node.props.children, match, out);
}
const isChip = (node) => !!node.props && typeof node.props.onPointerDown === 'function';
const isScroller = (node) => !!node.props && typeof node.props.onScroll === 'function';
const labelled = (label) => (node) => !!node.props && node.props['aria-label'] === label;

// The props App passes GamePageView (App.jsx, GamePage()). Only the ones the strip reads matter here; the handlers are
// inert, because these tests make no spin, bet or track change.
function gamePageTree(ctx, spins) {
  const sess = { spins, tracks: [], droughts: {}, roulette: 'american', sessionStartedAt: null, bankrollCurrent: 0 };
  return ctx.GamePageView({
    addOpen: false, addTrack() {}, animNumber: null, betResults: null, clearTimerRef: { current: null },
    closeTrack() {}, colD: {}, colP: {}, cur: { symbol: '$' }, currency: 'USD', dozD: {}, dozP: {}, editTrackId: null,
    emDroughts: {}, endSession() {}, recordGameSpin() {}, gameResult: null, gameSpinning: false, isLandscape: false,
    lastBets: [], lastSpinDelta: null, manualBets: [], nextColorIdx: 0, nonClosedTracks: [], parkToggle() {},
    pendingTrackCfg: {}, pendingTrackType: 'fibonacci', pnlVal: 0, saveSession() {}, selectedChip: 1, sess,
    setAddOpen() {}, setAnimNumber() {}, setBetResults() {}, setEditTrackId() {}, setGameResult() {},
    setGameSpinning() {}, setLastBets() {}, setLastSpinDelta() {}, setManualBets() {}, setPendingTrackCfg() {},
    setPendingTrackType() {}, setSelectedChip() {}, setUndoStack() {},
    settings: { tableMinBet: 1, coldestGold: true, showDroughtCounts: true }, tapNumber() {}, updSess() {},
    updateTrackConfig() {}, wheelNums: [],
  });
}
const stripElements = (tree, ctx) => findAll(tree, (node) => node.type === ctx.RecentNumbersStrip);

// Mounts the strip under a runner that does what React does for the hooks it uses: state, refs, memo, effects and
// context. Effects run after each render, and a state change renders again. The scroller's DOM node is a stand-in with
// the measurements the strip reads. Its width follows the chips drawn, and its scroll is clamped, as a browser's is.
async function mountStrip(props, { openSpin = () => {} } = {}) {
  const { ctx, timers } = await load();
  const slots = [];
  const pending = [];
  let cursor = 0;
  let dirty = true;
  const changed = (before, after) => !before || !after || after.length !== before.length
    || after.some((value, i) => !Object.is(value, before[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      if (!slot.set) {
        slot.set = (value) => {
          const next = typeof value === 'function' ? value(slot.value) : value;
          if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
        };
      }
      return [slot.value, slot.set];
    },
    useRef(initial) { const i = cursor++; if (!slots[i]) slots[i] = { current: initial }; return slots[i]; },
    useMemo(run, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: run(), deps };
      return slots[i].value;
    },
    useEffect(run, deps) {
      const i = cursor++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, cleanup: previous && previous.cleanup };
        pending.push(() => { if (slots[i].cleanup) slots[i].cleanup(); slots[i].cleanup = run(); });
      }
    },
    useContext() { return openSpin; },
  };
  const dom = {
    scrollLeft: 0, clientWidth: VIEW, scrollWidth: 0, scrolls: [],
    scrollBy(options) { this.scrolls.push(options); },
  };
  const state = { props, tree: null };
  function render() {
    cursor = 0;
    dirty = false;
    const previous = runner;
    runner = hooks;
    try { state.tree = ctx.RecentNumbersStrip(state.props); } finally { runner = previous; }
    const scroller = findAll(state.tree, isScroller)[0];
    if (!scroller.ref.current) scroller.ref.current = dom;
    const drawn = findAll(state.tree, isChip).length;
    dom.scrollWidth = drawn ? drawn * (CHIP + GAP) - GAP : 0;
    dom.scrollLeft = Math.max(0, Math.min(dom.scrollLeft, dom.scrollWidth - dom.clientWidth));
  }
  function settle() {
    for (let i = 0; i < 500; i += 1) {
      if (dirty) { render(); continue; }
      if (pending.length) { pending.splice(0).forEach((run) => run()); continue; }
      return;
    }
    throw new Error('the strip did not settle');
  }
  settle();
  const chips = () => findAll(state.tree, isChip);
  const handle = {
    dom,
    tree: () => state.tree,
    chips,
    values: () => Array.from(chips(), (chip) => chip.props.children),
    keys: () => Array.from(chips(), (chip) => chip.key),
    pager: (label) => findAll(state.tree, labelled(label))[0],
    scroller: () => findAll(state.tree, isScroller)[0],
    scrollTo(left) {
      dom.scrollLeft = Math.max(0, Math.min(left, dom.scrollWidth - dom.clientWidth));
      handle.scroller().props.onScroll();
      settle();
    },
    scrollToEnd() { handle.scrollTo(dom.scrollWidth - dom.clientWidth); },
    // A press on chip `position` (0 is the newest), held past the long-press delay.
    pressChip(position) {
      const before = timers.length;
      chips()[position].props.onPointerDown({ button: 0, clientX: 5, clientY: 5 });
      timers.slice(before).filter((timer) => !timer.cleared).forEach((timer) => timer.fn());
    },
  };
  return handle;
}

test('source: GamePage.jsx has no 30-spin slice and no ticker of its own, and mounts the shared strip once with correction off', async () => {
  const page = await readFile(new URL('components/GamePage.jsx', SRC), 'utf8');
  assert.doesNotMatch(page, /\.slice\(0,\s*30\)/, 'the 30-spin slice is gone');
  assert.doesNotMatch(page, /recentSpins/, 'no recentSpins list is built');
  assert.doesNotMatch(page, /width:28,height:28,borderRadius:6/, 'no chip of its own (the shared strip draws the chips)');
  assert.equal([...page.matchAll(/<RecentNumbersStrip\b/g)].length, 1, 'the page mounts the strip once');
  assert.match(page, /<RecentNumbersStrip spins=\{sess\.spins\} correctable=\{false\}\/>/, 'no track overlays, correction off');
});

test('Game page, 100 spins: forty first, then eighty, then every spin, newest first, with the same pager buttons', async () => {
  const { ctx } = await load();
  const spins = SPINS(100);
  const [strip] = stripElements(gamePageTree(ctx, spins), ctx);
  assert.ok(strip, 'the Game page returns the shared strip');
  assert.equal(strip.type, ctx.RecentNumbersStrip);
  const mounted = await mountStrip(strip.props);
  assert.equal(mounted.chips().length, PAGE, 'the first page is forty');
  assert.deepStrictEqual(mounted.values(), spins.slice(-PAGE).reverse(), 'the newest forty, newest first');
  assert.equal(mounted.pager('Newer numbers').props.style.visibility, 'hidden', 'Newer is hidden at the newest end');
  assert.equal(mounted.pager('Older numbers').props.style.visibility, 'visible', 'Older is shown with spins to scroll to');
  mounted.scrollToEnd();
  assert.equal(mounted.chips().length, 80, 'the second page loads when the reader reaches the oldest chip drawn');
  mounted.scrollToEnd();
  assert.equal(mounted.chips().length, 100, 'the last page draws every spin');
  assert.deepStrictEqual(mounted.values(), spins.slice().reverse(), 'every spin, newest first');
  assert.equal(mounted.keys()[0], '99', 'the newest spin is the first chip');
  assert.equal(mounted.pager('Older numbers').props.style.visibility, 'visible', 'Older stays until the reader reaches the oldest chip');
  mounted.scrollToEnd();
  assert.equal(mounted.pager('Older numbers').props.style.visibility, 'hidden', 'Older is hidden at the oldest end');
});

test('Game page, a session of 1,000 spins: no limit, the strip loads a page at a time until all are drawn', async () => {
  const { ctx } = await load();
  const spins = SPINS(1000);
  const [strip] = stripElements(gamePageTree(ctx, spins), ctx);
  const mounted = await mountStrip(strip.props);
  let guard = 0;
  while (mounted.chips().length < spins.length) {
    mounted.scrollToEnd();
    guard += 1;
    assert.ok(guard < 100, 'the strip keeps loading until every spin is drawn');
  }
  assert.equal(mounted.chips().length, 1000);
  assert.deepStrictEqual(mounted.values(), spins.slice().reverse(), 'every spin is reachable, newest first');
});

test('Game page, no spins: the strip keeps its reserved row and draws no chips', async () => {
  const { ctx } = await load();
  const [strip] = stripElements(gamePageTree(ctx, []), ctx);
  const mounted = await mountStrip(strip.props);
  assert.equal(mounted.chips().length, 0);
  assert.equal(mounted.tree().props.style.minHeight, 40, 'the row is reserved before the first spin');
});

test('Game page: a press and hold on a number does not open the spin correction, even with the Live correction above it', async () => {
  const { ctx } = await load();
  const spins = SPINS(60);
  const [strip] = stripElements(gamePageTree(ctx, spins), ctx);
  assert.equal(strip.props.correctable, false, 'the Game page turns correction off');
  const opened = [];
  // The Game page arm: its own props, with a correction provider above it, as the Live page has.
  const game = await mountStrip(strip.props, { openSpin: (index) => opened.push(index) });
  game.pressChip(0);
  game.pressChip(39);
  assert.deepStrictEqual(opened, [], 'no picker opens on the Game page');
  // The control arm: the same spins and the same provider, with correctable left at its default, as the Live page passes it.
  const live = await mountStrip({ spins: strip.props.spins }, { openSpin: (index) => opened.push(index) });
  live.pressChip(0);
  live.pressChip(39);
  assert.deepStrictEqual(opened, [59, 20], 'the Live arm opens the picker for the spin under each press');
});
