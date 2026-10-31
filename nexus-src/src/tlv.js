// -- Section TLV: the readings for one dozen or column --
// TLV (total loss level) of a section is the sum of the loss levels (droughts) of its 12 numbers. A spin that misses the
// section adds 12. A spin that hits it adds 11 minus the loss level of the number that hit, because the other 11 gain
// one and that number drops to 0. Pure: nothing here writes droughts or spins. It reads the generated distributions in
// streak-percentiles.js (STREAK_PERCENTILE_DATA.tlv and .avg) and the single-number table through percentile.js.

// The percentile tiers a badge can show, highest first. A value shows the highest tier it has reached.
const TIER_LEVELS = [98, 95, 75, 50, 25];

// The gold of a section's coldest number: the number's text and a small corner pip on the board, and its text on the tile and
// in the detail view. It is never the F10 outline colour, so the outline still reads on the same square.
const COLDEST_GOLD = "#ffd700";

// The tier a percentile has reached: the highest of TIER_LEVELS at or below it, or null below P25 or with no percentile.
function percentileTier(pct) {
  if (typeof pct !== "number" || !(pct >= 0)) return null;
  for (let i = 0; i < TIER_LEVELS.length; i++) {
    if (pct >= TIER_LEVELS[i]) return TIER_LEVELS[i];
  }
  return null;
}

// The badge text for a tier: "P75", or "" when there is no tier.
function tierTag(tier) {
  return tier === null || tier === undefined ? "" : "P" + tier;
}

// The numbers of a section as the labels the session records: a dozen (index 0 to 2) or a column (index 0 to 2).
function sectionNumbers(kind, index) {
  const out = [];
  for (let n = 1; n <= 36; n++) {
    const label = String(n);
    if (kind === "dozen" ? dozenOf(label) === index : columnOf(label) === index) out.push(label);
  }
  return out;
}

// The TLV after one spin. `hit` is whether the spin hit the section; `hitLoss` is the loss level of the number that hit
// before the spin (ignored on a miss).
function tlvAfterSpin(tlv, hit, hitLoss) {
  return hit ? tlv + 11 - hitLoss : tlv + 12;
}

// The TLV of a section now: the sum of the loss levels of its numbers in `droughts` (the session's per-number counts).
function sectionTLV(droughts, numbers) {
  let total = 0;
  for (const n of numbers) total += (droughts && droughts[n]) || 0;
  return total;
}

// The average loss level in tenths: TLV / 12 rounded to the nearest tenth. Also the index of the average's distribution.
function avgTenths(tlv) {
  return Math.round((tlv * 10) / 12);
}

// The average loss level of a section's numbers: TLV / 12 to one decimal, as a number such as 37.5.
function sectionAvg(tlv) {
  return avgTenths(tlv) / 10;
}

// The coldest number of a section: its largest loss level and which number has it (the first in list order on a tie).
function sectionMax(droughts, numbers) {
  let loss = -1;
  let number = null;
  for (const n of numbers) {
    const d = (droughts && droughts[n]) || 0;
    if (d > loss) {
      loss = d;
      number = n;
    }
  }
  return { loss: loss < 0 ? 0 : loss, number };
}

// The coldest numbers of a section: every number tied at the section's highest loss level, in list order, and that level.
// When the highest level is 0 no number is coldest and the result has no numbers. 0 and 00 are never in a section.
function sectionColdest(kind, index, droughts) {
  const numbers = sectionNumbers(kind, index);
  const level = sectionMax(droughts, numbers).loss;
  if (level <= 0) return { level: 0, numbers: [] };
  return { level, numbers: numbers.filter((n) => ((droughts && droughts[n]) || 0) === level) };
}

// The numbers the board marks gold: the coldest numbers of all six sections (each dozen and each column), as a set keyed by
// label. Read from droughts alone, so it follows every spin, undo and correction.
function coldestGoldNumbers(droughts) {
  const out = {};
  ["dozen", "column"].forEach((kind) => {
    for (let i = 0; i < 3; i++) sectionColdest(kind, i, droughts).numbers.forEach((n) => { out[n] = true; });
  });
  return out;
}

// How many of a section's numbers are at or above their own single-number P95 on this wheel. `table` defaults to the
// generated table.
function coldCount(droughts, numbers, wheel, table) {
  let count = 0;
  for (const n of numbers) {
    const pct = streakPercentile("straight:" + n, wheel, (droughts && droughts[n]) || 0, table);
    if (pct !== null && pct >= 95) count += 1;
  }
  return count;
}

