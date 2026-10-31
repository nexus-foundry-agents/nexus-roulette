// -- Shared money parser (MONEYINPUT-SILENT-STRIP) --
// The one reader for every amount typed into the app: the base bet (BaseBetInput.jsx) and every MoneyInput field (ui.jsx).
// Nothing is clamped, rounded or truncated. An amount that cannot be read, is negative, is outside its range, has more than
// MONEY_DECIMALS decimal places, or has cents in a currency with no minor unit is refused with its reason, and the caller
// keeps the amount it already applied. Depends on constants.js (getCurrency, CURRENCIES) only.

const MONEY_DECIMALS = 2;  // the most decimal places a typed amount takes
// The range every MoneyInput caller has today: 0 or more, no upper bound. A caller that needs another range passes its own.
const MONEY_INPUT_RANGE = {min: 0, max: null, noun: "amount"};

// An amount as the messages print it: the currency symbol, decimals only when the amount is not whole, thousands commas.
function moneyText(v, cur) {
  const plain = v % 1 === 0 ? String(v) : v.toFixed(cur.dec);
  return cur.symbol + plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Reads a typed amount against a range {min, max, noun}: min is a number, max a number or null for no upper bound, and noun
// names the amount in the messages ("base", "amount"). Returns {ok:true, value} or {ok:false, reason}.
//   A currency symbol at the start or the end is ignored; the session's own symbol is tried first.
//   Commas are read only as thousands separators (1,000 or 10,000.50), never as a decimal point.
//   Up to MONEY_DECIMALS decimal places. A currency with no minor unit takes whole amounts only.
function parseMoneyAmount(text, currCode, range) {
  const cur = getCurrency(currCode);
  const rng = range || MONEY_INPUT_RANGE;
  const floorText = moneyText(rng.min, cur);
  const topText = rng.max == null ? null : moneyText(rng.max, cur);
  const needText = topText
    ? "Type an amount from " + floorText + " to " + topText + "."
    : "Type an amount of " + floorText + " or more.";
  const fail = reason => ({ok: false, reason});
  let s = String(text == null ? "" : text).trim();
  const symbols = [cur.symbol, ...Object.values(CURRENCIES).map(c => c.symbol)]
    .filter((sym, i, all) => all.indexOf(sym) === i)
    .sort((a, b) => b.length - a.length);
  for(const sym of symbols) {
    if(s.startsWith(sym)) { s = s.slice(sym.length).trim(); break; }
    if(s.endsWith(sym)) { s = s.slice(0, s.length - sym.length).trim(); break; }
  }
  if(s === "") return fail(needText);
  if(/^[-−]/.test(s)) return fail("Negative amounts are not allowed.");
  if(/[^0-9.,]/.test(s)) return fail("Use digits, one decimal point and commas (for thousands) only.");
  if(s.split(".").length > 2) return fail("Only one decimal point is allowed.");
  const m = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?$/.exec(s);
  if(!m) return fail("Commas only separate thousands, as in 1,000.");
  const whole = m[1].replace(/,/g, "");
  const frac = m[2] || "";
  if(whole === "" && frac === "") return fail(needText);
  if(frac.length > MONEY_DECIMALS) return fail("Up to " + MONEY_DECIMALS + " decimal places.");
  if(cur.dec === 0 && /[1-9]/.test(frac)) return fail(cur.name + " has no cents: enter a whole amount.");
  const value = Number((whole || "0") + "." + (frac || "0"));
  if(value < rng.min) return fail("The lowest " + rng.noun + " is " + floorText + ".");
  if(rng.max != null && value > rng.max) return fail("The highest " + rng.noun + " is " + topText + ".");
  return {ok: true, value};
}
