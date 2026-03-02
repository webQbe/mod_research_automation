/**
 * Parse strings like "2.5K", "2K", "1,234", "2,5K", "4.2M", "3B", "123" into an integer.
 * Returns Number (integer) or null if not parseable.
 */
function parseAbbreviatedNumber(s) {
  if (s === null || s === undefined) return null;
  s = String(s).trim();

  // remove common trailing plus sign and words like "ratings" etc.
  s = s.replace(/\+/g, '').replace(/(ratings?|reviews?|users?|votes?|people?)/ig, '').trim();

  // capture the numeric part and optional suffix letter
  const m = s.match(/([\d.,]+)\s*([kKmMbBtT]?)/);
  if (!m) return null;

  let numStr = m[1];
  const suffix = (m[2] || '').toLowerCase();

  // If there's a suffix and the numeric part uses comma (e.g. "2,5K") and no dot,
  // treat comma as decimal separator -> convert to dot.
  if (suffix && numStr.includes(',') && !numStr.includes('.')) {
    numStr = numStr.replace(',', '.');
  } else {
    // otherwise treat commas as thousands separators -> remove them
    numStr = numStr.replace(/,/g, '');
  }

  const base = parseFloat(numStr);
  if (Number.isNaN(base)) return null;

  const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
  const multiplier = multipliers[suffix] || 1;

  // Multiply and round to the nearest integer (counts should be integers)
  const value = Math.round(base * multiplier);
  return value;
}

function formatWithCommas(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return n.toLocaleString('en-US');
}

/* Export if using modules */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseAbbreviatedNumber, formatWithCommas };
}