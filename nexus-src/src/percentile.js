// -- Streak percentiles: where a current losing streak sits --
// Reads the generated table in streak-percentiles.js (built by tools/gen-streak-percentiles.mjs). Pure: nothing
// here writes the table. A length is a count of consecutive losses, which is the drought of a bet or a number.

const STREAK_WHEELS = ["american", "european"];

// The table entry for one bet on one wheel, or null when either is not in the table. `table` defaults to the
// generated STREAK_PERCENTILE_DATA; the tests pass a table of the same shape.
function streakEntry(category, wheel, table) {
  if (STREAK_WHEELS.indexOf(wheel) < 0) return null;
  const data = table || STREAK_PERCENTILE_DATA;
  const cats = data[wheel];
  return cats && Object.prototype.hasOwnProperty.call(cats, category) ? cats[category] : null;
}

// Where a current losing streak of `currentLength` consecutive losses sits among the completed losing streaks of
// the same bet on the same wheel: the share of them that are that length or shorter.
// Returns 0 to 99.9 to one decimal, rounded DOWN so it never overstates. 0 for no losses. A length past the table's
// last entry (the 99.99% length) reads as that last entry. null for an unknown bet or wheel, or a length that is
// not a number.
function streakPercentile(category, wheel, currentLength, table) {
  const entry = streakEntry(category, wheel, table);
  if (!entry || typeof currentLength !== "number" || !(currentLength >= 0)) return null;
  const length = Math.floor(currentLength);
  if (length === 0) return 0;
  const k = Math.min(length, entry.cum.length);
  // cum is parts per million, so a tenth of a percent is 1000 parts per million.
  return Math.floor(entry.cum[k - 1] / 1000) / 10;
}

// The streak length at P50, P75, P90, P95 and P98 for one bet on one wheel, in that order, or null.
function streakPercentileLengths(category, wheel, table) {
  const entry = streakEntry(category, wheel, table);
  return entry ? entry.p.slice() : null;
}

// The compact form a count shows beside itself: "P96" for a percentile of 96.3. A null percentile gives "".
function percentTag(pct) {
  return pct === null || pct === undefined ? "" : "P" + Math.floor(pct);
}

// The value of the Counter setting after one tap. Spins is the default; anything other than "percentile" reads as Spins.
function nextCounterShows(current) {
  return current === "percentile" ? "spins" : "percentile";
}

// The mode a board's counter is drawn in. Only the saved value "percentile" selects the percentile; a missing key
// (settings saved before the setting existed) and anything else read as "spins". Both boards call this one function.
function counterMode(counterShows) {
  return counterShows === "percentile" ? "percentile" : "spins";
}

// Group-bet shapes are one representative placement each; every placement of a shape covers the same count of numbers.
const STREAK_SHAPE_LABELS = {
  split: "Split 1-2",
  street: "Street 1-2-3",
  corner: "Corner 1-2-4-5",
  line: "Six-line 1-6",
  basket: "Basket 0, 00, 1, 2, 3",
};

// The label a table key shows in the Stats table, in the app's own wording for the bet.
function streakLabel(key) {
  const em = EVEN_MONEY.filter((e) => e.key === key)[0];
  if (em) return em.label;
  const parts = key.split(":");
  if (parts[0] === "dozen") return DOZEN_LABELS[+parts[1]] + " (" + DOZEN_RANGES[+parts[1]] + ")";
  if (parts[0] === "column") return COLUMN_LABELS[+parts[1]] + " (" + COLUMN_RANGES[+parts[1]] + ")";
  if (parts[0] === "straight") return "#" + parts[1];
  return STREAK_SHAPE_LABELS[key] || key;
}

// The rows of the Streak percentiles table for a wheel, in table order: each bet's key, label, streak lengths at
// P50 to P98 and completed-streak count. An unknown wheel gives no rows.
function streakRows(wheel, table) {
  if (STREAK_WHEELS.indexOf(wheel) < 0) return [];
  const data = table || STREAK_PERCENTILE_DATA;
  const cats = data[wheel] || {};
  return Object.keys(cats).map((key) => ({ key, label: streakLabel(key), p: cats[key].p, n: cats[key].n }));
}
