import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Dealer names are other people's names (F11). They stay in the player's own sessions, on the device and in the
// account's own sync. The feedback report, logs, analytics and the Casino bridge carry none of them.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const VENUE_WORDS = /venue|dealer/i;

test('the feedback payload carries no venue fields, even with a venue and dealer changes on the session', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  const start = app.indexOf('async function submitFeedback()');
  const end = app.indexOf('function exportJSON()');
  assert.ok(start > 0 && end > start, 'submitFeedback is in App.jsx, before exportJSON');
  const opened = [];
  const sandbox = {
    window: { open: (url) => { opened.push(url); } },
    encodeURIComponent,
    APP_VERSION: '0.53.0',
    // The live session, with a venue and a dealer recorded on it: none of it may reach the report.
    sess: {
      spins: ['7', '12', '0'],
      venue: { casino: 'Casino Two', kind: 'table', table: 'Blackjack 4', dealer: 'Dana Example' },
      dealerChanges: [{ fromSpin: 0, dealer: 'Dana Example' }, { fromSpin: 2, dealer: 'Eli Example' }],
    },
    feedbackText: 'The wheel felt slow',
    setFeedbackText: () => {},
    setFeedbackOpen: () => {},
  };
  vm.createContext(sandbox);
  await vm.runInContext(`${app.slice(start, end)}\nsubmitFeedback();`, sandbox);
  assert.equal(opened.length, 1, 'one mailto is opened');
  const url = opened[0];
  const decoded = decodeURIComponent(url);
  assert.match(decoded, /^mailto:info@nexus-foundry\.ai\?subject=\[Nexus Roulette Feedback\] The wheel felt slow&body=/);
  assert.match(decoded, /\n\n---\nv0\.53\.0 · .+ · 3 spins$/, 'the body is the text, the version, the time and the spin count');
  for (const name of ['Casino Two', 'Blackjack', 'Dana', 'Eli', 'Example', 'dealer', 'Dealer', 'venue', 'casino', 'table']) {
    assert.equal(decoded.includes(name), false, `the payload carries no "${name}"`);
  }
});

test('the Casino spin payload is built from wagers and segments, never from a venue', async () => {
  const recording = await readFile(new URL('casino-recording.mjs', SRC), 'utf8');
  assert.doesNotMatch(recording, VENUE_WORDS, 'casino-recording.mjs names no venue or dealer');
});

test('no logging, network, analytics or bridge line names a venue or dealer', async () => {
  const sink = /console\.|fetch\(|sendBeacon|postMessage|analytics|\.record\(|askCasino\(|navigator\.sendBeacon|XMLHttpRequest/;
  const files = (await readdir(SRC, { recursive: true }))
    .filter((f) => /\.(js|jsx|mjs)$/.test(f));
  const offenders = [];
  for (const f of files) {
    const lines = (await readFile(new URL(f, SRC), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (sink.test(line) && VENUE_WORDS.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'a sink line that also names a venue or dealer');
  assert.ok(files.length >= 20, `the scan covered ${files.length} source files`);
});
