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
const US = 'https://nexusfoundry.app/roulette/read-board?wheel=american';
const EU = 'https://nexusfoundry.app/roulette/read-board?wheel=european';

// The files the bundle concatenates ahead of the pieces these tests use, in build.js order.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'spin-apply.js',
  'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs', 'casino-recording.mjs', 'components/ui.jsx', 'components/SpinTools.jsx', 'components/BoardPhoto.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global scope.
// Nothing is copied from source; the functions under test are the ones the bundle runs.
const compiledSlices = new Map();
async function loadSlice({ framed = false, app = false, mutate = (source) => source, react = React } = {}) {
  const build = app && await readFile(new URL("../nexus-src/build.js", import.meta.url), "utf8");
  const files = app ? [...build.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/^\s*\x27([^\x27]+)\x27/gm)].map(m => m[1]) : SLICE;
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = mutate(files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n'));
  let code = compiledSlices.get(combined);
  if (!code) {
    ({ code } = transformSync(combined, {
      babelrc: false,
      configFile: false,
      filename: 'app.jsx',
      presets: [
        [presetReact, { runtime: 'classic' }],
        [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
      ],
    }));
    compiledSlices.set(combined, code);
  }
  const store = {};
  const messages = new Set();
  const posted = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React: react,
    setTimeout, clearTimeout,
    addEventListener(name, listener) { if (name === 'message') messages.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') messages.delete(listener); },
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return react;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = framed ? { postMessage(data, origin) { posted.push({ data, origin }); } } : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  const emit = (data, origin = 'https://casino.nexus-foundry.ai', source = sandbox.parent) => {
    for (const listener of messages) listener({ data, origin, source });
  };
  const hello = () => emit({ kind: 'nexus-casino:recording:hello', gameId: 'roulette' });
  const reply = (request, body, extra = {}) => emit({
    kind: 'nexus-casino:recording:response', id: request.data.id, op: request.data.op,
    ok: true, status: 200, body, ...extra,
  });
  return { ctx: sandbox, posted, emit, hello, reply };
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

// The opening tag of the element whose text is `text`.
function tagOf(html, text) {
  const at = html.indexOf(text);
  assert.ok(at > 0, `"${text}" is in the markup`);
  const start = html.lastIndexOf('<', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

// The text a reader sees: tags removed, the entities the renderer escapes decoded.
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

const parse = async (hash, wheel) => plain((await load()).ctx.parseBoardReturn(hash, wheel));
const fakeHistory = () => {
  const calls = [];
  return { state: null, calls, replaceState(state, title, url) { calls.push(url); } };
};

// -- The button and its destination --

test('the photo button opens the constant URL for the session wheel, in this tab', async () => {
  const { ctx } = await load();
  assert.equal(ctx.boardPhotoUrl('american'), US);
  assert.equal(ctx.boardPhotoUrl('european'), EU);
  const opened = [];
  ctx.openBoardPhoto({ assign: (url) => opened.push(url) }, 'european');
  ctx.openBoardPhoto({ assign: (url) => opened.push(url) }, 'american');
  assert.deepEqual(opened, [EU, US]);
});

test('the photo button sits in column 1 of the row, enabled, in every row state', async () => {
  const { ctx } = await load();
  const row = (props) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SpinTools, {
    spinCount: 0, confirmOpen: false, undoVisible: false,
    onAsk() {}, onCancel() {}, onConfirm() {}, onUndo() {}, onReadPhoto() {}, ...props,
  }));
  const states = [{ spinCount: 0 }, { spinCount: 5 }, { spinCount: 0, undoVisible: true }];
  const htmls = states.map(row);
  const tags = htmls.map((h) => tagOf(h, 'Read board photo'));
  assert.ok(tags.every((t) => t === tags[0]), 'the same button tag in every state');
  assert.doesNotMatch(tags[0], /disabled/, 'never disabled, so the row has the same disabled-free shape');
  assert.match(tags[0], /grid-column:1;/);
  assert.match(tagOf(htmls[0], 'Clear numbers'), /grid-column:2;/, 'Clear numbers moved to column 2');
});

// -- Parsing the return: untrusted input --

test('a valid return reads its numbers in board order', async () => {
  assert.deepEqual(await parse('#readboard=ok:16,4,0,00', 'american'), { kind: 'numbers', numbers: ['16', '4', '0', '00'] });
  assert.deepEqual(await parse('#readboard=ok:36,1,0', 'european'), { kind: 'numbers', numbers: ['36', '1', '0'] });
  assert.deepEqual(await parse('#readboard=ok:5', 'american'), { kind: 'numbers', numbers: ['5'] });
});

test('malformed returns are rejected whole and read as unreadable', async () => {
  const malformed = [
    '#readboard=ok', '#readboard=ok:', '#readboard=ok:16,,4', '#readboard=ok:16,', '#readboard=ok:,16',
    '#readboard=ok:abc', '#readboard=ok:05', '#readboard=ok:+5', '#readboard=ok:-1', '#readboard=ok:1.5',
    '#readboard=ok:37', '#readboard=ok:16 ,4', '#readboard=ok: 16', '#readboard=ok:16,4,99',
  ];
  for (const hash of malformed) {
    assert.deepEqual(await parse(hash, 'american'), { kind: 'status', status: 'unreadable' }, hash);
  }
});

test('a return of more than forty numbers is rejected; forty is accepted', async () => {
  const forty = Array.from({ length: 40 }, (_, i) => String(i % 37));
  assert.equal((await parse(`#readboard=ok:${forty.join(',')}`, 'european')).kind, 'numbers');
  assert.deepEqual(
    await parse(`#readboard=ok:${forty.concat(['7']).join(',')}`, 'european'),
    { kind: 'status', status: 'unreadable' },
    'forty-one entries',
  );
});

test('00 is read only on an American wheel', async () => {
  assert.deepEqual(await parse('#readboard=ok:00,1', 'american'), { kind: 'numbers', numbers: ['00', '1'] });
  assert.deepEqual(await parse('#readboard=ok:00,1', 'european'), { kind: 'status', status: 'unreadable' });
});

test('an unknown status is ignored; a known status is read as its status', async () => {
  assert.equal(await parse('#readboard=wat', 'american'), null);
  assert.equal(await parse('#readboard=okay:16', 'american'), null);
  assert.equal(await parse('#readboard=busy:now', 'american'), null, 'a status takes no suffix');
  assert.deepEqual(await parse('#readboard=busy', 'american'), { kind: 'status', status: 'busy' });
  assert.deepEqual(await parse('#readboard=canceled', 'american'), { kind: 'status', status: 'canceled' });
});

test('an injection-looking value is rejected whole', async () => {
  const hostile = [
    '#readboard=ok:16);alert(1)',
    '#readboard=ok:<img src=x onerror=alert(1)>',
    '#readboard=ok:16%2C4',
    '#readboard=ok:__proto__',
    '#readboard=ok:constructor',
    '#readboard=ok:16,4,"0"',
  ];
  for (const hash of hostile) {
    assert.deepEqual(await parse(hash, 'american'), { kind: 'status', status: 'unreadable' }, hash);
  }
});

test('a hash that is not a return of this page is left alone', async () => {
  assert.equal(await parse('#other=ok:16', 'american'), null);
  assert.equal(await parse('', 'american'), null);
  assert.equal(await parse(undefined, 'american'), null);
});

// -- Reading the URL: once, and cleared --

test('the return is read from location.hash alone, and the hash is cleared at once', async () => {
  const { ctx } = await load();
  const hist = fakeHistory();
  const loc = { hash: '#readboard=ok:5,17,0', pathname: '/roulette/', search: '?v=3' };
  assert.deepEqual(plain(ctx.takeBoardReturn(loc, hist, 'american')), { kind: 'numbers', numbers: ['5', '17', '0'] });
  assert.deepEqual(hist.calls, ['/roulette/?v=3'], 'the URL is rewritten without the hash');
  // The browser now holds no hash. A reload finds nothing to read, so nothing reappears.
  loc.hash = '';
  assert.equal(ctx.takeBoardReturn(loc, hist, 'american'), null);
  assert.equal(hist.calls.length, 1);
});

test('the search string is not read as a return, and a page with none is not rewritten', async () => {
  const { ctx } = await load();
  const hist = fakeHistory();
  const loc = { hash: '', search: '?readboard=ok:16', pathname: '/roulette/' };
  assert.equal(ctx.takeBoardReturn(loc, hist, 'american'), null);
  assert.equal(hist.calls.length, 0);
});

test('an unknown return is still cleared from the URL and shows nothing; canceled shows nothing', async () => {
  const { ctx } = await load();
  const hist = fakeHistory();
  const loc = { hash: '#readboard=wat', pathname: '/roulette/', search: '' };
  assert.equal(ctx.takeBoardReturn(loc, hist, 'american'), null);
  assert.deepEqual(hist.calls, ['/roulette/']);
  loc.hash = '#readboard=canceled';
  assert.equal(ctx.takeBoardReturn(loc, hist, 'american'), null);
  assert.deepEqual(hist.calls, ['/roulette/', '/roulette/']);
});

// -- Adding: oldest first, through the spin path --

test('Add enters the numbers oldest first, so the spins end with the most recent number', async () => {
  const { ctx } = await load();
  const board = ['16', '4', '0', '00']; // the board lists the most recent first
  const order = plain(ctx.boardAddOrder(board));
  assert.deepEqual(order, ['00', '0', '4', '16']);
  assert.deepEqual(board, ['16', '4', '0', '00'], 'the board order is not changed');
  let sess = plain(ctx.newSession('american', 500));
  for (const v of order) sess = plain(ctx.applySpin(sess, v, false).sess);
  assert.deepEqual(sess.spins, ['00', '0', '4', '16']);
  assert.equal(sess.spins[sess.spins.length - 1], board[0], 'the last spin entered is the most recent number');
});

// -- The review and the status line --

test('the review shows the numbers in board order, with Add and Cancel, on the shared Modal', async () => {
  const { ctx } = await load();
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BoardPhotoReview, {
    numbers: ['16', '4', '0', '00'], roulette: 'american', onAdd() {}, onCancel() {},
  }));
  assert.match(html, /Numbers read from your photo/);
  assert.match(html, /Most recent first\. Check them before adding\./);
  assert.match(html, /Add 4 numbers/);
  assert.match(html, />Cancel</);
  assert.match(html, /position:fixed/, 'drawn by the shared Modal');
  const at = ['16', '4', '0', '00'].map((n) => html.indexOf(`>${n}</button>`));
  assert.ok(at.every((i) => i > 0), 'each number is a button');
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'in board order');
  assert.doesNotMatch(html, /Correct number \d+ of/, 'no picker is open until a number is tapped');
});

