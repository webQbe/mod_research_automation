const STYLE = ['vintage', 'retro', 'funny', 'cute'];
const INTENT = ['gift', 'shirt', 'tshirt', 'graphic tee'];

function buildSearchTerm(main, sub, idx = 0) {
  /**
   * buildSearchTerm(main, sub, idx)
   * - picks a rotating style from STYLE based on idx
   * - picks a rotating intent from INTENT based on idx
   * - returns string like: "Fitness Running vintage gift" or "Fitness Animal retro tshirt"
  */
  const safeIdx = Math.max(0, Number(idx));
  const style = STYLE[safeIdx % STYLE.length];
  const intent = INTENT[safeIdx % INTENT.length];
  
  const parts = [];
  if (main) parts.push(String(main).trim());
  if (sub) parts.push(String(sub).trim());
  parts.push(style);
  parts.push(intent);
  
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

module.exports = { buildSearchTerm };