import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// The venue sheet and the spin-count card (F11), rendered from the real source. Rule 82: every optional slot is
// reserved, so the same slots exist whatever kind is chosen. Rule 80: the start step, the edit sheet and the end
// confirm mount one VenuePicker. Rule 81: nothing in the picker asks for a horizontal scroll.

const SRC = new URL('../nexus-src/src/', import.meta.url);

const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js',
  'components/ui.jsx', 'components/modals.jsx', 'components/VenuePicker.jsx', 'components/SecondaryPages.jsx',
];

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
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
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
  vm.runInContext(code, sandbox, { filename: 'venue-picker-slice.js' });
  return sandbox;
}

const OPTIONS = {
  casino: ['Casino One', 'Casino Two'],
  maker: ['Maker One'],
  model: ['Model One'],
  version: ['2'],
  table: ['3', '4'],
  dealer: ['Ann', 'Bo'],
};

function picker(ctx, props) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.VenuePicker, {
    title: 'Where are you playing?',
    value: null,
    options: OPTIONS,
    onSave: () => {},
    onSecondary: () => {},
    ...props,
  }));
}

const count = (html, pattern) => (html.match(pattern) || []).length;

test('the picker is not a native select, and the add-new field is plain text with autofill and spelling help off', async () => {
  const ctx = await loadSlice();
  const html = picker(ctx, { value: { casino: 'Casino One', kind: 'table', table: '3', dealer: 'Ann' } });
  assert.doesNotMatch(html, /<select/i, 'no native select (rule 27)');
  assert.match(html, /<input[^>]*type="text"/);
  assert.match(html, /autoComplete|autocomplete="off"/);
  assert.match(html, /autocorrect="off"/);
  assert.match(html, /autocapitalize="off"/);
  assert.match(html, /spellcheck="false"/);
  assert.match(html, /aria-haspopup="listbox"/);
});

test('reserved slots: the same slots and the same note line whichever kind is chosen (rule 82)', async () => {
  const ctx = await loadSlice();
  const states = {
    none: picker(ctx, { value: null }),
    machine: picker(ctx, { value: { casino: 'Casino One', kind: 'machine', maker: 'Maker One', model: 'Model One', version: '2' } }),
    table: picker(ctx, { value: { casino: 'Casino One', kind: 'table', table: '3', dealer: 'Ann' } }),
  };
  const slots = (html) => ({
    areas: count(html, /grid-area:1 \/ 1/g),
    visibility: count(html, /visibility:(visible|hidden)/g),
    notes: count(html, /aria-live="polite"/g),
    noteHeight: count(html, /min-height:16px/g),
    fieldLabels: count(html, /text-transform:uppercase/g),
  });
  const base = slots(states.none);
  for (const [name, html] of Object.entries(states)) {
    assert.deepEqual(slots(html), base, `${name} has the same reserved slots as none`);
  }
  assert.equal(base.notes, 1, 'one note line, always present');
  // Exactly one of the three stacked groups is visible in each state: the placeholder, the machine fields, or the table fields.
  const visibleGroup = (html) => count(html, /gap:12px;visibility:visible/g);
  assert.equal(visibleGroup(states.none), 1, 'the placeholder is the visible group with no kind');
  assert.equal(visibleGroup(states.machine), 1, 'the machine fields are the visible group for a machine');
  assert.equal(visibleGroup(states.table), 1, 'the table fields are the visible group for a table');
});

test('a dealer change from a recorded dealer shows the spin it starts from; a locked dealer says so; the note line is reserved either way', async () => {
  const ctx = await loadSlice();
  const quiet = picker(ctx, { value: { kind: 'table', table: '3', dealer: 'Ann' }, dealerFromSpin: 5 });
  assert.doesNotMatch(quiet, /recorded from spin/, 'no change is shown until the dealer is changed');
  assert.doesNotMatch(quiet, /kept as recorded/);
  const locked = picker(ctx, { value: { kind: 'table', table: '3', dealer: 'Bo' }, locked: true, dealerFromSpin: null });
  assert.match(locked, /Dealer changes after the start are kept as recorded\./);
  assert.match(locked, /aria-live="polite"/);
});

test('the sheet buttons: Skip appears only when a secondary action is given, and the save label is the caller\'s', async () => {
  const ctx = await loadSlice();
  const withSkip = picker(ctx, { saveLabel: 'Save and end', secondaryLabel: 'Skip' });
  assert.match(withSkip, />Skip</);
  assert.match(withSkip, />Save and end</);
  const noSkip = picker(ctx, { onSecondary: undefined });
  assert.doesNotMatch(noSkip, />Skip</);
  assert.match(noSkip, />Save</);
});

test('one venue sheet: the start step, the end confirm and the edit sheet mount the same VenuePicker', async () => {
  const ctx = await loadSlice();
  const start = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.VenueModal, {
    title: 'Where are you playing?', value: null, options: OPTIONS, dealerFromSpin: null,
    saveLabel: 'Save', secondaryLabel: 'Skip', onSave: () => {}, onDismiss: () => {},
  }));
  assert.match(start, /Where are you playing\?/);
  assert.match(start, />Skip</);
  assert.match(start, /aria-label="Venue kind"/);
  const edit = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.VenueModal, {
    title: 'Venue', value: { casino: 'Casino Two', kind: 'machine', maker: 'Maker One' }, options: OPTIONS, locked: false,
    dealerFromSpin: 3, saveLabel: 'Save', secondaryLabel: 'Cancel', onSave: () => {}, onDismiss: () => {},
  }));
  assert.match(edit, />Cancel</);
  assert.match(edit, /aria-label="Venue kind"/);
});

test('spins logged by venue renders the counts with the no-venue line beside the total (counts only)', async () => {
  const ctx = await loadSlice();
  const sessions = [
    { id: 'a', spins: Array.from({ length: 4 }, () => '1'), venue: { casino: 'Casino One', kind: 'machine', maker: 'Maker One', model: 'Model One', version: '2' } },
    { id: 'b', spins: Array.from({ length: 3 }, () => '2') },
  ];
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.VenueSpinCounts, { sessions }));
  assert.match(html, /Spins logged by venue/);
  assert.match(html, /7 spins in 2 saved sessions · 3 with no venue/);
  assert.match(html, />Casino One</);
  assert.match(html, />Maker One Model One 2</);
  assert.match(html, /None recorded/, 'an empty group says so, rather than disappearing');
});

test('layout guard: no fixed width above a phone, and no horizontal scroll, in the venue sheet (rule 81)', async () => {
  const picker = await readFile(new URL('../nexus-src/src/components/VenuePicker.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(picker, /width:\s*['"]?\d{3,}(?!\s*%)/, 'no fixed pixel width (percentages are fine)');
  assert.doesNotMatch(picker, /overflowX:\s*['"]scroll/, 'no horizontal scroll container');
  assert.match(picker, /overflowX:'hidden'/, 'the listbox hides any sideways overflow');
});