test('a single number says Add 1 number', async () => {
  const { ctx } = await load();
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BoardPhotoReview, {
    numbers: ['7'], roulette: 'american', onAdd() {}, onCancel() {},
  }));
  assert.match(html, /Add 1 number</);
});

test('the status slot is reserved whether or not it has a line, and each line is one short line', async () => {
  const { ctx } = await load();
  const status = (result) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BoardPhotoStatus, { result }));
  const slotTag = (html) => html.slice(0, html.indexOf('>') + 1);
  const tags = [null, { kind: 'status', status: 'offline' }, { kind: 'status', status: 'canceled' }].map((r) => slotTag(status(r)));
  assert.match(tags[0], /min-height:16px/);
  assert.ok(tags.every((t) => t === tags[0]), 'the same reserved slot with a line and without');
  assert.equal(textOf(status(null)), '');
  assert.equal(textOf(status({ kind: 'status', status: 'canceled' })), '', 'canceled shows nothing');
  assert.equal(textOf(status({ kind: 'numbers', numbers: ['5'] })), '', 'a numbers return is not a status line');
  assert.equal(textOf(status({ kind: 'status', status: 'offline' })), 'PC offline, photo reading unavailable');
  for (const s of ['changed', 'offline', 'busy', 'timeout', 'unreadable', 'unavailable', 'limit', 'exif', 'toolarge', 'refused']) {
    const line = textOf(status({ kind: 'status', status: s }));
    assert.ok(line.length > 0 && line.length <= 40, `${s}: one short line (${line.length} characters)`);
  }
});

