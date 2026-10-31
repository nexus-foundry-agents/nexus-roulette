import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// MONEYINPUT-SILENT-STRIP: the shared money parser (money-parse.js) and MoneyInput (ui.jsx). The code under test is what the
// bundle runs: the source files are concatenated and transformed the way build.js does. There is no DOM. MoneyInput runs under
// a small hook runner: the test supplies useState and useEffect, presses the field's own handlers, and reads back the element
// tree the component returns. Nothing is copied from source.
const SRC = new URL('../nexus-src/src/', import.meta.url);
const SLICE = ['constants.js', 'money-parse.js', 'components/ui.jsx'];

// The runner whose component is rendering now. constants.js imports its hooks from 'react', so the bundle reads them
// through require('react'), and the sandbox hands it this object.
let active = null;
const hookReact = {
  ...React,
  useState: (init) => active.useState(init),
  useEffect: (fn, deps) => active.useEffect(fn, deps),
  useMemo: (fn) => fn(),
};

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
    React: hookReact,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return hookReact;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'money-slice.js' });
  return { ctx: sandbox };
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

// Realm-safe copy: objects built inside the sandbox have another Object prototype, so compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Every React element under a node, depth first.
function elements(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out; }
  if (node.props) { out.push(node); elements(node.props.children, out); }
  return out;
}

// Mounts MoneyInput with the given props. act() runs one user action, then re-renders the way React would: state changes
// apply, effects whose inputs changed run, and it repeats until nothing is dirty. The parent is emulated: onChange records the
// call and passes the applied value back as the new value prop.
async function mountField(extra = {}) {
  const { ctx } = await load();
  const calls = [];
  const props = { value: 5, currCode: 'USD', label: 'Amount', ...extra };
  props.onChange = (v) => { calls.push(v); props.value = v; };
  const state = [];
  const seen = [];
  let cursor = 0;
  let dirty = false;
  let queue = [];
  const runner = {
    useState(init) {
      const i = cursor++;
      if (i >= state.length) state[i] = typeof init === 'function' ? init() : init;
      const set = (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; dirty = true; };
      return [state[i], set];
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = seen[i];
      const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev[k]));
      seen[i] = deps;
      if (changed) queue.push(fn);
    },
  };
  const field = {
    calls,
    props,
    tree: null,
    render() {
      do {
        dirty = false;
        cursor = 0;
        queue = [];
        active = runner;
        try { field.tree = ctx.MoneyInput(props); } finally { active = null; }
        const run = queue;
        for (const fn of run) fn();
      } while (dirty);
      return field.tree;
    },
    act(action) { action(); return field.render(); },
  };
  field.render();
  return field;
}

const slotOf = (f) => elements(f.tree).find((el) => el.props && typeof el.props['aria-hidden'] === 'boolean'
  && el.props.style && el.props.style.minHeight === 14);
const inputOf = (f) => elements(f.tree).find((el) => el.type === 'input');
const shown = (f) => inputOf(f).props.value;
const reasonShown = (f) => { const s = slotOf(f); return s.props.style.visibility === 'visible' ? s.props.children : null; };
const typeText = (f, text) => f.act(() => inputOf(f).props.onChange({ target: { value: text } }));
const blur = (f) => f.act(() => inputOf(f).props.onBlur());
const pressEnter = (f) => f.act(() => inputOf(f).props.onKeyDown({ key: 'Enter' }));

test('a valid amount applies on blur and on Enter, and the text is kept as typed until then', async () => {
  const f = await mountField({ value: 5 });
  typeText(f, '2.5');
  assert.equal(shown(f), '2.5', 'the text is kept as typed');
  assert.deepEqual(f.calls, [], 'nothing applies while typing');
  blur(f);
  assert.deepEqual(f.calls, [2.5]);
  assert.equal(shown(f), '2.5');
  assert.equal(reasonShown(f), null, 'no reason once a value applies');
  typeText(f, '1,000');
  pressEnter(f);
  assert.deepEqual(f.calls, [2.5, 1000], 'Enter applies a thousands-separated amount');
  assert.equal(shown(f), '1000');
});

