import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// The recent-numbers strip (nexus-src/src/components/SpinTools.jsx), loaded the way build.js concatenates it. The hooks
// the strip uses are answered by a small runner here, so a scroll, a page load and a long-press can be driven and the
// element tree read back. Outside a runner the strip gets React's own hooks, so static markup is what React renders.

const SRC = new URL('../nexus-src/src/', import.meta.url);
// The slice clear-spins.test.mjs loads: the strip's dependencies, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js',
  'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs', 'components/ui.jsx', 'components/SpinTools.jsx',
];

const PAGE = 40;   // RECENT_STRIP_PAGE in SpinTools.jsx
const CHIP = 28;   // a chip is 28 px
const GAP = 4;     // with a 4 px gap between chips
const VIEW = 300;  // the strip's visible width in these tests, in px
const plain = (value) => JSON.parse(JSON.stringify(value));
const SPINS = (n) => Array.from({ length: n }, (_, i) => String((i * 7) % 36 + 1));

// Answers the strip's hooks while mount() renders it. Outside mount() the hooks are React's own (static markup).
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

let loaded = null;
const load = () => { if (!loaded) loaded = loadSlice(); return loaded; };

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
    require: (name) => {
      if (name === 'react') return runtime;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
    // The long-press timers. Recorded, so a test fires the one it means to.
    setTimeout: (fn) => { timers.push({ fn, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    addEventListener() {},
    removeEventListener() {},
  };
  ctx.module = { exports: {} };
  ctx.exports = ctx.module.exports;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'strip-slice.js' });
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

async function markup(props) {
  const { ctx } = await load();
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.RecentNumbersStrip, props));
}

