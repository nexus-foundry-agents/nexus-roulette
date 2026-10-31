// Streak percentiles for every bet, from a seeded simulation of both wheels.
//
// A completed losing streak is a run of consecutive spins on which a bet loses, ended by the bet's next win.
// Its length is the number of losses in the run. A streak still running when a session ends is not counted,
// and every session starts with no streak in progress. Zero and double zero lose every even-money, dozen,
// column and group bet that does not cover them.
//
// Usage:
//   node tools/gen-streak-percentiles.mjs [--sessions 1000] [--spins 1000000] [--workers N]
//                                         [--seed <label>] [--out <path>]
//
// The default output is nexus-src/src/streak-percentiles.js, the module the app reads. That file is generated:
// regenerate it from this script and never edit it by hand. --workers defaults to half the logical cores.

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

export const SEED_LABEL = 'nexus-roulette-streak-percentiles-2026-10-30';
export const ALGORITHM = 'xoshiro128** (Blackman and Vigna), one generator per session, seeded by splitmix32 '
  + 'from the FNV-1a 32-bit hash of the seed label, the wheel index and the session index';
export const PERCENTILES = [50, 75, 90, 95, 98];
export const WHEELS = ['american', 'european'];
// The cumulative table ends at the first length whose share reaches 99.99%. Kept as 9999 of 10000 so the test is exact.
const CUMULATIVE_PER_10000 = 9999;
// Streaks longer than this are an error, not a silent clamp: the table must be exact.
export const MAX_LENGTH = 4096;
const MAX_BYTES = 300 * 1024;
const DEFAULT_OUT = fileURLToPath(new URL('../nexus-src/src/streak-percentiles.js', import.meta.url));
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// Pocket labels in index order. The index is the pocket's position in this list.
export function pocketLabels(wheel) {
  const labels = wheel === 'american' ? ['0', '00'] : ['0'];
  for (let n = 1; n <= 36; n++) labels.push(String(n));
  return labels;
}

// Every bet category for a wheel, in the order the table lists them. `cover` lists the pocket labels the bet
// wins on. A group-bet shape uses one representative placement; every placement of a shape covers the same
// number of pockets.
export function betCategories(wheel) {
  const range = (a, b) => {
    const out = [];
    for (let n = a; n <= b; n++) out.push(String(n));
    return out;
  };
  const oneTo36 = range(1, 36);
  const cats = [
    ['red', [...RED].map(String)],
    ['black', oneTo36.filter((l) => !RED.has(+l))],
    ['odd', oneTo36.filter((l) => +l % 2 === 1)],
    ['even', oneTo36.filter((l) => +l % 2 === 0)],
    ['high', range(19, 36)],
    ['low', range(1, 18)],
    ['dozen:0', range(1, 12)],
    ['dozen:1', range(13, 24)],
    ['dozen:2', range(25, 36)],
    ['column:0', oneTo36.filter((l) => +l % 3 === 1)],
    ['column:1', oneTo36.filter((l) => +l % 3 === 2)],
    ['column:2', oneTo36.filter((l) => +l % 3 === 0)],
    ['split', ['1', '2']],
    ['street', ['1', '2', '3']],
    ['corner', ['1', '2', '4', '5']],
    ['line', ['1', '2', '3', '4', '5', '6']],
  ];
  if (wheel === 'american') cats.push(['basket', ['0', '00', '1', '2', '3']]);
  for (const label of pocketLabels(wheel)) cats.push([`straight:${label}`, [label]]);
  return cats.map(([key, cover]) => ({ key, cover }));
}

// The win table, transposed for the hot loop: table[pocket * nC + category] is 1 when that bet wins on that pocket.
export function winTable(wheel) {
  const labels = pocketLabels(wheel);
  const cats = betCategories(wheel);
  const nP = labels.length;
  const nC = cats.length;
  const table = new Uint8Array(nP * nC);
  cats.forEach((cat, c) => {
    const cover = new Set(cat.cover);
    labels.forEach((label, p) => {
      if (cover.has(label)) table[p * nC + c] = 1;
    });
  });
  return { labels, cats, table, nP, nC };
}

