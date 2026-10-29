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
  'roulette-bets.mjs', 'components/ui.jsx', 'components/SpinTools.jsx', 'components/BoardPhoto.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global scope.
// Nothing is copied from source; the functions under test are the ones the bundle runs.
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
  const store = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
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
  assert.deepEqual(await parse('#readboard=cancelled', 'american'), { kind: 'status', status: 'cancelled' });
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

test('an unknown return is still cleared from the URL and shows nothing; cancelled shows nothing', async () => {
  const { ctx } = await load();
  const hist = fakeHistory();
  const loc = { hash: '#readboard=wat', pathname: '/roulette/', search: '' };
  assert.equal(ctx.takeBoardReturn(loc, hist, 'american'), null);
  assert.deepEqual(hist.calls, ['/roulette/']);
  loc.hash = '#readboard=cancelled';
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
  const tags = [null, { kind: 'status', status: 'offline' }, { kind: 'status', status: 'cancelled' }].map((r) => slotTag(status(r)));
  assert.match(tags[0], /min-height:16px/);
  assert.ok(tags.every((t) => t === tags[0]), 'the same reserved slot with a line and without');
  assert.equal(textOf(status(null)), '');
  assert.equal(textOf(status({ kind: 'status', status: 'cancelled' })), '', 'cancelled shows nothing');
  assert.equal(textOf(status({ kind: 'numbers', numbers: ['5'] })), '', 'a numbers return is not a status line');
  assert.equal(textOf(status({ kind: 'status', status: 'offline' })), 'PC offline, photo reading unavailable');
  for (const s of ['offline', 'busy', 'timeout', 'unreadable', 'unavailable', 'limit', 'exif', 'toolarge', 'refused']) {
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

test('nothing settles a spin on read: the reader only parses, and App enters numbers only through its Add queue', async () => {
  const photo = await readFile(new URL('components/BoardPhoto.jsx', SRC), 'utf8');
  assert.doesNotMatch(photo, /tapNumber|applySpin|updSess|updApp|ghostSpin|correctSpin|setAppState/);
  assert.doesNotMatch(photo, /\b(confirm|alert|prompt)\s*\(/);
  assert.doesNotMatch(photo, /position:\s*"fixed"/);
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.equal(app.split('takeBoardReturn(window.location, window.history,').length - 1, 1, 'the return is taken once, in the state initializer');
  assert.equal(app.split('tapNumber(val, true);').length - 1, 1, 'the only board entry path is the queue effect');
  assert.match(app, /setBoardAdd\(boardAddOrder\(listBoardOrder\)\);/);
  assert.match(app, /if\(appMode!=="live"\) \{ setBoardAdd\(\[\]\); return; \}/, 'the queue entry is live only');
});

test('the review is live-only, the status sits under the spin tools, and a spin entered by hand ends a status', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.match(app, /appMode==="live" && boardReturn && boardReturn\.kind==="numbers" && <BoardPhotoReview /);
  assert.match(app, /onReadPhoto=\{\(\)=>openBoardPhoto\(window\.location,sess\.roulette\)\}\/>\s*<BoardPhotoStatus result=\{boardReturn\}\/>/);
  assert.match(app, /if\(boardReturn&&boardReturn\.kind==="status"\) setBoardReturn\(null\);/);
});

test('BoardPhoto is built after SpinTools (for NumberPicker) and before App', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('components/BoardPhoto.jsx') > at('components/SpinTools.jsx'));
  assert.ok(at('components/BoardPhoto.jsx') > at('components/ui.jsx'));
  assert.ok(at('App.jsx') > at('components/BoardPhoto.jsx'));
});
