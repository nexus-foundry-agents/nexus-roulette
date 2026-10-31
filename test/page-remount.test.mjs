import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseSync, traverse, transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';

// A page keeps its local state when App re-renders. The Game page, the Live tracker, the Full Table page and the Edit
// Bankroll sheet used to be declared inside App, so every App render made a new component type and remounted them.
// The recent-numbers strip then went back to its newest 40 chips at scroll 0, and a typed bankroll was lost.
//
// These tests mount the real App under React 18's own reconciler: react-dom's UMD build, run in a vm with a small DOM
// stand-in, as board-photo.test.mjs does. The stand-in is the only fake. React decides what is kept and what is
// remounted. A test loads the strip, makes an unrelated App change (a chip tap), and checks that the same strip element
// still holds its loaded chips and its scroll position.

const ROOT = new URL('../', import.meta.url);
const SRC = new URL('nexus-src/src/', ROOT);
const STORAGE_KEY = 'nexus-roulette-v1'; // constants.js
const STRIP_CLASS = 'nr-recent-strip'; // SpinTools.jsx
const PAGE = 40; // RECENT_STRIP_PAGE, SpinTools.jsx
const CHIP_STEP = 32; // a chip is 28 px with a 4 px gap
const VIEW = 300; // the strip's visible width in these tests
const SCROLL_TO_OLDEST = 830; // 40 chips = 1280 px; 1280 - 300 - 830 leaves 150 px, within one view of the oldest chip drawn
const NUMBERS = Array.from({ length: 100 }, (_, i) => String(i % 37));
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const SETTINGS = {
  currency: 'USD', defaultBuyIn: 100, onboarded: true, vibration: false, showDroughtCounts: true,
  headStartUnseen: false, counterShows: 'spins', percentileOutlines: true, coldestGold: true,
  tableMinBet: 1, tableMaxBet: 500, tableMaxTotal: 10000,
};

const droughtsAfter = (spins) => Object.fromEntries(AMERICAN.map((n) => {
  const at = spins.lastIndexOf(n);
  return [n, at < 0 ? spins.length : spins.length - 1 - at];
}));
const session = (spins, over = {}) => ({
  id: 's', name: 'Session 10/31/2026', created: 1, modified: 1, roulette: 'american', bankroll: 500, bankrollCurrent: 500,
  totalBuyIn: 0, buyIns: [], spins, droughts: droughtsAfter(spins), tracks: [], totalCashOut: 0, cashOuts: [],
  sessionStartedAt: 1, sessionEndedAt: null, mode: 'live', ...over,
});
const seedStore = () => ({
  [STORAGE_KEY]: JSON.stringify({
    savedSessions: [],
    currentSession: session(NUMBERS, { id: 'live', mode: 'live' }),
    gameSession: session(NUMBERS, { id: 'game', mode: 'game' }),
    settings: SETTINGS,
  }),
});