// -- Reuse, and nothing entered without Add --

test('the review corrects a number with the same picker the recent-numbers strip uses', async () => {
  const { ctx } = await load();
  const picker = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.NumberPicker, {
    title: 'Correct number 2 of 4', note: 'This number is read as 4.', blocked: false, label: 'number 2',
    currentValue: '4', roulette: 'american', onChoose() {}, onClose() {},
  }));
  assert.equal((picker.match(/aria-label="Set number 2 to /g) || []).length, 38, 'American: 0, 00 and 1-36');
  assert.doesNotMatch(picker, /disabled=""/, 'not blocked, so no number is disabled');
  const spin = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.SpinNumberPicker, {
    spinIndex: 4, spinCount: 30, currentValue: '17', roulette: 'american', blockedReason: null, onChoose() {}, onClose() {},
  }));
  assert.match(spin, /Correct spin 5 of 30/, 'the spin correction still renders through the same component');
  const photo = await readFile(new URL('components/BoardPhoto.jsx', SRC), 'utf8');
  const tools = await readFile(new URL('components/SpinTools.jsx', SRC), 'utf8');
  assert.match(photo, /<NumberPicker /, 'the review mounts the shared picker');
  assert.doesNotMatch(photo, /aria-label=\{`Set /, 'the review defines no number list of its own');
  assert.match(tools, /<NumberPicker title=\{`Correct spin/, 'the spin correction mounts the same component');
});

test('the photo reader contains no spin settlement or native dialog path', async () => {
  const photo = await readFile(new URL('components/BoardPhoto.jsx', SRC), 'utf8');
  assert.doesNotMatch(photo, /tapNumber|applySpin|updSess|updApp|ghostSpin|correctSpin|setAppState/);
  assert.doesNotMatch(photo, /\b(confirm|alert|prompt)\s*\(/);
});

test('the review is live-only, the status sits under the spin tools, and a spin entered by hand ends a status', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.match(app, /appMode==="live" && boardReturn && boardReturn\.kind==="numbers" && <BoardPhotoReview /);
  assert.match(app, /onReadPhoto=\{\(\)=>openBoardPhoto\(window\.location,sess\.roulette,setBoardReturn\)\}\/>\s*<BoardPhotoStatus result=\{boardReturn\}\/>/);
  assert.match(app, /if\(boardReturn&&boardReturn\.kind==="status"\) setBoardReturn\(null\);/);
});

test('BoardPhoto is built after SpinTools (for NumberPicker) and before App', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('components/BoardPhoto.jsx') > at('components/SpinTools.jsx'));
  assert.ok(at('components/BoardPhoto.jsx') > at('components/ui.jsx'));
  assert.ok(at('App.jsx') > at('components/BoardPhoto.jsx'));
});

// -- The Casino UI contract and framed round trip --

test('UI requests have their own roster and the pinned recording verb list is unchanged', async () => {
  const { ctx } = await load();
  assert.deepEqual(plain(ctx.exports.CASINO_UI_OPERATIONS), ['openReadBoard', 'readBoardResult']);
  assert.deepEqual(plain(ctx.exports.CASINO_BRIDGE_OPERATIONS), [
    'settings', 'history', 'start', 'pause', 'resume', 'stop', 'spin', 'layout', 'setLayout',
    'deleteSession', 'readState', 'writeState',
  ]);
});

test('a framed tap posts openReadBoard synchronously to the pinned shell and never assigns the frame', async () => {
  const { ctx, posted, hello, reply } = await loadSlice({ framed: true });
  ctx.installCasinoBridge();
  hello();
  const statuses = [];
  const pending = ctx.openBoardPhoto({ assign() { assert.fail('frame navigated'); } }, 'american', (r) => statuses.push(r));
  assert.equal(posted.length, 1, 'posted before the click handler yields');
  assert.equal(posted[0].origin, 'https://casino.nexus-foundry.ai');
  assert.equal(posted[0].data.kind, 'nexus-casino:recording:request');
  assert.equal(posted[0].data.op, 'openReadBoard');
  assert.deepEqual(plain(posted[0].data.payload), { wheel: 'american' });
  reply(posted[0], null);
  await pending;
  assert.equal(statuses.length, 0);
});

