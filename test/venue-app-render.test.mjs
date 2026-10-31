import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// The whole bundle, in the order build.js concatenates it, is loaded and server-rendered once. The venue wiring
// lives in App.jsx (the sheet hook, the header line, the stats props), and this is the only test that runs that file.
// It renders the default Game page; the Live page is not reached in a server render, so its header is covered by
// the static checks in venue-picker.test.mjs and by the visual checks, which are UNVERIFIED here.

const ROOT = new URL('../', import.meta.url);

test('the full bundle loads and App renders with the venue sheet hook in place', async () => {
  const buildSource = await readFile(new URL('nexus-src/build.js', ROOT), 'utf8');
  const list = buildSource.match(/const FILES = \[([\s\S]*?)\n\];/);
  assert.ok(list, 'build.js declares its FILES list');
  const files = list[1].split('\n').map((l) => l.match(/^\s*'([^']+)',\s*$/)).filter(Boolean).map((m) => m[1]);
  assert.ok(files.includes('components/VenuePicker.jsx'), 'the venue picker is in the bundle');
  assert.ok(files.indexOf('components/VenuePicker.jsx') < files.indexOf('App.jsx'), 'the picker is defined before App');
  assert.ok(files.indexOf('components/onboarding-apply.jsx') < files.indexOf('App.jsx'), 'the sheet hook is defined before App');

  const parts = await Promise.all(files.map((f) => readFile(new URL(`nexus-src/src/${f}`, ROOT), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${parts[i]}`).join('\n');
  const { code } = transformSync(combined, {
    babelrc: false,
    configFile: false,
    filename: 'app.jsx',
    presets: [
      [presetReact, { runtime: 'classic' }],
      [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
    ],
  });

  const store = {
    'nexus-roulette-v1': JSON.stringify({
      savedSessions: [],
      currentSession: {
        id: 'cur', name: 'Session', created: 1, modified: 1, roulette: 'american', bankroll: 500, bankrollCurrent: 500,
        totalBuyIn: 0, buyIns: [], spins: [], droughts: {}, tracks: [], totalCashOut: 0, cashOuts: [],
        sessionStartedAt: null, sessionEndedAt: null,
      },
      gameSession: null,
      settings: { onboarded: true, currency: 'USD', defaultBuyIn: 100 },
    }),
  };
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
      if (name === 'react-dom') return ReactDOMServer;
      throw new Error(`unexpected module in the bundle: ${name}`);
    },
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options && options.detail; } },
    navigator: {},
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    document: {
      addEventListener() {}, removeEventListener() {}, hidden: false, getElementById: () => null,
      createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} },
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  sandbox.window.location = { search: '', pathname: '/' };
  sandbox.window.innerWidth = 390;
  sandbox.window.innerHeight = 844;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.window.dispatchEvent = () => true;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-render.js' });
  const App = sandbox.module.exports.default || sandbox.module.exports;
  assert.equal(typeof App, 'function', 'App is the default export of App.jsx');
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(App));
  assert.ok(html.length > 1000, 'the page renders');
  assert.doesNotMatch(html, /Error:/, 'no error text in the render');
});