// The bundle, compiled the way build.js concatenates it (the FILES list is read from build.js, so this cannot drift).
let compiled = null;
async function bundleSource() {
  if (compiled) return compiled;
  const build = await readFile(new URL('nexus-src/build.js', ROOT), 'utf8');
  const block = build.match(/const FILES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'build.js declares its FILES list');
  const files = [...block[1].matchAll(/^\s*'([^']+\.(?:js|jsx|mjs))',?(?:\s*\/\/.*)?\s*$/gm)].map((m) => m[1]);
  assert.ok(files.includes('App.jsx'), 'the list ends with App.jsx');
  const parts = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${parts[i]}`).join('\n').replace(/\r\n?/g, '\n');
  compiled = transformSync(combined, {
    babelrc: false,
    configFile: false,
    filename: 'app.jsx',
    presets: [
      [presetReact, { runtime: 'classic' }],
      [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
    ],
  }).code;
  return compiled;
}

// A DOM stand-in: enough tree, attributes, text, styles and listeners for react-dom to commit the App. Listeners
// honour the capture flag, because react-dom registers both phases on its root.
class FakeNode {
  constructor(nodeName, nodeType, ownerDocument) {
    this.nodeName = nodeName;
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.nodeValue = null;
    this.scrollLeft = 0;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get type() { return this.getAttribute('type'); }
  get clientWidth() { return this.getAttribute('class') === STRIP_CLASS ? VIEW : 0; }
  get scrollWidth() { return this.childNodes.length * CHIP_STEP; }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    if (this.nodeType === 3) { this.nodeValue = String(value); return; }
    this.childNodes.forEach((child) => { child.parentNode = null; });
    this.childNodes = [];
    if (value !== '' && value != null) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = this.childNodes.indexOf(before);
    if (at < 0) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(at, 0, child);
    return child;
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error(`removeChild: ${child.nodeName} is not a child of ${this.nodeName}`);
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn, options) {
    const capture = options === true || !!(options && options.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const at = list.findIndex((entry) => entry.fn === fn);
    if (at >= 0) list.splice(at, 1);
  }
  focus() {}
  blur() {}
  scrollBy() {}
}

function fakeDocument() {
  const doc = new FakeNode('#document', 9, null);
  doc.hidden = false;
  // react-dom decides at load whether the browser fires input events by asking the document for an oninput property.
  doc.oninput = null;
  doc.onchange = null;
  doc.activeElement = null;
  doc.createElement = (tag) => new FakeNode(String(tag).toUpperCase(), 1, doc);
  doc.createElementNS = (ns, tag) => {
    const node = new FakeNode(String(tag), 1, doc);
    node.namespaceURI = ns;
    return node;
  };
  doc.createTextNode = (text) => {
    const node = new FakeNode('#text', 3, doc);
    node.nodeValue = String(text);
    return node;
  };
  doc.body = new FakeNode('BODY', 1, doc);
  return doc;
}

// Dispatches in DOM order: capture from the top down, then bubble from the target up.
function dispatch(target, type, init = {}) {
  const event = { type, target, button: 0, clientX: 0, clientY: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, timeStamp: 0, preventDefault() {}, stopPropagation() {}, ...init };
  const path = [];
  for (let node = target; node; node = node.parentNode) path.unshift(node);
  const run = (node, phase) => {
    for (const entry of [...(node.listeners.get(type) || [])]) {
      if (phase === 'capture' ? entry.capture : !entry.capture) entry.fn(event);
    }
  };
  for (const node of path.slice(0, -1)) run(node, 'capture');
  run(target, 'capture');
  run(target, 'bubble');
  for (const node of path.slice(0, -1).reverse()) run(node, 'bubble');
}

// react-dom 18 (production UMD) and the bundle, in one vm realm, with timers held so the test decides when they run.
async function mountApp() {
  const env = { timers: [], errors: [], container: null, root: null, host: null };
  const store = seedStore();
  const host = {};
  vm.createContext(host);
  host.console = { log() {}, info() {}, warn() {}, error(...args) { env.errors.push(args.map(String).join(' ')); } };
  // Scheduler and React use zero-delay timers. App's own timers (flashes, the 3-second clears) are longer and never fire here.
  host.setTimeout = (fn, delay = 0, ...args) => { env.timers.push({ fn, args, delay: Number(delay) || 0, done: false }); return env.timers.length; };
  host.clearTimeout = (id) => { if (env.timers[id - 1]) env.timers[id - 1].done = true; };
  host.setInterval = () => 0;
  host.clearInterval = () => {};
  host.performance = { now: () => 0 };
  host.document = fakeDocument();
  host.window = host;
  host.self = host;
  host.parent = host; // standalone: the App is its own parent, so the Casino bridge is not involved
  host.top = host;
  host.navigator = { userAgent: 'test', vibrate() {} };
  host.location = { hash: '', pathname: '/roulette/', search: '', origin: 'https://roulette.test', href: 'https://roulette.test/roulette/', replace() {}, reload() {} };
  host.history = { state: null, replaceState() {}, pushState() {} };
  host.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
  };
  host.innerWidth = 390;
  host.innerHeight = 844;
  host.addEventListener = () => {};
  host.removeEventListener = () => {};
  host.dispatchEvent = () => true;
  host.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
  host.URL = URL;
  host.URLSearchParams = URLSearchParams;
  host.Blob = Blob;
  host.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options && options.detail; } };
  host.crypto = { randomUUID: () => 'test-uuid' };
  // NO-NATIVE-DIALOGS: every confirm is the in-app dialog. A native browser dialog opened in this page is a failure, not an answer.
  host.confirm = host.alert = host.prompt = () => { throw new Error('a native browser dialog was opened'); };
  host.HTMLIFrameElement = class {}; // react-dom asks whether the active element is an iframe
  host.__runDue = () => {
    const due = env.timers.filter((timer) => !timer.done && timer.delay <= 0);
    for (const timer of due) {
      timer.done = true;
      timer.fn(...timer.args);
    }
    return due.length;
  };
  for (const file of ['react/umd/react.production.min.js', 'react-dom/umd/react-dom.production.min.js']) {
    vm.runInContext(await readFile(new URL(`node_modules/${file}`, ROOT), 'utf8'), host, { filename: file });
  }
  host.module = { exports: {} };
  host.exports = host.module.exports;
  host.require = (name) => {
    if (name === 'react') return host.React;
    if (name === 'react-dom') return host.ReactDOM;
    throw new Error(`unexpected module in the bundle: ${name}`);
  };
  vm.runInContext(await bundleSource(), host, { filename: 'roulette-bundle.js' });
  // The recording transport needs a Casino shell. Standalone it has nothing to send, and this page does not read its state
  // (session-flows.test.mjs stubs it the same way). Set after the bundle, because the bundle declares the function.
  host.useCasinoRecording = () => ({ availability: 'unavailable', session: null, elapsedMs: 0, problem: null, record() {}, pause() {}, resume() {}, stop() {} });
  assert.match(host.React.version, /^18\./, 'the test runs real React 18');

  env.host = host;
  env.container = host.document.createElement('div');
  host.document.body.appendChild(env.container);
  env.root = host.ReactDOM.createRoot(env.container);
  env.root.render(host.React.createElement(host.module.exports.default));
  await settle(env);
  return env;
}

// One pass runs the zero-delay timers queued before it started. Timers that React queues while they run wait for the
// next turn. The pass runs inside the vm under a time limit, so a render that never settles fails the test instead of
// holding the process.
function runZeroDelayTimers(env) {
  try {
    return vm.runInContext("__runDue()", env.host, { timeout: 5000 });
  } catch (error) {
    assert.fail(`the React root did not settle: ${error.code || error.message}`);
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
async function settle(env) {
  for (let round = 0; round < 1000; round += 1) {
    await nextTurn();
    if (runZeroDelayTimers(env) === 0) {
      await nextTurn();
      if (runZeroDelayTimers(env) === 0) return;
    }
  }
  assert.fail('the React root did not settle');
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes) walk(child, visit);
}
function findAll(env, match) {
  const out = [];
  walk(env.container, (node) => { if (match(node)) out.push(node); });
  return out;
}
const isButton = (node) => node.nodeName === 'BUTTON';
function buttonReading(env, label) {
  const hits = findAll(env, (node) => isButton(node) && node.textContent === label);
  assert.ok(hits.length > 0, `a button reads "${label}"`);
  return hits[0];
}
function theStrip(env) {
  const strips = findAll(env, (node) => node.getAttribute('class') === STRIP_CLASS);
  assert.equal(strips.length, 1, 'exactly one recent-numbers strip is on the page');
  return strips[0];
}
const chipCount = (strip) => strip.childNodes.length;

// The reader scrolls the strip to its oldest chip drawn. The strip draws the next page, as it does in a browser.
async function readerReachesOldestChip(env, strip) {
  strip.scrollLeft = SCROLL_TO_OLDEST;
  dispatch(strip, 'scroll');
  await settle(env);
}

// An App change that has nothing to do with the strip: tapping a chip. The check confirms the App really took it.
async function tapChip(env, label) {
  dispatch(buttonReading(env, label), 'click');
  await settle(env);
  assert.equal(buttonReading(env, label).style.boxShadow, '0 0 8px #fbbf24', `the App took the ${label} tap`);
}

test('the Game page keeps its loaded numbers and scroll position when App updates', async () => {
  const env = await mountApp();
  const strip = theStrip(env);
  assert.equal(chipCount(strip), PAGE, 'the first page of chips is drawn');
  await readerReachesOldestChip(env, strip);
  assert.equal(chipCount(theStrip(env)), 2 * PAGE, 'the reader loads the next page');

  await tapChip(env, '$5');

  const after = theStrip(env);
  assert.equal(after, strip, 'the strip is the same mounted element after the App update');
  assert.equal(chipCount(after), 2 * PAGE, 'the loaded chips survive the App update');
  assert.equal(after.scrollLeft, SCROLL_TO_OLDEST, 'the scroll position survives the App update');
});

test('the Live tracker keeps its loaded numbers and scroll position when App updates', async () => {
  const env = await mountApp();
  dispatch(buttonReading(env, '🎰 Live'), 'click');
  await settle(env);
  const strip = theStrip(env);
  assert.equal(chipCount(strip), PAGE, 'the Live tracker draws the first page of chips');
  await readerReachesOldestChip(env, strip);
  assert.equal(chipCount(theStrip(env)), 2 * PAGE, 'the reader loads the next page on the Live tracker');

  await tapChip(env, '$5');

  const after = theStrip(env);
  assert.equal(after, strip, 'the Live strip is the same mounted element after the App update');
  assert.equal(chipCount(after), 2 * PAGE, 'the Live strip keeps its loaded chips');
  assert.equal(after.scrollLeft, SCROLL_TO_OLDEST, 'the Live scroll position survives the App update');
});

test('a bankroll typed in Edit Bankroll survives an unrelated App update', async () => {
  const env = await mountApp();
  const bankButton = findAll(env, (node) => isButton(node) && node.textContent.startsWith('Bank:'))[0];
  assert.ok(bankButton, 'the header shows the bankroll button');
  dispatch(bankButton, 'click');
  await settle(env);
  const field = () => findAll(env, (node) => node.nodeName === 'INPUT' && node.getAttribute('aria-label') === 'Current Bankroll')[0];
  assert.ok(field(), 'Edit Bankroll shows its amount field');
  field().value = '250';
  dispatch(field(), 'input');
  await settle(env);
  assert.equal(field().value, '250', 'the typed amount is in the field before the update');

  await tapChip(env, '$5');

  assert.equal(field().value, '250', 'the typed amount is still in the field after the App update');
});

// The class check (shared rule 72). A component type created inside a component's body is a new type on every render,
// so React remounts it and whatever it holds is lost. Two forms are checked, and both are found from the AST rather than
// from a name search: a capitalised function or class declared inside another function, and a JSX element or
// React.createElement whose type is a binding made inside a function. Each one left must be listed here with the reason
// it holds no user state. A listed entry that no longer exists fails too, so the list cannot go stale.
const KEPT_INSIDE_COMPONENTS = new Map([
  ['components/ui.jsx:Mkr', 'the stone marker on a RouletteBoard number: no hooks, no state; a remount redraws the same markup'],
  ['components/ui.jsx:BetChip', 'a bet chip on the RouletteBoard: no hooks, no state; a remount redraws the same markup'],
  ['components/ui.jsx:StratChipBadge', 'a strategy chip badge on the RouletteBoard: no hooks, no state; a remount redraws the same markup'],
]);

test('no component type is created inside a component body, except the ones listed as kept', async () => {
  const found = new Map();
  const names = (await readdir(SRC, { recursive: true })).filter((f) => /\.(js|jsx|mjs)$/.test(f)).sort();
  for (const name of names) {
    const file = name.split(String.fromCharCode(92)).join('/');
    const code = await readFile(new URL(file, SRC), 'utf8');
    const ast = parseSync(code, { filename: file, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] } });
    const note = (node, id) => found.set(`${file}:${id}`, node.loc.start.line);
    const boundInFunction = (path, id) => {
      const binding = path.scope.getBinding(id);
      return !!binding && !binding.scope.path.isProgram();
    };
    traverse(ast, {
      'FunctionDeclaration|ClassDeclaration|VariableDeclarator'(path) {
        const node = path.node;
        let id = null;
        if (node.type === 'VariableDeclarator') {
          const init = node.init;
          if (!init || !(init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) return;
          id = node.id && node.id.type === 'Identifier' ? node.id.name : null;
        } else {
          id = node.id ? node.id.name : null;
        }
        if (!id || !/^[A-Z]/.test(id)) return;
        if (!path.getFunctionParent()) return;
        note(node, id);
      },
      JSXOpeningElement(path) {
        const nm = path.node.name;
        if (nm.type !== 'JSXIdentifier' || !/^[A-Z]/.test(nm.name)) return;
        if (boundInFunction(path, nm.name)) note(path.node, nm.name);
      },
      CallExpression(path) {
        const callee = path.node.callee;
        const isCreate = (callee.type === 'MemberExpression' && callee.property.name === 'createElement')
          || (callee.type === 'Identifier' && callee.name === 'createElement');
        const first = path.node.arguments[0];
        if (!isCreate || !first || first.type !== 'Identifier') return;
        if (boundInFunction(path, first.name)) note(path.node, first.name);
      },
    });
  }
  const unlisted = [...found.keys()].filter((key) => !KEPT_INSIDE_COMPONENTS.has(key));
  assert.deepEqual(unlisted, [], 'component types created inside a component body, with no entry in the kept list');
  const stale = [...KEPT_INSIDE_COMPONENTS.keys()].filter((key) => !found.has(key));
  assert.deepEqual(stale, [], 'kept-list entries that no longer exist: remove them');
});

test('App.jsx stays under 900 lines', async () => {
  const app = await readFile(new URL('nexus-src/src/App.jsx', ROOT), 'utf8');
  const lines = (app.match(/\n/g) || []).length;
  assert.ok(lines < 900, `App.jsx is ${lines} lines; it must stay under 900`);
});