test('a frame without a live bridge reports unavailable without assigning or waiting for hello', async () => {
  const { ctx, posted } = await loadSlice({ framed: true });
  const statuses = [];
  await ctx.openBoardPhoto({ assign() { assert.fail('frame navigated'); } }, 'european', (r) => statuses.push(plain(r)));
  assert.deepEqual(statuses, [{ kind: 'status', status: 'unavailable' }]);
  assert.equal(posted.length, 0);
});

test('a refused framed open shows the existing unavailable status', async () => {
  const { ctx, posted, hello, reply } = await loadSlice({ framed: true });
  ctx.installCasinoBridge(); hello();
  const statuses = [];
  const pending = ctx.openBoardPhoto({ assign() { assert.fail('frame navigated'); } }, 'european', (r) => statuses.push(plain(r)));
  reply(posted[0], null, { ok: false, status: 403 });
  await pending;
  assert.deepEqual(statuses, [{ kind: 'status', status: 'unavailable' }]);
});

// Exercise the effect lifecycle, including hello after mount, repeated hellos and an effect restart.
async function mountReturn(wheel = 'american', framed = true, syncStatus) {
  const bridge = await loadSlice({ framed });
  const { ctx } = bridge;
  const refs = [];
  let cursor = 0;
  let effect;
  const changes = [];
  ctx.React = { ...React,
    useRef(value) { const i = cursor++; return refs[i] || (refs[i] = { current: value }); },
    useEffect(run) { effect = run; },
  };
  const mount = () => {
    cursor = 0;
    ctx.useCasinoBoardReturn(wheel, (v) => changes.push(['mode', v]), (v) => changes.push(['review', plain(v)]), syncStatus);
    return effect();
  };
  return { ...bridge, changes, mount, setWheel(value) { wheel = value; }, setSyncStatus(value) { syncStatus = value; } };
}

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test('the framed return waits for a pinned hello, pulls once, and opens live review without adding', async () => {
  const { ctx, posted, emit, hello, reply, changes, mount } = await mountReturn();
  const cleanup = mount();
  assert.equal(posted.length, 0);
  emit({ kind: 'nexus-casino:recording:hello', gameId: 'roulette' }, 'https://attacker.test');
  emit({ kind: 'nexus-casino:recording:hello', gameId: 'roulette' }, undefined, {});
  emit({ kind: 'nexus-casino:recording:hello', gameId: 'monopoly' });
  assert.equal(posted.length, 0, 'untrusted hellos cannot trigger the pull');
  hello(); hello();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].data.op, 'readBoardResult');
  assert.equal(posted[0].origin, 'https://casino.nexus-foundry.ai');
  assert.deepEqual(plain(posted[0].data.payload), {});
  emit({ kind: 'nexus-casino:recording:response', id: posted[0].data.id, ok: true, body: { fragment: 'ok:37' } }, 'https://attacker.test');
  await flushPromises();
  assert.deepEqual(changes, []);
  reply(posted[0], { fragment: 'ok:16,0,00' });
  await flushPromises();
  assert.deepEqual(changes, [['mode', 'live'], ['review', { kind: 'numbers', numbers: ['16', '0', '00'] }]]);
  hello();
  assert.equal(posted.length, 1);
  cleanup();
});

test('a pulled ok value is strictly revalidated whole for the active wheel and forty-entry limit', async () => {
  for (const [wheel, fragment] of [
    ['american', 'ok:16,37,4'], ['european', 'ok:16,00,4'],
    ['american', 'ok:' + Array(41).fill('5').join(',')], ['american', 'ok:05,4'],
  ]) {
    const { posted, hello, reply, changes, mount } = await mountReturn(wheel);
    const cleanup = mount(); hello(); reply(posted[0], { fragment });
    await flushPromises();
    assert.deepEqual(changes, [['mode', 'live'], ['review', { kind: 'status', status: 'unreadable' }]], wheel + ': ' + fragment);
    cleanup();
  }
});

test('none, null and unsuccessful pulls are no-ops; a status uses the existing status screen', async () => {
  for (const [body, extra, expected] of [
    [{ fragment: 'none' }, {}, []], [{ fragment: null }, {}, []],
    [null, {}, []], [{ fragment: 'ok:5' }, { ok: false }, []],
    [{ fragment: 'busy' }, {}, [['mode', 'live'], ['review', { kind: 'status', status: 'busy' }]]],
    [{ fragment: 'canceled' }, {}, []],
  ]) {
    const { posted, hello, reply, changes, mount } = await mountReturn();
    const cleanup = mount(); hello(); reply(posted[0], body, extra);
    await flushPromises(); assert.deepEqual(changes, expected); cleanup();
  }
});

test('an effect restart preserves the one pull and delivers its pending result once', async () => {
  const { posted, hello, reply, changes, mount } = await mountReturn();
  hello(); // no listener yet; the mount must still wait for a real hello
  const firstCleanup = mount(); hello(); firstCleanup();
  const cleanup = mount();
  assert.equal(posted.length, 1);
  reply(posted[0], { fragment: 'ok:5' });
  await flushPromises();
  assert.deepEqual(changes, [['mode', 'live'], ['review', { kind: 'numbers', numbers: ['5'] }]]);
  cleanup();
});