// Mounts the strip under a runner that does what React does for the hooks it uses: state, refs, memo, effects and
// context. Effects run after each render, and a state change renders again. The scroller's DOM node is a stand-in with
// the measurements the strip reads. Its width follows the chips drawn, as a browser's would, and its scroll is clamped.
async function mount(props, { openSpin = () => {} } = {}) {
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
    // A browser clamps the scroll position when the content shrinks, as it does when the numbers are cleared.
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
    scroller: () => findAll(state.tree, isScroller)[0],
    pager: (label) => findAll(state.tree, labelled(label))[0],
    update(nextProps) { state.props = nextProps; dirty = true; settle(); },
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

// Scrolls to the oldest end until every spin is drawn.
function loadAll(mounted, total) {
  let guard = 0;
  while (mounted.chips().length < total) {
    mounted.scrollToEnd();
    guard += 1;
    assert.ok(guard < 100, 'the strip keeps loading until every spin is drawn');
  }
}

test('a session of 1,000 spins draws the newest forty chips first, newest first, on the first render', async () => {
  const spins = SPINS(1000);
  const html = await markup({ spins, trackOverlays: [] });
  const drawn = [...html.matchAll(/width:28px;height:28px;[^"]*">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepStrictEqual(drawn, spins.slice(-PAGE).reverse());
  const mounted = await mount({ spins, trackOverlays: [] });
  assert.deepStrictEqual(mounted.values(), spins.slice(-PAGE).reverse());
  assert.equal(mounted.keys()[0], '999', 'the newest spin is the first chip');
});

test('the strip draws forty more each time the reader nears the end, until all 1,000 spins are drawn', async () => {
  const spins = SPINS(1000);
  const mounted = await mount({ spins, trackOverlays: [] });
  const counts = [mounted.chips().length];
  while (mounted.chips().length < spins.length) {
    mounted.scrollToEnd();
    counts.push(mounted.chips().length);
    assert.ok(counts.length <= 30, 'loading stops once every spin is drawn');
  }
  assert.deepStrictEqual(counts, Array.from({ length: 25 }, (_, k) => Math.min(1000, (k + 1) * PAGE)));
  assert.deepStrictEqual(mounted.values(), spins.slice().reverse(), 'every spin is drawn once, newest first');
});

test('the strip does not load while the reader is far from the end', async () => {
  const mounted = await mount({ spins: SPINS(1000), trackOverlays: [] });
  mounted.scrollTo(400); // 576 px from the oldest chip drawn: more than one strip width
  assert.equal(mounted.chips().length, PAGE);
  mounted.scrollTo(0);
  assert.equal(mounted.chips().length, PAGE);
});

test('a chip drawn on a later page keeps its spin: a long-press on it corrects that spin', async () => {
  const spins = SPINS(1000);
  const opened = [];
  const mounted = await mount({ spins, trackOverlays: [] }, { openSpin: (index) => opened.push(index) });
  loadAll(mounted, 1000);
  assert.deepStrictEqual(mounted.keys(), spins.map((_, i) => String(i)).reverse(), 'every chip is keyed by its spin');
  const probes = [0, 39, 40, 500, 959, 960, 999];
  for (const position of probes) mounted.pressChip(position);
  assert.deepStrictEqual(opened, probes.map((p) => 999 - p), 'each press opens the picker for the spin under it');
  probes.forEach((p, k) => assert.equal(mounted.values()[p], spins[opened[k]], 'the pressed chip shows that spin'));
});

test('a track colour border reaches a chip drawn on a later page, and the newest chip stays white', async () => {
  const spins = SPINS(1000);
  spins[10] = '13'; // drawn only once the strip has loaded every spin
  const overlays = [{ type: 'solution', color: '#22d3ee', activeBets: [{ number: '13' }] }];
  const mounted = await mount({ spins, trackOverlays: overlays });
  loadAll(mounted, 1000);
  const late = mounted.chips().find((chip) => chip.key === '10');
  assert.equal(late.props.style.border, '2px solid #22d3ee');
  const untracked = mounted.chips().find((chip) => chip.key === '11');
  assert.notEqual(untracked.props.style.border, '2px solid #22d3ee');
  assert.equal(mounted.chips()[0].props.style.border, '2px solid #ffffff');
});

test('a new spin appears at the front at once, and the drawn page keeps its length', async () => {
  const spins = SPINS(1000);
  const mounted = await mount({ spins, trackOverlays: [] });
  mounted.scrollToEnd();
  assert.equal(mounted.chips().length, 2 * PAGE);
  mounted.update({ spins: [...spins, '36'], trackOverlays: [] });
  assert.equal(mounted.chips().length, 2 * PAGE);
  assert.equal(mounted.values()[0], '36');
  assert.equal(mounted.values()[1], spins[999]);
  assert.equal(mounted.keys()[0], '1000');
});

test('clearing the numbers returns the strip to its first page', async () => {
  const mounted = await mount({ spins: SPINS(1000), trackOverlays: [] });
  mounted.scrollToEnd();
  mounted.scrollToEnd();
  assert.equal(mounted.chips().length, 3 * PAGE);
  mounted.update({ spins: [], trackOverlays: [] });
  assert.equal(mounted.chips().length, 0);
  mounted.update({ spins: SPINS(200), trackOverlays: [] });
  assert.equal(mounted.chips().length, PAGE);
});

test('the pager buttons keep the same box and the same children in every state; only their visibility changes', async () => {
  const visibility = (button) => button.props.style.visibility;
  const box = (button) => { const { visibility: _unused, ...rest } = button.props.style; return JSON.stringify(rest); };
  const boxes = { newer: new Set(), older: new Set() };
  async function state(name, mounted, expected) {
    const newer = mounted.pager('Newer numbers');
    const older = mounted.pager('Older numbers');
    assert.ok(newer && older, `${name}: both pager buttons are rendered`);
    assert.equal(mounted.tree().props.children.length, 4, `${name}: the row keeps the same four children`);
    assert.equal(mounted.tree().props.style.minHeight, 40, `${name}: the row keeps its reserved height`);
    assert.equal(visibility(newer), expected.newer ? 'visible' : 'hidden', `${name}: Newer`);
    assert.equal(visibility(older), expected.older ? 'visible' : 'hidden', `${name}: Older`);
    assert.equal(newer.props['aria-hidden'], !expected.newer, `${name}: Newer is hidden from assistive tech with its visibility`);
    assert.equal(older.props['aria-hidden'], !expected.older, `${name}: Older is hidden from assistive tech with its visibility`);
    boxes.newer.add(box(newer));
    boxes.older.add(box(older));
  }
  await state('no numbers', await mount({ spins: [], trackOverlays: [] }), { newer: false, older: false });
  await state('five numbers, none to scroll to', await mount({ spins: SPINS(5), trackOverlays: [] }), { newer: false, older: false });
  const long = await mount({ spins: SPINS(1000), trackOverlays: [] });
  await state('a thousand numbers, at the newest end', long, { newer: false, older: true });
  long.scrollTo(400);
  await state('a thousand numbers, mid-strip', long, { newer: true, older: true });
  loadAll(long, 1000);
  long.scrollToEnd();
  await state('a thousand numbers, all drawn, at the oldest end', long, { newer: true, older: false });
  assert.equal(boxes.newer.size, 1, 'the Newer box is the same in every state');
  assert.equal(boxes.older.size, 1, 'the Older box is the same in every state');
});

test('the strip hides its scrollbar: inline for the standard and Firefox, a scoped rule for webkit (markup, not a browser run)', async () => {
  const html = await markup({ spins: SPINS(40), trackOverlays: [] });
  assert.match(html, /scrollbar-width:none/);
  assert.match(html, /-ms-overflow-style:none/);
  assert.match(html, /\.nr-recent-strip::-webkit-scrollbar\{display:none\}/);
  const mounted = await mount({ spins: SPINS(40), trackOverlays: [] });
  const scroller = mounted.scroller();
  assert.equal(scroller.props.className, 'nr-recent-strip');
  assert.equal(scroller.props.style.scrollbarWidth, 'none');
  assert.equal(scroller.props.style.overflowX, 'auto', 'the strip still scrolls by finger');
});

test('Newer and Older scroll the strip by one strip width, in the direction of their labels', async () => {
  const mounted = await mount({ spins: SPINS(1000), trackOverlays: [] });
  mounted.pager('Older numbers').props.onClick();
  mounted.pager('Newer numbers').props.onClick();
  assert.deepStrictEqual(plain(mounted.dom.scrolls), [
    { left: VIEW, behavior: 'smooth' },
    { left: -VIEW, behavior: 'smooth' },
  ]);
});

test('the paging arithmetic: the edges, the next page, and no load on a strip that has not been measured', async () => {
  const { ctx } = await load();
  assert.equal(ctx.RECENT_STRIP_PAGE, PAGE);
  assert.deepStrictEqual(plain(ctx.stripPosition({ scrollLeft: 0, scrollWidth: 1276, clientWidth: 300, shown: 40, total: 1000 })),
    { atNewest: true, hasOlder: true, needsMore: false });
  assert.deepStrictEqual(plain(ctx.stripPosition({ scrollLeft: 976, scrollWidth: 1276, clientWidth: 300, shown: 40, total: 1000 })),
    { atNewest: false, hasOlder: true, needsMore: true });
  assert.deepStrictEqual(plain(ctx.stripPosition({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0, shown: 40, total: 1000 })),
    { atNewest: true, hasOlder: true, needsMore: false }, 'a strip with no width is not loaded on that alone');
  assert.deepStrictEqual(plain(ctx.stripPosition({ scrollLeft: 0, scrollWidth: 156, clientWidth: 300, shown: 5, total: 5 })),
    { atNewest: true, hasOlder: false, needsMore: false });
  assert.equal(ctx.nextStripPage(40, 1000), 80);
  assert.equal(ctx.nextStripPage(980, 1000), 1000, 'never past the spins there are');
  assert.equal(ctx.nextStripPage(0, 0), 0);
});