export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// splitmix32 expands one 32-bit value into the words a generator needs. It is used only to seed.
function splitmix32(start) {
  let x = start >>> 0;
  return () => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

// The starting state of one session's xoshiro128** generator. Each (master seed, wheel, session) gets its own state,
// so the result does not depend on how sessions are split across workers.
export function sessionState(master, wheelIndex, session) {
  const next = splitmix32((master ^ Math.imul(wheelIndex + 1, 0x9e3779b1) ^ Math.imul(session + 1, 0x85ebca77)) >>> 0);
  const s = [next(), next(), next(), next()];
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1; // the all-zero state is a fixed point of xoshiro
  return s;
}

// The reference xoshiro128** step: returns the next 32-bit output and advances the state in place.
// playSession inlines the same arithmetic for speed; the test checks that the two agree.
export function xoshiroNext(s) {
  const m = Math.imul(s[1], 5);
  const result = Math.imul((m << 7) | (m >>> 25), 9) >>> 0;
  const t = s[1] << 9;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = (s[3] << 11) | (s[3] >>> 21);
  return result;
}

// Plays one session of `spins` spins and adds each completed losing streak into `hist`:
// hist[c * MAX_LENGTH + length] counts the streaks of category c with that length. `run` is scratch space of one
// Int32 per category. Returns how many streaks were longer than MAX_LENGTH, which must be zero.
export function playSession(state, spins, tbl, hist, run) {
  const { nP, nC, table } = tbl;
  let s0 = state[0] | 0;
  let s1 = state[1] | 0;
  let s2 = state[2] | 0;
  let s3 = state[3] | 0;
  run.fill(0);
  let overflow = 0;
  for (let i = 0; i < spins; i++) {
    const m = Math.imul(s1, 5);
    const r = Math.imul((m << 7) | (m >>> 25), 9);
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    const base = Math.floor(((r >>> 0) * nP) / 4294967296) * nC;
    for (let c = 0; c < nC; c++) {
      if (table[base + c] === 1) {
        const k = run[c];
        if (k > 0) {
          if (k < MAX_LENGTH) hist[c * MAX_LENGTH + k] += 1;
          else overflow += 1;
        }
        run[c] = 0;
      } else {
        run[c] += 1;
      }
    }
  }
  return overflow;
}

// One shard: the sessions whose index is congruent to `shard` modulo `shards`, for each wheel named.
export function runShard({ master, sessions, spins, wheels, shard, shards }) {
  const hist = {};
  let overflow = 0;
  for (const wheelName of wheels) {
    const tbl = winTable(wheelName);
    const h = new Float64Array(tbl.nC * MAX_LENGTH);
    const run = new Int32Array(tbl.nC);
    const widx = WHEELS.indexOf(wheelName);
    for (let s = shard; s < sessions; s += shards) {
      overflow += playSession(sessionState(master, widx, s), spins, tbl, h, run);
    }
    hist[wheelName] = h;
  }
  return { hist, overflow };
}

function runInWorker(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { streakShard: job } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`streak worker exited with code ${code}`));
    });
  });
}

// Turns one wheel's histograms into its table: n, the length at each percentile, and the cumulative table in
// parts per million up to the 99.99% length.
function summarize(wheelName, hist) {
  const tbl = winTable(wheelName);
  const categories = {};
  tbl.cats.forEach((cat, c) => {
    const bins = hist.subarray(c * MAX_LENGTH, (c + 1) * MAX_LENGTH);
    let n = 0;
    for (let k = 1; k < MAX_LENGTH; k++) n += bins[k];
    if (n === 0) throw new Error(`${cat.key} on ${wheelName}: no completed losing streaks were counted`);
    const raw = [];
    const lengths = {};
    let running = 0;
    let reached = false;
    for (let k = 1; k < MAX_LENGTH && !reached; k++) {
      running += bins[k];
      raw.push(running);
      for (const pct of PERCENTILES) {
        if (lengths[pct] === undefined && running * 100 >= pct * n) lengths[pct] = k;
      }
      if (running * 10000 >= n * CUMULATIVE_PER_10000) reached = true;
    }
    if (!reached) throw new Error(`${cat.key} on ${wheelName}: the 99.99% length is past MAX_LENGTH`);
    // floor, not round: a share of at least 98% then reads at least 980000, and one below reads below it.
    const cum = raw.map((count) => Math.floor((count * 1000000) / n));
    categories[cat.key] = { n, p: PERCENTILES.map((pct) => lengths[pct]), cum };
  });
  return categories;
}