test('standalone never pulls a Casino result, and App only wires the return hook within its line budget', async () => {
  const { posted, changes, mount } = await mountReturn('american', false);
  const cleanup = mount();
  await flushPromises();
  assert.equal(posted.length, 0); assert.deepEqual(changes, []);
  if (cleanup) cleanup();
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.match(app, /useBoardPhotoReturn\(/);
  assert.ok(app.split('\n').length - 1 < 900);
});

test('a pulled result waits for account hydration and validates against the restored live wheel', async () => {
  const { posted, hello, reply, changes, mount, setWheel, setSyncStatus } = await mountReturn('american', true, 'checking');
  const cleanup = mount(); hello(); reply(posted[0], { fragment: 'ok:16,00' });
  await flushPromises();
  assert.deepEqual(changes, [], 'the initial default wheel is not the account wheel');
  cleanup(); setWheel('european'); setSyncStatus('synced');
  const finalCleanup = mount();
  await flushPromises();
  assert.equal(posted.length, 1, 'hydration never consumes the shell result twice');
  assert.deepEqual(changes, [['mode', 'live'], ['review', { kind: 'status', status: 'unreadable' }]]);
  finalCleanup();
});

// React 18's real concurrent root and scheduler, with a null host tree. Host tasks are held so a
// sync receipt can arrive after a queue commit but before its passive effect, exactly as in M2.
async function realReactRoot({strict = false, development = false} = {}) {
  const tasks = new Map();
  let nextTask = 0, clock = 0, commits = 0;
  const document = {nodeType:9, addEventListener() {}, removeEventListener() {}, activeElement:null};
  const container = {nodeType:1, tagName:'DIV', namespaceURI:'http://www.w3.org/1999/xhtml',
    ownerDocument:document, addEventListener() {}, removeEventListener() {}, textContent:''};
  const host = {console, document, HTMLIFrameElement:class {},
    performance:{now:() => clock},
    setTimeout(run) { const id = ++nextTask; tasks.set(id, run); return id; },
    clearTimeout(id) { tasks.delete(id); }};
  host.window = host; host.self = host;
  vm.createContext(host);
  const variant = development ? 'development.js' : 'production.min.js';
  for (const file of ['react/umd/react.' + variant, 'react-dom/umd/react-dom.' + variant]) {
    vm.runInContext(await readFile(new URL('../node_modules/' + file, import.meta.url), 'utf8'), host, {filename:file});
  }
  assert.match(host.React.version, /^18\./, 'the regression runs real React 18');
  const root = host.ReactDOM.createRoot(container);
  return {React:host.React, get pending() { return tasks.size > 0; }, get commits() { return commits; },
    render(run) {
      function Probe() {
        run();
        host.React.useLayoutEffect(() => { commits++; clock += 10; });
        return null;
      }
      const element = host.React.createElement(Probe);
      root.render(strict ? host.React.createElement(host.React.StrictMode, null, element) : element);
    },
    step() { const task = tasks.entries().next().value; if(task) { tasks.delete(task[0]); task[1](); } },
    unmount() { root.unmount(); tasks.clear(); },
  };
}

// Execute the actual App and all of its effects. The hook runner models batched render/effect turns;
// only browser timers, storage and the recording transport are replaced. Account sync is real.
async function mountApp({framed = true, hash = '', wheel = 'american', mutate, runtime} = {}) {
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const recordings = [];
  const recordingStates = [];
  const spinWrites = [];
  const saves = [];
  let cursor = 0, dirty = true, tree;
  const changed = (before, after) => !before || !after || after.some((value, i) => !Object.is(value, before[i]));
  const react = {...React,
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = {value: typeof initial === 'function' ? initial() : initial};
      const slot = hooks[i];
      if (!slot.set) slot.set = value => {
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) {
          if (i === 0 && JSON.stringify(next.appState.currentSession.spins) !== JSON.stringify(slot.value.appState.currentSession.spins)) spinWrites.push(plain(next.appState.currentSession.spins));
          slot.value = next;
          dirty = true;
        }
      };
      return [slot.value, slot.set];
    },
    useRef(initial) { const i = cursor++; return hooks[i] || (hooks[i] = {current: initial}); },
    useMemo(run, deps) {
      const i = cursor++;
      if (!hooks[i] || changed(hooks[i].deps, deps)) hooks[i] = {value: run(), deps};
      return hooks[i].value;
    },
    useCallback(run, deps) { return react.useMemo(() => run, deps); },
    useEffect(run, deps) {
      const i = cursor++;
      if (!hooks[i] || changed(hooks[i].deps, deps)) {
        const previous = hooks[i];
        hooks[i] = {deps, cleanup: previous && previous.cleanup};
        effects.push(() => { if (hooks[i].cleanup) hooks[i].cleanup(); hooks[i].cleanup = run(); });
      }
    },
  };
  const bridge = await loadSlice({framed, app: true, mutate, react:runtime ? runtime.React : react});
  const {ctx} = bridge;
  let committedState, appSetter;
  const boardActions = [];
  const usePhotoState = ctx.useBoardPhotoState;
  ctx.useBoardPhotoState = load => {
    const value = usePhotoState(load);
    [committedState, appSetter] = value;
    return [value[0], value[1], value[2], action => { boardActions.push(plain(action)); value[3](action); }];
  };
  const initial = plain(ctx.loadApp());
  initial.settings.onboarded = true;
  initial.settings.vibration = false;
  initial.currentSession = plain(ctx.newSession(wheel, 500));
  initial.currentSession.id = 'photo-session';
  ctx.loadApp = () => plain(initial);
  ctx.saveApp = state => { saves.push(plain(state)); return true; };
  ctx.useCasinoRecording = mode => ({record: spin => {
    recordings.push({mode, ...plain(spin)});
    recordingStates.push(plain(runtime ? committedState : hooks[0].value.appState));
  }});
  ctx.navigator = {};
  ctx.document = {addEventListener() {}, removeEventListener() {}};
  ctx.location = {hash, pathname: '/roulette/', search: ''};
  ctx.history = {state: null, replaceState() { ctx.location.hash = ''; }};
  ctx.URLSearchParams = URLSearchParams;
  ctx.CustomEvent = class { constructor(type) { this.type = type; } };
  ctx.dispatchEvent = () => {};
  ctx.fetch = async () => ({json: async () => ({})});
  ctx.setInterval = () => 1;
  ctx.clearInterval = () => {};
  let timerId = 0;
  ctx.setTimeout = (run, delay) => { const id = ++timerId; timers.set(id, {run, delay}); return id; };
  ctx.clearTimeout = id => timers.delete(id);
  function render() {
    cursor = 0; dirty = false;
    if(runtime) runtime.render(() => { tree = ctx.module.exports.default(); });
    else tree = ctx.module.exports.default();
  }
  function runEffects() { for (const effect of effects.splice(0)) effect(); }
  async function flush() {
    for (let i = 0; i < 100; i++) {
      if (dirty) render();
      if(runtime) runtime.step(); else runEffects();
      await flushPromises();
      if (!dirty && effects.length === 0 && (!runtime || !runtime.pending)) return;
    }
    assert.fail('App did not settle');
  }
  function find(type, node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const found = find(type, child); if (found) return found; } return null; }
    if (node.type === type || (typeof type === 'string' && typeof node.type === 'function' && node.type.name === type)) return node;
    return find(type, node.props && node.props.children);
  }
  function live() {
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'button' && String(node.props.children).includes('Live')) node.props.onClick();
      else walk(node.props && node.props.children);
    };
    walk(tree);
  }
  const state = () => runtime ? committedState : hooks[0].value.appState;
  const restore = session => appSetter(previous => ({...previous, currentSession:{...previous.currentSession, ...session}}));
  const review = () => find(ctx.BoardPhotoReview, tree);
  const statusText = () => {
    const tracker = find('TrackerPage', tree);
    assert.ok(tracker, 'live tracker is mounted');
    const status = find(ctx.BoardPhotoStatus, tracker.type(tracker.props));
    assert.ok(status, 'tracker mounts the photo status');
    return textOf(ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BoardPhotoStatus, status.props)));
  };
  async function hydrate() {
    await flush(); bridge.hello(); await flush();
    const requests = bridge.posted.filter(p => p.data.op === 'readState');
    assert.ok(requests.length, 'the actual sync hook reads the account');
    for (const request of requests) bridge.reply(request, {scope: 'a'.repeat(32), state: null});
    await flush();
    assert.ok(bridge.posted.some(p => p.data.op === 'writeState'), 'account sync is now syncing');
  }
  return {...bridge, flush, render, runEffects, state, restore, review, statusText, live, hydrate, recordings, recordingStates, spinWrites, saves, timers, boardActions,
    pressAdd(numbers) { const element = review(); assert.ok(element, 'review is visible'); element.props.onAdd(numbers || element.props.numbers); },
    unmount() { if(runtime) runtime.unmount(); else for (const slot of hooks) if (slot && slot.cleanup) slot.cleanup(); },
  };
}

