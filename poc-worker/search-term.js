// list of suffixes
const ROTATING_SUFFIXES = ['shirt', 'life', 'day', 'design'];

/**
 * buildSearchTerm(main, sub)
 * - omits main when:
 *    a) sub is non-blank AND main has two or more tokens (e.g., "Ball Games"), OR
 *    b) any token from main appears inside sub (substring match)
 * - rotates suffix by idx
 */
function buildSearchTerm(main, sub, idx = 0) {
  const suffix = ROTATING_SUFFIXES[Math.max(0, Number(idx)) % ROTATING_SUFFIXES.length];
  const parts = [];
  
  const hasSub = String(sub || '').trim() !== '';
  const mainTokens = normalizeTokens(main);
  const skipMainBecauseTwoTokensAndSub = hasSub && mainTokens.length >= 2;
  const skipMainBecauseContained = mainIsContainedInSub(main, sub);

  if (main && !skipMainBecauseTwoTokensAndSub && !skipMainBecauseContained) {
    parts.push(String(main).trim());
  }

  if (sub) parts.push(String(sub).trim());
  parts.push(suffix);

  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

/** helper: normalize string into alnum tokens (lowercase) */
function normalizeTokens(str) {
  return String(str || '')
    .toLowerCase()
    .split(/\s+/)
    .map(s => s.replace(/[^a-z0-9]/g, '')) // remove punctuation
    .filter(Boolean);
}

/** helper: returns true if any token from `main` appears inside `sub` (substring match) */
function mainIsContainedInSub(main, sub) {
  if (!main || !sub) return false;
  const mainTokens = normalizeTokens(main);
  const subLower = String(sub || '').toLowerCase();
  return mainTokens.some(tok => tok && subLower.includes(tok));
}


module.exports = { buildSearchTerm };