// Runs every shard (in workers when there is more than one) and sums them into the table.
// Returns { meta, american, european } with the table's shape: meta, then one object per wheel.
export async function simulate({ seedLabel = SEED_LABEL, sessions = 1000, spins = 1000000, workers = 1, wheels = WHEELS } = {}) {
  const master = fnv1a32(seedLabel);
  const shards = Math.max(1, Math.min(workers, sessions));
  const jobs = [];
  for (let shard = 0; shard < shards; shard++) {
    const job = { master, sessions, spins, wheels, shard, shards };
    jobs.push(shards === 1 ? Promise.resolve(runShard(job)) : runInWorker(job));
  }
  const parts = await Promise.all(jobs);
  const totals = {};
  let overflow = 0;
  for (const part of parts) {
    overflow += part.overflow;
    for (const w of wheels) {
      if (!totals[w]) totals[w] = new Float64Array(part.hist[w].length);
      const src = part.hist[w];
      const dst = totals[w];
      for (let i = 0; i < src.length; i++) dst[i] += src[i];
    }
  }
  if (overflow > 0) throw new Error(`${overflow} streaks were longer than MAX_LENGTH (${MAX_LENGTH}); the table would not be exact`);
  const data = {
    meta: {
      seedLabel,
      seed: '0x' + fnv1a32(seedLabel).toString(16).padStart(8, '0'),
      algorithm: ALGORITHM,
      sessions,
      spinsPerSession: spins,
      wheels: [...wheels],
      pockets: Object.fromEntries(wheels.map((w) => [w, pocketLabels(w).length])),
      percentiles: [...PERCENTILES],
      cumulativeTo: CUMULATIVE_PER_10000 / 10000,
      streakDefinition: 'consecutive spins a bet loses before its next win; a streak still running when a session ends is not counted',
      generator: 'tools/gen-streak-percentiles.mjs',
    },
  };
  for (const w of wheels) data[w] = summarize(w, totals[w]);
  return data;
}

// Renders the module: a header with the seed, sessions, spins, algorithm and generation time, then plain data.
export function renderModule(data, generatedAt) {
  const m = data.meta;
  const header = [
    '// Streak percentiles. GENERATED FILE: do not edit by hand. Regenerate with tools/gen-streak-percentiles.mjs.',
    `// Generated: ${generatedAt}`,
    `// Seed: "${m.seedLabel}" (FNV-1a 32-bit ${m.seed})`,
    `// Algorithm: ${m.algorithm}.`,
    `// Simulation: ${m.sessions} sessions x ${m.spinsPerSession} spins for each wheel: ${m.wheels.map((w) => `${w} (${m.pockets[w]} pockets)`).join(', ')}.`,
    `// A completed losing streak is ${m.streakDefinition}.`,
    '// Each category: n = completed streaks; p = their length at P50, P75, P90, P95 and P98; cum[k - 1] = parts per',
    '// million of completed streaks of length k or shorter, for k = 1 up to the length where the cumulative reaches 99.99%.',
    '// Read through streakPercentile() in percentile.js.',
  ];
  const body = ['var STREAK_PERCENTILE_DATA = {', `"meta":${JSON.stringify({ ...m, generatedAt })}`];
  for (const w of m.wheels) {
    const entries = Object.entries(data[w]).map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`);
    body.push(`,${JSON.stringify(w)}:{`, entries.join(',\n'), '}');
  }
  body.push('};');
  return header.join('\n') + '\n' + body.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = {
    sessions: 1000,
    spins: 1000000,
    workers: Math.max(1, Math.floor((os.availableParallelism ? os.availableParallelism() : os.cpus().length) / 2)),
    seedLabel: SEED_LABEL,
    out: DEFAULT_OUT,
  };
  const names = { '--sessions': 'sessions', '--spins': 'spins', '--workers': 'workers', '--seed': 'seedLabel', '--out': 'out' };
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (name === 'sessions' || name === 'spins' || name === 'workers') {
      if (!/^[1-9]\d*$/.test(value)) throw new Error(`${argv[i]} must be a positive whole number`);
      opts[name] = Number(value);
    } else {
      opts[name] = value;
    }
  }
  return opts;
}

function percentileRow(key, entry) {
  return [key.padEnd(16), String(entry.n).padStart(11), ...entry.p.map((l) => String(l).padStart(5))].join(' ');
}

async function main(argv) {
  const opts = parseArgs(argv);
  const started = Date.now();
  const data = await simulate({ seedLabel: opts.seedLabel, sessions: opts.sessions, spins: opts.spins, workers: opts.workers });
  const wall = (Date.now() - started) / 1000;
  const generatedAt = new Date().toISOString();
  const text = renderModule(data, generatedAt);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`the module is ${bytes} bytes, over the 300 KB limit`);
  writeFileSync(opts.out, text, 'utf8');
  const spinsTotal = opts.sessions * opts.spins * WHEELS.length;
  console.log(`seed ${data.meta.seed} "${data.meta.seedLabel}"; ${opts.sessions} sessions x ${opts.spins} spins per wheel; workers ${opts.workers}`);
  console.log(`wall ${wall.toFixed(1)} s; ${Math.round(spinsTotal / wall).toLocaleString('en-US')} spins/s across both wheels; module ${bytes} bytes -> ${opts.out}`);
  for (const w of WHEELS) {
    console.log(`\n${w}  ${'category'.padEnd(16)} ${'n'.padStart(11)} ${PERCENTILES.map((p) => ('P' + p).padStart(5)).join(' ')}`);
    for (const [key, entry] of Object.entries(data[w])) console.log(percentileRow(key, entry));
  }
}

if (!isMainThread && workerData && workerData.streakShard) {
  parentPort.postMessage(runShard(workerData.streakShard));
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