async function deliverApp(fragment, options) {
  const app = await mountApp(options);
  await app.hydrate();
  const request = app.posted.find(p => p.data.op === 'readBoardResult');
  assert.ok(request);
  app.reply(request, {fragment});
  await app.flush();
  return app;
}

async function explicitAddScenario(mutate) {
  const app = await deliverApp('ok:16,0,00', {mutate});
  try {
    assert.deepEqual(plain(app.state().currentSession.spins), [], 'delivery writes no spins');
    assert.equal(app.spinWrites.length, 0, 'delivery and effects must write zero spins');
    assert.equal(app.recordings.length, 0, 'delivery must record zero spins');
    assert.ok(app.saves.every(state => state.currentSession.spins.length === 0), 'no saved snapshot contains an automatic spin');
    app.pressAdd();
    await app.flush();
    assert.deepEqual(plain(app.state().currentSession.spins), ['00', '0', '16']);
    assert.equal(app.spinWrites.length, 1, 'the whole list is one state mutation');
    assert.deepEqual(app.recordings.map(spin => spin.segment), ['00', '0', '16']);
    assert.deepEqual(app.saves.at(-1).currentSession.spins, ['00', '0', '16']);
  } finally { app.unmount(); }
}

test('App delivery and flushed effects write zero spins; Add writes and records each spin oldest first', async () => {
  await explicitAddScenario();
});

const autoRecordMutant = source => {
  const anchor = '  // Save UI state when page is hidden';
  assert.ok(source.includes(anchor));
  return source.replace(anchor, `  React.useEffect(() => {
    if(boardReturn && boardReturn.kind === "numbers") setBoardAdd(boardAddOrder(boardReturn.numbers));
  }, [boardReturn]);
` + anchor);
};