// The TLV after every spin of a session, from the spins alone. Spins are the recorded labels ("0", "00", "1" to "36"),
// and entry i is the TLV after spin i + 1. Every loss level starts at zero, as a session does.
function tlvSeries(spins, numbers) {
  const inSection = {};
  numbers.forEach((n) => { inSection[n] = true; });
  const lastHit = {};
  const series = [];
  let tlv = 0;
  for (let i = 0; i < spins.length; i++) {
    const label = String(spins[i]);
    const hit = inSection[label] === true;
    // The hit number's loss level before this spin: the spins since its last hit, counted from the start for a number not yet hit.
    const hitLoss = hit ? i - 1 - (lastHit[label] === undefined ? -1 : lastHit[label]) : 0;
    tlv = tlvAfterSpin(tlv, hit, hitLoss);
    if (hit) lastHit[label] = i;
    series.push(tlv);
  }
  return series;
}

// The part of a series the sparkline draws: since the current losing streak began (from the spin of the section's last
// hit to the latest spin), or the last 50 spins when there is no streak. `streak` is the section's current losing streak.
// Returns the values and the index of the first one in the series.
function tlvWindow(series, streak) {
  const n = series.length;
  if (streak > 0) {
    const start = Math.max(0, n - 1 - streak);
    return { values: series.slice(start), start };
  }
  const start = Math.max(0, n - 50);
  return { values: series.slice(start), start };
}

// The entry of a distribution in the generated table: block "tlv" or "avg", kind "dozen" or "column", for this wheel.
// null for an unknown wheel or kind.
function distEntry(block, kind, wheel, table) {
  const data = table || STREAK_PERCENTILE_DATA;
  const blocks = data[block];
  const cats = blocks && Object.prototype.hasOwnProperty.call(blocks, wheel) ? blocks[wheel] : null;
  return cats && Object.prototype.hasOwnProperty.call(cats, kind) ? cats[kind] : null;
}

// The percentile of a value on a distribution entry: the share of its samples at or below the value, to one decimal,
// rounded down. A value past the table reads as the table's last entry. null with no entry or a value that is not a number.
function distPercentile(entry, value) {
  if (!entry || typeof value !== "number" || !(value >= 0)) return null;
  const k = Math.min(Math.floor(value), entry.cum.length - 1);
  return Math.floor(entry.cum[k] / 1000) / 10;
}

// Everything a section's tile and detail view show. `input` gives the section and the session: kind, index, spins,
// droughts (the per-number loss levels), wheel, and the section's current losing streak with its percentile (from App's
// dozD and dozP or colD and colP). The percentile is computed here when it is not given. `table` defaults to the
// generated table. Every value is a function of these inputs, so the tile and the detail view can never disagree.
function sectionReadout(input, table) {
  const { kind, index, wheel } = input;
  const numbers = sectionNumbers(kind, index);
  const key = kind + ":" + index;
  const spins = input.spins || [];
  const droughts = input.droughts || {};
  const streak = input.streak || 0;
  const streakPct = typeof input.streakPct === "number" ? input.streakPct : streakPercentile(key, wheel, streak, table);
  const series = tlvSeries(spins, numbers);
  const tlv = series.length ? series[series.length - 1] : 0;
  const avg = sectionAvg(tlv);
  const tlvEntry = distEntry("tlv", kind, wheel, table);
  const avgEntry = distEntry("avg", kind, wheel, table);
  const tlvPct = distPercentile(tlvEntry, tlv);
  const avgPct = distPercentile(avgEntry, avgTenths(tlv));
  const max = sectionMax(droughts, numbers);
  const coldest = sectionColdest(kind, index, droughts);
  const maxPct = max.number === null ? null : streakPercentile("straight:" + max.number, wheel, max.loss, table);
  const cold = coldCount(droughts, numbers, wheel, table);
  const window = tlvWindow(series, streak);
  const shadeFrom = streak > 0 ? Math.max(0, series.length - 1 - streak) : null;
  const perNumber = numbers.map((n, order) => {
    const loss = droughts[n] || 0;
    const pct = streakPercentile("straight:" + n, wheel, loss, table);
    return { number: n, loss, pct, tier: percentileTier(pct), order, gold: coldest.numbers.indexOf(n) !== -1 };
  });
  perNumber.sort((a, b) => (b.loss - a.loss) || (a.order - b.order));
  const labels = kind === "dozen"
    ? { label: DOZEN_LABELS[index], range: DOZEN_RANGES[index], colorBd: DOZEN_BORDERS[index], colorTx: DOZEN_TEXTS[index] }
    : { label: COLUMN_LABELS[index], range: COLUMN_RANGES[index], colorBd: COLUMN_BORDERS[index], colorTx: COLUMN_TEXTS[index] };
  return {
    key, kind, index, wheel, numbers, ...labels,
    streak, streakPct, streakTier: percentileTier(streakPct),
    tlv, tlvPct, tlvTier: percentileTier(tlvPct), tlvLevels: tlvEntry ? tlvEntry.p : null,
    avg, avgPct, avgTier: percentileTier(avgPct),
    max: max.loss, maxNumber: max.number, maxPct, maxTier: percentileTier(maxPct),
    cold,
    coldest,
    perNumber,
    series,
    windowValues: window.values,
    windowStart: window.start,
    shadeFrom,
  };
}