test('more than 2 decimals is refused with its reason, is never rounded, and the applied amount stays', async () => {
  const f = await mountField({ value: 5 });
  typeText(f, '12.345');
  pressEnter(f);
  assert.deepEqual(f.calls, [], 'nothing applies, so 12.345 is not rounded to 12.35 or 12.34');
  assert.equal(reasonShown(f), 'Up to 2 decimal places.');
  assert.equal(shown(f), '12.345', 'the text stays so it can be corrected');
  assert.equal(inputOf(f).props['aria-invalid'], 'true');
  assert.equal(f.props.value, 5, 'the applied amount is kept');
  typeText(f, '1.234');
  blur(f);
  assert.equal(reasonShown(f), 'Up to 2 decimal places.');
  assert.deepEqual(f.calls, []);
  typeText(f, '12.30');
  blur(f);
  assert.deepEqual(f.calls, [12.3], 'a 2-decimal entry applies exactly');
  assert.equal(reasonShown(f), null, 'the reason clears once a value applies');
  assert.equal(inputOf(f).props['aria-invalid'], 'false');
});

test('negative, unreadable, empty and malformed entries are refused with a reason, never read as a positive amount', async () => {
  const f = await mountField({ value: 5 });
  const cases = [
    ['-5', 'Negative amounts are not allowed.'],
    ['abc', 'Use digits, one decimal point and commas (for thousands) only.'],
    ['1.2.3', 'Only one decimal point is allowed.'],
    ['1,5', 'Commas only separate thousands, as in 1,000.'],
    ['', 'Type an amount of $0 or more.'],
  ];
  for (const [text, reason] of cases) {
    typeText(f, text);
    blur(f);
    assert.equal(reasonShown(f), reason, `"${text}" is refused with its reason`);
  }
  assert.deepEqual(f.calls, [], 'no case applied');
  assert.equal(f.props.value, 5, 'the applied amount is unchanged');
});

test('a currency with no minor unit refuses cents with its reason and takes a whole amount', async () => {
  const f = await mountField({ value: 5, currCode: 'JPY' });
  typeText(f, '5.5');
  blur(f);
  assert.match(reasonShown(f), /Japanese Yen has no cents: enter a whole amount\./);
  typeText(f, '1,200.00');
  blur(f);
  assert.deepEqual(f.calls, [1200]);
});

test('a caller range is a parameter: each limit is refused with its reason, and the limits themselves apply', async () => {
  const f = await mountField({ value: 50, range: { min: 10, max: 500, noun: 'amount' } });
  typeText(f, '5');
  blur(f);
  assert.equal(reasonShown(f), 'The lowest amount is $10.');
  typeText(f, '600');
  blur(f);
  assert.equal(reasonShown(f), 'The highest amount is $500.');
  typeText(f, '');
  blur(f);
  assert.equal(reasonShown(f), 'Type an amount from $10 to $500.');
  typeText(f, '10');
  blur(f);
  typeText(f, '500');
  blur(f);
  assert.deepEqual(f.calls, [10, 500], 'both limits apply');
});

test('the default range is the one every current caller has: 0 or more, with no upper bound', async () => {
  const { ctx } = await load();
  assert.deepEqual(plain(ctx.MONEY_INPUT_RANGE), { min: 0, max: null, noun: 'amount' });
  assert.deepEqual(plain(ctx.parseMoneyAmount('0', 'USD', ctx.MONEY_INPUT_RANGE)), { ok: true, value: 0 });
  assert.deepEqual(plain(ctx.parseMoneyAmount('1,000,000.25', 'USD', ctx.MONEY_INPUT_RANGE)), { ok: true, value: 1000000.25 });
});

test('the shared parser never rounds: a 3-decimal entry is refused, and a 2-decimal entry is read exactly', async () => {
  const { ctx } = await load();
  for (const text of ['12.345', '0.001', '1.005', '99.999']) {
    const r = plain(ctx.parseMoneyAmount(text, 'USD', ctx.MONEY_INPUT_RANGE));
    assert.deepEqual(r, { ok: false, reason: 'Up to 2 decimal places.' }, text);
  }
  assert.equal(ctx.parseMoneyAmount('0.10', 'USD', ctx.MONEY_INPUT_RANGE).value, 0.1);
  assert.equal(ctx.parseMoneyAmount('12.99', 'USD', ctx.MONEY_INPUT_RANGE).value, 12.99);
});