test('the App no-auto-recording test kills the review auto-enqueue effect mutant', async () => {
  await assert.rejects(() => explicitAddScenario(autoRecordMutant), /delivery writes no spins/);
});

async function syncRestoreScenario(mutate) {
  const app = await deliverApp('ok:00', {mutate});
  try {
    const staleAdd = app.review().props.onAdd;
    const restored = {...plain(app.state()), currentSession: {...plain(app.state().currentSession), roulette: 'european'}};
    const pendingWrite = app.posted.find(p => p.data.op === 'writeState');
    const snapshot = app.ctx.rouletteSnapshot(restored, {modifiedAt: Date.now() + 1000, resetAt: 0});
    // Conflict, retry and successful receipt exercise casino-sync's actual applySnapshot path.
    app.reply(pendingWrite, {state: {revision: 1, data: snapshot}}, {ok: false, status: 409});
    await app.flush();
    const retry = app.posted.filter(p => p.data.op === 'writeState').at(-1);
    assert.notEqual(retry, pendingWrite);
    app.reply(retry, {state: {revision: 2, data: snapshot}});
    await app.flush();
    assert.equal(app.state().currentSession.roulette, 'european');
    staleAdd(['00']);
    await app.flush();
    assert.deepEqual(plain(app.state().currentSession.spins), [], 'sync restored European session must get no 00');
    assert.equal(app.recordings.length, 0);
    assert.equal(app.review(), null, 'the review is dropped');
    assert.equal(app.statusText(), 'Session or wheel changed, read again', 'changed-wheel Add explains why nothing was written');
  } finally { app.unmount(); }
}

test('App: ok:00 while syncing American, then conflict restore to European, then Add adds nothing', async () => {
  await syncRestoreScenario();
});

// Remove every session comparison and the invalidation effect, keeping the rest of the real flow.
// The first mutant recreates M2 including its absent Add/queue revalidation; the others isolate each binding field.
const unboundMutant = source => source
  .replace('bound.sessionId === session.id && bound.wheel === session.roulette', 'true')
  .replace('scope.current.id !== session.id || scope.current.wheel !== session.roulette', 'false')
  .replace('!legalBoardList(action.numbers, session.roulette)', 'false');

test('the sync-restore reproduction kills the stale unvalidated Add mutant', async () => {
  await assert.rejects(() => syncRestoreScenario(unboundMutant), /sync restored European session must get no 00/);
});

async function changedScopeScenario(field, mutate) {
  const app = await deliverApp('ok:17', {mutate});
  try {
    assert.ok(app.review());
    app.restore(field === 'wheel' ? {roulette: 'european'} : {id: 'other-session'});
    await app.flush();
    assert.equal(app.review(), null, field + ' change drops a review even for a number legal on both wheels');
    assert.equal(app.spinWrites.length, 0);
    assert.equal(app.recordings.length, 0);
    // Returning to the previous identity must not resurrect a discarded review.
    app.restore(field === 'wheel' ? {roulette: 'american'} : {id: 'photo-session'});
    await app.flush();
    assert.equal(app.review(), null);
  } finally { app.unmount(); }
}

for (const field of ['wheel', 'session']) {
  test('App: a ' + field + ' change drops the review permanently', async () => { await changedScopeScenario(field); });
  test('the ' + field + ' invalidation test kills its binding mutant', async () => {
    const mutant = source => field === 'wheel'
      ? source.replace(' && bound.wheel === session.roulette', '').replace(' || scope.current.wheel !== session.roulette', '')
      : source.replace('bound.sessionId === session.id && ', '').replace('scope.current.id !== session.id || ', '');
    await assert.rejects(() => changedScopeScenario(field, mutant), new RegExp(field + ' change drops a review'));
  });
}

test('Add revalidates the whole edited list and refuses it without partial writes', async () => {
  for (const numbers of [['17', '37', '4'], ['17', '00', '4'], Array(41).fill('5'), [], Array(2)]) {
    const app = await mountApp({framed: false, wheel: 'european', hash: '#readboard=ok:17,4'});
    try {
      await app.flush(); app.live(); await app.flush();
      app.pressAdd(numbers); await app.flush();
      assert.deepEqual(plain(app.state().currentSession.spins), []);
      assert.equal(app.recordings.length, 0);
      assert.equal(app.statusText(), 'Session or wheel changed, read again');
    } finally { app.unmount(); }
  }
});

test('standalone hash review is bound to both the session and wheel', async () => {
  for (const change of [{roulette: 'european'}, {id: 'other-session'}]) {
    const app = await mountApp({framed: false, hash: '#readboard=ok:00'});
    try {
      await app.flush(); app.live(); await app.flush();
      assert.equal(app.ctx.location.hash, '');
      const staleAdd = app.review().props.onAdd;
      app.restore(change); await app.flush(); staleAdd(['00']); await app.flush();
      assert.equal(app.review(), null);
      assert.equal(app.spinWrites.length, 0);
      assert.equal(app.recordings.length, 0);
    } finally { app.unmount(); }
  }
});

test('pending framed replies are discarded when their session or wheel changes', async () => {
  for (const change of [{roulette: 'european'}, {id: 'other-session'}]) {
    const app = await mountApp();
    try {
      await app.hydrate();
      const request = app.posted.find(p => p.data.op === 'readBoardResult');
      app.restore(change); await app.flush();
      app.reply(request, {fragment: 'ok:17'}); await app.flush();
      assert.equal(app.review(), null);
      assert.equal(app.recordings.length, 0);
    } finally { app.unmount(); }
  }
});

