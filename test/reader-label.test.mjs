import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// -- The reader label: an optional ;by= field after the numbers of a photo return --

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

// The same slice the board-photo tests load, in the same order and with the same transforms as build.js.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'spin-apply.js',
  'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs', 'casino-recording.mjs', 'components/ui.jsx', 'components/SpinTools.jsx', 'components/BoardPhoto.jsx',
];

async function loadSlice() {
  const sources = await Promise.all(SLICE.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = SLICE.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n');
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
    setTimeout, clearTimeout,
    addEventListener() {},
    removeEventListener() {},
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
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  return sandbox;
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

const fakeHistory = () => ({
  state: null,
  calls: [],
  replaceState(state, title, url) { this.calls.push(url); },
});

// The reserved reader slot as the review renders it: the element carrying data-slot="reader".
const SLOT = /<div data-slot="reader"[^>]*>[^<]*<\/div>/;

test('a return without the reader field parses exactly as it did before, with no reader key', async () => {
  const ctx = await load();
  const cases = [
    ['#readboard=ok:16,4,0,00', 'american', { kind: 'numbers', numbers: ['16', '4', '0', '00'] }],
    ['#readboard=ok:36,1,0', 'european', { kind: 'numbers', numbers: ['36', '1', '0'] }],
    ['#readboard=ok:5', 'american', { kind: 'numbers', numbers: ['5'] }],
    ['#readboard=busy', 'american', { kind: 'status', status: 'busy' }],
  ];
  for (const [hash, wheel, expected] of cases) {
    const result = ctx.parseBoardReturn(hash, wheel);
    assert.deepEqual(plain(result), expected, hash);
    assert.equal(hasOwn(result, 'reader'), false, `${hash}: no reader key at all`);
  }
});

test('the reader field is read after the numbers, as cloud or pc, on either wheel', async () => {
  const ctx = await load();
  assert.deepEqual(plain(ctx.parseBoardReturn('#readboard=ok:8,31,3;by=cloud', 'european')),
    { kind: 'numbers', numbers: ['8', '31', '3'], reader: 'cloud' });
  assert.deepEqual(plain(ctx.parseBoardReturn('#readboard=ok:8,31,3;by=pc', 'european')),
    { kind: 'numbers', numbers: ['8', '31', '3'], reader: 'pc' });
  assert.deepEqual(plain(ctx.parseBoardReturn('#readboard=ok:16,4,0,00;by=cloud', 'american')),
    { kind: 'numbers', numbers: ['16', '4', '0', '00'], reader: 'cloud' });
  assert.deepEqual(plain(ctx.parseBoardReturn('#readboard=ok:00;by=pc', 'american')),
    { kind: 'numbers', numbers: ['00'], reader: 'pc' }, '00 is legal on the American wheel with the field');
});

test('numbers with repeats parse identically with and without the reader field', async () => {
  const ctx = await load();
  for (const list of ['16,16,4,4', '0,0,00,00', '7,7,7,7,7']) {
    const bare = plain(ctx.parseBoardReturn(`#readboard=ok:${list}`, 'american'));
    const pc = plain(ctx.parseBoardReturn(`#readboard=ok:${list};by=pc`, 'american'));
    assert.deepEqual(bare, { kind: 'numbers', numbers: list.split(',') }, list);
    assert.deepEqual(pc.numbers, bare.numbers, `${list}: the same numbers in the same order`);
    assert.equal(pc.reader, 'pc', `${list}: the field is read`);
    assert.equal(hasOwn(ctx.parseBoardReturn(`#readboard=ok:${list}`, 'american'), 'reader'), false);
  }
});

test('an unknown or empty reader value is ignored, never an error, and leaves no reader key', async () => {
  const ctx = await load();
  const unknown = ['gizmo', '', 'CLOUD', 'Pc', 'pc ', ' pc', 'cloud/', 'cloud;by=pc', 'constructor', '__proto__', 'toString'];
  for (const by of unknown) {
    const result = ctx.parseBoardReturn(`#readboard=ok:8,31,3;by=${by}`, 'european');
    assert.deepEqual(plain(result), { kind: 'numbers', numbers: ['8', '31', '3'] }, `by=${by}`);
    assert.equal(hasOwn(result, 'reader'), false, `by=${by}: no reader key`);
  }
});

test('the reader field never changes whether the numbers are legal', async () => {
  const ctx = await load();
  const illegal = [
    '#readboard=ok:37;by=cloud', '#readboard=ok:00;by=pc', '#readboard=ok;by=cloud', '#readboard=ok:;by=pc',
    '#readboard=ok:16,,4;by=pc', '#readboard=ok:16,4,99;by=cloud', '#readboard=ok:16 ,4;by=pc',
  ];
  for (const hash of illegal) {
    const result = ctx.parseBoardReturn(hash, 'european');
    assert.deepEqual(plain(result), { kind: 'status', status: 'unreadable' }, hash);
    assert.equal(hasOwn(result, 'reader'), false, `${hash}: an unreadable result carries no reader`);
  }
});

test('a status return takes no reader field', async () => {
  const ctx = await load();
  for (const hash of ['#readboard=busy;by=pc', '#readboard=canceled;by=cloud', '#readboard=offline;by=gizmo']) {
    assert.equal(ctx.parseBoardReturn(hash, 'american'), null, hash);
  }
});

test('the return is read once from the hash with its reader, and the hash is cleared', async () => {
  const ctx = await load();
  const hist = fakeHistory();
  const loc = { hash: '#readboard=ok:5,17,0;by=cloud', pathname: '/roulette/', search: '?v=3' };
  assert.deepEqual(plain(ctx.takeBoardReturn(loc, hist, 'american')),
    { kind: 'numbers', numbers: ['5', '17', '0'], reader: 'cloud' });
  assert.deepEqual(hist.calls, ['/roulette/?v=3'], 'the URL is rewritten without the hash');
  loc.hash = '';
  assert.equal(ctx.takeBoardReturn(loc, hist, 'american'), null, 'a reload finds nothing to read again');
});

test('the review line reads the parsed reader and is the same reserved slot with and without it', async () => {
  const ctx = await load();
  const render = (extra) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BoardPhotoReview, {
    numbers: ['16', '4', '0'], roulette: 'american', onAdd() {}, onCancel() {}, ...extra,
  }));
  const fromPhoto = ctx.takeBoardReturn({ hash: '#readboard=ok:16,4,0;by=pc', pathname: '/', search: '' }, fakeHistory(), 'american');
  assert.match(textOf(render({ numbers: fromPhoto.numbers, reader: fromPhoto.reader })), /Read by your PC/, 'the parsed reader reaches the review');

  const cases = [
    ['cloud', { reader: 'cloud' }, 'Read by the cloud model', true],
    ['pc', { reader: 'pc' }, 'Read by your PC', true],
    ['absent', {}, '', false],
    ['unknown', { reader: 'gizmo' }, '', false],
    ['prototype key', { reader: 'constructor' }, '', false],
    ['raw markup is never rendered', { reader: '<img src=x onerror=alert(1)>' }, '', false],
  ];
  const htmls = cases.map(([, extra]) => render(extra));
  const slots = htmls.map((html) => html.match(SLOT)?.[0]);
  slots.forEach((slot, i) => assert.ok(slot, `${cases[i][0]}: the slot is rendered`));

  cases.forEach(([name, , text, shown], i) => {
    const slot = slots[i];
    assert.equal(textOf(slot), text, `${name}: the line text`);
    if (shown) {
      assert.match(slot, /visibility:visible/, `${name}: visible`);
      assert.doesNotMatch(slot, /aria-hidden/, `${name}: read by assistive tech`);
    } else {
      assert.match(slot, /visibility:hidden/, `${name}: hidden by visibility`);
      assert.match(slot, /aria-hidden="true"/, `${name}: hidden from assistive tech`);
    }
    assert.doesNotMatch(slot, /display:none/, `${name}: never display`);
    assert.match(slot, /min-height:16px/, `${name}: the reserved height`);
  });

  // The slot is the same element in every state: only the visibility, the aria flag and the text differ.
  const shape = (slot) => slot.replace(/visibility:[a-z]+;/, '').replace(/ aria-hidden="true"/, '').replace(/>[^<]*</, '><');
  assert.ok(slots.every((slot) => shape(slot) === shape(slots[0])), 'the same reserved slot in every state');

  // Nothing outside the slot moves: the rest of the review is byte-identical across the states.
  const outside = (html) => html.replace(SLOT, '');
  assert.ok(htmls.every((html) => outside(html) === outside(htmls[0])), 'the rest of the review does not change');
});