test('the error line is a reserved slot: present and the same size with or without a reason (rule 82)', async () => {
  const f = await mountField({ value: 5 });
  const clear = slotOf(f);
  typeText(f, 'abc');
  blur(f);
  const refused = slotOf(f);
  for (const slot of [clear, refused]) {
    assert.ok(slot, 'the slot is in the tree');
    assert.equal(slot.props.style.minHeight, 14);
    assert.equal(slot.props.style.marginTop, 4);
    assert.equal(slot.props.style.display, undefined, 'the slot is never display:none');
  }
  assert.equal(clear.props.style.visibility, 'hidden');
  assert.equal(clear.props['aria-hidden'], true);
  assert.equal(refused.props.style.visibility, 'visible');
  assert.equal(refused.props['aria-hidden'], false);
  assert.deepEqual(Object.keys(clear.props.style).sort(), Object.keys(refused.props.style).sort(), 'the same styles in both states');
});

test('the field is a text field, so it keeps what is typed, and it has no maxLength that would cut a paste silently', async () => {
  const f = await mountField({ value: 5 });
  const input = inputOf(f);
  assert.equal(input.props.type, 'text');
  assert.equal(input.props.inputMode, 'decimal');
  assert.equal(input.props.autoComplete, 'off');
  assert.equal(input.props.spellCheck, false);
  assert.equal(input.props.maxLength, undefined);
});

test('one parser (rule 80): money-parse.js is the only amount parser, and MoneyInput and the base field both call it', async () => {
  const files = (await readdir(SRC, { recursive: true })).map((f) => f.replace(/\\/g, '/')).filter((f) => /\.(js|jsx|mjs)$/.test(f));
  const defs = [];
  for (const f of files) {
    const src = await readFile(new URL(f, SRC), 'utf8');
    if (/function\s+parseMoney\w*\s*\(|function\s+parse\w*Amount\s*\(/.test(src)) defs.push(f);
  }
  assert.deepEqual(defs, ['money-parse.js'], 'the amount parser is defined in one module');
  const ui = await readFile(new URL('components/ui.jsx', SRC), 'utf8');
  const base = await readFile(new URL('components/BaseBetInput.jsx', SRC), 'utf8');
  for (const [name, src] of [['ui.jsx', ui], ['BaseBetInput.jsx', base]]) {
    assert.doesNotMatch(src, /parseFloat\(/, `${name} reads no number on its own`);
    assert.match(src, /parseMoneyAmount\(/, `${name} calls the shared parser`);
  }
  assert.doesNotMatch(ui + base, /parseBaseAmount/, 'the old base parser is gone');
});

test('MoneyInput rounds nothing: its commit path has no Math.round', async () => {
  const ui = await readFile(new URL('components/ui.jsx', SRC), 'utf8');
  const start = ui.indexOf('function MoneyInput(');
  const end = ui.indexOf('\nfunction ', start + 1);
  const body = ui.slice(start, end);
  assert.match(body, /parseMoneyAmount\(/);
  assert.doesNotMatch(body, /Math\.round/);
});

test('every MoneyInput caller is named and keeps the default range: none passes a range of its own', async () => {
  const expected = {
    'components/modals.jsx': 4, // Cash Out, Starting Bankroll, Default Buy In (onboarding), Buy In amount
    'components/SecondaryPages.jsx': 1, // Default Buy In (settings)
    'components/SimModePage.jsx': 1, // Starting Bankroll (simulation)
    'App.jsx': 1, // Current Bankroll
  };
  const found = {};
  const withRange = [];
  for (const f of (await readdir(SRC, { recursive: true })).map((p) => p.replace(/\\/g, '/')).filter((p) => /\.(js|jsx|mjs)$/.test(p))) {
    const src = await readFile(new URL(f, SRC), 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('<MoneyInput')) continue;
      found[f] = (found[f] || 0) + 1;
      if (/\brange=/.test(line)) withRange.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(found, expected, 'the callers are the ones named here; a new caller must state its range');
  assert.deepEqual(withRange, [], 'no caller passes a range, so each keeps the default');
});

test('the Table Limits copy states what the Min Bet does today, and drops the stale claims', async () => {
  const modals = await readFile(new URL('components/modals.jsx', SRC), 'utf8');
  assert.doesNotMatch(modals, /This controls which unit bet sizes are valid/);
  assert.doesNotMatch(modals, /warns when a progression would exceed the max/);
  assert.match(modals, /A base bet below the Min Bet is allowed and shows a note; it is never blocked\./);
});

test('build.js registers money-parse.js before both of its users', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const at = build.indexOf("'money-parse.js'");
  assert.ok(at > -1, 'registered in FILES');
  assert.ok(at < build.indexOf("'components/ui.jsx'"), 'before ui.jsx (MoneyInput)');
  assert.ok(at < build.indexOf("'components/BaseBetInput.jsx'"), 'before BaseBetInput.jsx');
});