test('session or wheel changes before the queued Add refuse the whole list', async () => {
  for (const change of [{roulette: 'european'}, {id: 'other-session'}]) {
    const app = await deliverApp('ok:17,4,0');
    try {
      app.pressAdd(); app.render(); // queue committed; its passive effect has not run
      app.restore(change); await app.flush();
      assert.deepEqual(plain(app.state().currentSession.spins), []);
      assert.equal(app.recordings.length, 0);
      assert.equal(app.statusText(), 'Session or wheel changed, read again');
    } finally { app.unmount(); }
  }
});

test('the changed-wheel Add test kills a silent refusal mutant', async () => {
  const mutant = source => source.replace('changed: "Session or wheel changed, read again"', 'changed: ""');
  await assert.rejects(() => syncRestoreScenario(mutant), /changed-wheel Add explains why nothing was written/);
});

// The successful sync receipt calls casino-sync's real applySnapshot after the Add queue render
// commits, while React's scheduler is still holding that render's passive effects.
async function receiptBeforePassiveScenario(mutate, change = {id:'restored-session', roulette:'european'}, fragment = 'ok:00') {
  const runtime = await realReactRoot();
  const app = await deliverApp(fragment, {runtime, mutate});
  try {
    const restored = {...plain(app.state()), currentSession:{...plain(app.state().currentSession), ...change}};
    const snapshot = app.ctx.rouletteSnapshot(restored, {modifiedAt:Date.now()+1000, resetAt:0});
    const pending = app.posted.find(p => p.data.op === 'writeState');
    app.reply(pending, {state:{revision:1, data:snapshot}}, {ok:false, status:409});
    await app.flush();
    const retry = app.posted.filter(p => p.data.op === 'writeState').at(-1);
    assert.notEqual(retry, pending);
    assert.ok(app.review(), 'American review remains visible while the receipt is pending');
    app.pressAdd();
    const commits = runtime.commits;
    runtime.step();
    assert.equal(runtime.commits, commits+1, 'the real React queue render committed');
    assert.equal(app.review(), null, 'Add closed the review in that commit');
    assert.equal(app.boardActions.length, 0, 'the queue passive effect has not run');
    assert.equal(app.recordings.length, 0);
    app.reply(retry, {state:{revision:2, data:snapshot}});
    await flushPromises();
    assert.deepEqual(app.saves.at(-1).currentSession, restored.currentSession, 'the actual sync restore arrived before the passive effect');
    assert.equal(app.boardActions.length, 0, 'restore arrival did not flush the passive effect');
    await app.flush();
    assert.equal(app.boardActions.length, 1, 'the stale queue attempted its atomic action');
    assert.deepEqual(plain(app.state().currentSession.spins), [], 'receipt-before-passive: restored session must have zero spins');
    assert.equal(app.recordings.length, 0, 'receipt-before-passive: refused action must have zero recording calls');
    assert.equal(app.statusText(), 'Session or wheel changed, read again');
  } finally { app.unmount(); }
}

test('real React 18: Add queue commits, European sync restore arrives before passive effects, zero spins and recordings', async () => {
  await receiptBeforePassiveScenario();
});

const liveRefMutant = source => {
  const guard = '!boardMatchesSession(action, session) || !legalBoardList(action.numbers, session.roulette)';
  assert.equal(source.split(guard).length, 2, 'atomic guard mutation matches exactly once');
  return source.replace(guard, '!action.validated')
    .replace('  const bind = result =>', '  const live = React.useRef(session); live.current = session;\n  const bind = result =>')
    .replace('commitBoardAdd(queue);', 'commitBoardAdd({...queue, validated:boardMatchesSession(queue, live.current) && legalBoardList(queue.numbers, live.current.roulette)});');
};

test('the real React receipt-before-passive regression kills the live.current validation mutant', async () => {
  await assert.rejects(() => receiptBeforePassiveScenario(liveRefMutant), /receipt-before-passive: restored session must have zero spins/);
});

test('real React 18 atomic Add checks session id and wheel independently even for legal numbers', async () => {
  await receiptBeforePassiveScenario(undefined, {id:'another-session'}, 'ok:17');
  await receiptBeforePassiveScenario(undefined, {roulette:'european'}, 'ok:17');
});

test('real React 18 records accepted batches after commit, once, including development Strict Mode', async () => {
  for (const development of [false, true]) {
    const runtime = await realReactRoot({strict:true, development});
    const app = await deliverApp('ok:16,0,00', {runtime});
    try {
      assert.equal(app.recordings.length, 0);
      app.pressAdd();
      runtime.step();
      assert.equal(app.recordings.length, 0, 'the queue commit cannot record');
      await app.flush();
      assert.deepEqual(plain(app.state().currentSession.spins), ['00','0','16']);
      assert.deepEqual(app.recordings.map(spin => spin.segment), ['00','0','16']);
      assert.ok(app.recordingStates.every(state => JSON.stringify(state.currentSession.spins) === '["00","0","16"]'), 'each recording observes the accepted state already committed');
      assert.ok(app.saves.every(state => !('decision' in state) && !('appState' in state)), 'decision receipts never enter persisted app state');
      app.restore({name:'After receipt'}); await app.flush();
      assert.equal(app.recordings.length, 3, 'a later render cannot record the accepted receipt again');
    } finally { app.unmount(); }
  }
});