test('each reader line is one short line', async () => {
  const ctx = await load();
  for (const reader of ['cloud', 'pc']) {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BoardPhotoReview, {
      numbers: ['7'], roulette: 'american', reader, onAdd() {}, onCancel() {},
    }));
    const line = textOf(html.match(SLOT)[0]);
    assert.ok(line.length > 0 && line.length <= 40, `${reader}: ${line.length} characters`);
  }
});

test('the parser comment states the return shape the Nexus Foundry reader must match', async () => {
  const photo = await readFile(new URL('components/BoardPhoto.jsx', SRC), 'utf8');
  const at = photo.indexOf('// Contract with the Nexus Foundry reader');
  assert.ok(at > 0, 'the contract note is in the file');
  assert.ok(at < photo.indexOf('function parseBoardReturn'), 'the note sits above the parser');
  const note = photo.slice(at, photo.indexOf('function parseBoardReturn'));
  assert.match(note, /#readboard=ok:<numbers>;by=cloud/);
  assert.match(note, /#readboard=ok:<numbers>;by=pc/);
  assert.match(note, /absent or unknown/i);
  assert.match(note, /status[^\n]*no ;by=/, 'a status takes no reader field');
});

test('the live review receives the reader from App', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.match(app, /<BoardPhotoReview numbers=\{boardReturn\.numbers\}[^\n]*\breader=\{boardReturn\.reader\}/);
});
