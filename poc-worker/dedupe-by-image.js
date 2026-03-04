const axios = require('axios');
const Jimp = require('jimp');
const pLimit = require('p-limit');

/** Compute aHash using Jimp (returns 64-char '0'/'1' string) */
async function computeAHash(buffer) {
  // Jimp automatically detects image format from buffer
  const image = await Jimp.read(buffer);
  image.resize(8, 8, Jimp.RESIZE_BILINEAR).grayscale();
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idxColor = image.getPixelColor(x, y); // integer
      const rgba = Jimp.intToRGBA(idxColor);
      // use red channel (since grayscale they are equal)
      pixels.push(rgba.r);
    }
  }
  const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;
  return pixels.map(v => (v > avg ? '1' : '0')).join('');
}

/** Hamming distance between equal-length bitstrings */
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** download image to buffer (timeout & fallback) */
async function fetchImageBuffer(url, timeout = 15000) {
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout });
    return Buffer.from(resp.data);
  } catch (err) {
    // Could log err.message
    return null;
  }
}

/**
 * dedupeResults(scrapedArray, options)
 * - scrapedArray: [{ rank, title, link, image, price, reviewCount, capturedAt, ... }, ...]
 * - options:
 *    concurrency: number of parallel downloads/hashes
 *    threshold: hamming distance threshold (<= this => consider duplicate)
 *    keep: 'first' | 'highestReviews' | 'lowestPrice'
 *
 * Returns array of unique results and optionally groups
 */
async function dedupeResults(scrapedArray, options = {}) {
  const concurrency = options.concurrency || 5;
  const threshold = options.threshold || 6; // tuning: 4-8 typical for aHash
  const keep = options.keep || 'first';

  const limit = pLimit(concurrency);
  const imageHashCache = new Map(); // url -> hash (in-memory cache for this run)

  // 1) compute hash for each item (parallel limited)
  const items = scrapedArray.map((item, i) => ({ ...item, __idx: i }));
  await Promise.all(items.map(it => limit(async () => {
    const url = it.image || it.image_url || it.img || '';
    if (!url) { it.__hash = null; return; }
    if (imageHashCache.has(url)) {
      it.__hash = imageHashCache.get(url);
      return;
    }
    const buf = await fetchImageBuffer(url);
    if (!buf) { it.__hash = null; return; }
    try {
      const hash = await computeAHash(buf);
      it.__hash = hash;
      imageHashCache.set(url, hash);
    } catch (err) {
      it.__hash = null;
    }
  })));

  // 2) group by near-identical hash
  const groups = []; // each group = { reprHash, items: [] }
  for (const it of items) {
    const h = it.__hash;
    if (!h) {
      // no image => put into its own group (or dedupe by title if you want)
      groups.push({ reprHash: null, items: [it] });
      continue;
    }
    let placed = false;
    for (const g of groups) {
      if (!g.reprHash) continue;
      const dist = hammingDistance(h, g.reprHash);
      if (dist <= threshold) {
        g.items.push(it);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ reprHash: h, items: [it] });
    }
  }

  // 3) For groups with multiple items, pick one to keep
  const unique = [];
  const groupDetails = [];
  for (const g of groups) {
    if (g.items.length === 1) {
      unique.push(g.items[0]);
      groupDetails.push({ kept: g.items[0], dropped: [] });
      continue;
    }
    // choose by 'keep' policy
    let chosen;
    if (keep === 'highestReviews') {
      chosen = g.items.reduce((a, b) => {
        const na = Number((a.reviewCount || '').toString().replace(/[^0-9]/g, '')) || 0;
        const nb = Number((b.reviewCount || '').toString().replace(/[^0-9]/g, '')) || 0;
        return nb > na ? b : a;
      });
    } else if (keep === 'lowestPrice') {
      chosen = g.items.reduce((a, b) => {
        const pa = Number((a.price || '').toString().replace(/[^0-9.]/g, '')) || Infinity;
        const pb = Number((b.price || '').toString().replace(/[^0-9.]/g, '')) || Infinity;
        return pb < pa ? b : a;
      });
    } else {
      // default: first encountered
      chosen = g.items[0];
    }
    unique.push(chosen);
    groupDetails.push({
      kept: chosen,
      dropped: g.items.filter(x => x !== chosen)
    });
  }

  return { unique, groups: groupDetails };
}

module.exports = { dedupeResults, computeAHash, hammingDistance };