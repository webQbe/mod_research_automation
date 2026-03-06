const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parseAbbreviatedNumber, formatWithCommas } = require('./utils/abbrev-number');
const { screenshotFilePath } = require('./fileHelper');
const logger = require('./logger');
const { dedupeResults } = require('./dedupe-by-image'); // adjust path as needed

const AMAZON_BASE = 'https://www.amazon.com';

function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// call this right after opening the modal to see what Amazon showed
async function inspectModalAndSave(page, tag = '') {
  const stamp = Date.now();
  const png = `debug-modal-${tag || 'auto'}-${stamp}.png`;
  const html = `debug-modal-${tag || 'auto'}-${stamp}.html`;

  // save screenshot
  try { await page.screenshot({ path: png, fullPage: true }); } catch (e) { /* ignore */ }

  // try to find modal containers and print their text content
  const modalSelectors = [
    '.a-popover', 
    '.a-popover-modal',
    '.a-divider',
    '.a-divider-break',
    '.a-spacing-top-base',
    'div[id^="a-popover-2"]', 
    'div[id^="glow-root"]',
  ];
  const results = [];

  for (const sel of modalSelectors) {
    try {
      const loc = page.locator(sel);
      const cnt = await loc.count();
      for (let i = 0; i < cnt; i++) {
        const n = loc.nth(i);
        const visible = await n.isVisible().catch(() => false);
        const text = await n.innerText().catch(() => '');
        results.push({ selector: sel, index: i, visible, text: text.slice(0, 1000) }); // limit size
      }
    } catch (e) { /* ignore */ }
  }

  // save a snapshot of the page HTML for inspection (useful if run in CI)
  try {
    const content = await page.content();
    require('fs').writeFileSync(html, content);
  } catch (e) { /* ignore */ }

  console.log('Saved modal debug files:', png, html);
  console.log('Modal candidates found (selector, index, visible, text-snippet)'/* :\n', results */);
  return { png, html, modalSummaries: results };
}

// returns { frame, locator, selector } or null
async function findZipInputAcrossFrames(page) {
  const selectors = [
    // direct xpaths you mentioned
    'xpath=/html/body/div[18]//input',
    'xpath=/html/body/div[19]//input',
    'xpath=/html/body/div[5]//input',
    // specific candidate xpaths for input
    'xpath=/html/body/div[18]//input[contains(@id,"GLUX") or contains(@name,"zip") or contains(@aria-label,"ZIP")]',
    'xpath=/html/body//input[contains(@name,"zip") or contains(@id,"zip") or contains(@placeholder,"ZIP")]',
    // css selectors
    'input#GLUXZipUpdateInput',
    'input#GLUXZipInput',
    'input[name="zipCode"]',
    'input[aria-label*="ZIP"]',
    'input[placeholder*="ZIP"]'
  ];

  // helper to check locator visibility & attributes heuristics
  async function evaluateLocator(frame, loc) {
    try {
      if (await loc.count() === 0) return null;
      const first = loc.first();
      if (!(await first.isVisible().catch(() => false))) return null;
      // read attributes to confirm
      const attrs = await first.evaluate(el => ({
        id: el.id || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        aria: el.getAttribute('aria-label') || ''
      }));
      const combined = (attrs.id + ' ' + attrs.name + ' ' + attrs.placeholder + ' ' + attrs.aria).toLowerCase();
      if (combined.includes('zip') || combined.includes('postal') || combined.includes('zipcode') || combined.includes('zip code')) {
        return { frame, locator: first, selector: 'matched' };
      }
      // if visible but doesn't contain "zip", still return it as a candidate
      return { frame, locator: first, selector: 'visible-candidate' };
    } catch (e) {
      return null;
    }
  }

  // 1) search main frame
  for (const sel of selectors) {
    try {
      const loc = sel.startsWith('xpath=') ? page.locator(sel.slice(6)) : page.locator(sel);
      const res = await evaluateLocator(page, loc);
      if (res) return res;
    } catch (e) { /* ignore */ }
  }

  // 2) search all child frames
  const frames = page.frames();
  for (const frame of frames) {
    // skip main frame (already checked)
    if (frame === page.mainFrame()) continue;
    for (const sel of selectors) {
      try {
        const loc = sel.startsWith('xpath=') ? frame.locator(sel.slice(6)) : frame.locator(sel);
        const res = await evaluateLocator(frame, loc);
        if (res) return res;
      } catch (e) { /* ignore */ }
    }
  }

  // 3) last resort: find any visible input inside any dialog and return first match
  try {
    const dialogInputs = page.locator('div[role="dialog"] input, .a-popover input, .a-modal input');
    const count = await dialogInputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const ip = dialogInputs.nth(i);
      if (await ip.isVisible().catch(() => false)) {
        return { frame: page, locator: ip, selector: 'dialog-first-visible' };
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}


function extractNumberFromText(s) {
        if (!s) return null;
        // keep digits and commas, remove stuff like "ratings" or "stars"
        const cleaned = s.replace(/[^\d,]/g, '').replace(/,/g, '');
        const n = parseInt(cleaned, 10);
        return Number.isNaN(n) ? null : n;
}

// remove known overlays or disable pointer events on them
async function removeOverlayIfPresent(page) {
  try {
    await page.evaluate(() => {
      const overlays = [
        'redir-overlay', 'glow-ingress-overlay', 'a-popover-1', 'attachOverlay', 'nav-sw-attach'
      ];
      overlays.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.style.pointerEvents = 'none';
          el.style.visibility = 'hidden';
        }
      });
      // also disable common modal-like nodes
      document.querySelectorAll('[role="dialog"], .a-popover, .a-modal').forEach(el => {
        el.style.pointerEvents = 'none';
      });
    });
  } catch (e) { /* ignore */ }
}

async function safeClick(page, locator, opts = {}) {
  try {
    await locator.first().click({ timeout: opts.timeout ?? 10000 });
    return true;
  } catch (e) { /* continue */ }

  await removeOverlayIfPresent(page);

  try {
    await locator.first().click({ force: true, timeout: opts.timeout ?? 8000 });
    return true;
  } catch (e) { /* continue */ }

  // final fallback: element.click() via JS
  try {
    const handle = await locator.first().elementHandle();
    if (handle) {
      await page.evaluate(el => el.click(), handle);
      return true;
    }
  } catch (e) { /* continue */ }

  return false;
}

async function waitForSearchResultsOrTimeout(page, timeoutMs = 30000) {
  const selector = 'div[data-component-type="s-search-result"], .s-main-slot, #search';
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch (e) {
    await page.waitForTimeout(2000);
    return false;
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/** Robust helper: try selectors in order and return text or null */
async function trySelectorsText(parent, selectors) {
  for (const sel of selectors) {
    try {
      const handle = parent.locator(sel);
      if (await handle.count() > 0) {
        const txt = (await handle.first().innerText()).trim();
        if (txt) return txt;
      }
    } catch (e) {
      // ignore and continue
    }
  }
  return null;
}

/** Robust helper: try selectors for attribute (e.g. href, src) */
async function trySelectorsAttr(parent, selectors, attr) {
  for (const sel of selectors) {
    try {
      const handle = parent.locator(sel);
      if (await handle.count() > 0) {
        const val = await handle.first().getAttribute(attr);
        if (val) return val;
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

// Call: await handleTopRegionPopup(page);
// Returns: true if popup handled (clicked/closed), false otherwise
async function handleTopRegionPopup(page) {
  try {
    // quick presence check for the top popup container
    const topPopup = page.locator('xpath=/html/body/div[7]');
    if (!(await topPopup.count())) return false;

    console.log('[popup] Top region popup detected (div[7])');

    // Preferred: click "Go to Amazon.com" button
    const goToXpath = '/html/body/div[7]/div[4]/div[3]/a/span[2]';
    const goToBtn = page.locator(`xpath=${goToXpath}`);
    if (await goToBtn.count() > 0) {
      console.log('[popup] Clicking "Go to Amazon.com" button (xpath)...');
      await removeOverlayIfPresent(page);
      let ok = await safeClick(page, goToBtn, { timeout: 8000 });
      if (!ok) {
        // fallback: direct DOM click
        try {
          const h = await goToBtn.first().elementHandle();
          if (h) await page.evaluate(el => el.click(), h);
          ok = true;
        } catch (e) { /* ignore */ }
      }
      if (ok) {
        await page.waitForTimeout(1200);
        console.log('[popup] Clicked Go-to button');
        return true;
      }
    }

    // Secondary: click close button on popup
    const closeXpath = '/html/body/div[7]/div[1]/span[2]/a/span';
    const closeBtn = page.locator(`xpath=${closeXpath}`);
    if (await closeBtn.count() > 0) {
      console.log('[popup] Clicking popup close button (xpath)...');
      await removeOverlayIfPresent(page);
      let ok2 = await safeClick(page, closeBtn, { timeout: 8000 });
      if (!ok2) {
        try {
          const h2 = await closeBtn.first().elementHandle();
          if (h2) await page.evaluate(el => el.click(), h2);
          ok2 = true;
        } catch (e) { /* ignore */ }
      }
      if (ok2) {
        await page.waitForTimeout(700);
        console.log('[popup] Popup closed via close button');
        return true;
      }
    }

    // If neither button works, try to hide the popup so it doesn't intercept clicks
    try {
      console.log('[popup] Disabling pointer events on top popup as last resort');
      await page.evaluate(() => {
        const el = document.querySelector('body > div:nth-child(7)');
        if (el) {
          el.style.pointerEvents = 'none';
          el.style.visibility = 'hidden';
        }
      });
      await page.waitForTimeout(400);
      return true;
    } catch (e) {
      // continue to debug capture
    }

    // If we reach here, record debug artifacts and return false
    const stamp = Date.now();
    try {
      const png = `debug-top-popup-${stamp}.png`;
      const html = `debug-top-popup-${stamp}.html`;
      await page.screenshot({ path: png, fullPage: true }).catch(()=>{});
      const content = await page.content().catch(()=>'<no-html>');
      require('fs').writeFileSync(html, content);
      console.warn('[popup] Wrote debug files:', png, html);
    } catch (err) {
      console.warn('[popup] Could not write debug artifacts:', err.message);
    }
    console.warn('[popup] Top popup present but not handled automatically.');
    return false;
  } catch (err) {
    console.warn('[popup] handleTopRegionPopup error:', err.message || err);
    return false;
  }
}

// Enhanced modal close helper: call after modal appears
async function closeModalWithContinueEnhanced(page, opts = {}) {
  const timeout = opts.timeout ?? 15000;
  const poll = opts.pollInterval ?? 300;
  const start = Date.now();

  // Candidate Continue selectors
  const continueSelectors = [
    '#a-autoid-3',
    'input#GLUXConfirmClose',
    '#GLUXConfirmClose',
    'span.a-button-text:has-text("Continue")',
    'button:has-text("Continue")',
    'xpath=/html/body/div[6]//input[@id="GLUXConfirmClose"]',
    'xpath=/html/body/div[7]//input[@id="GLUXConfirmClose"]',
    'xpath=//input[@id="GLUXConfirmClose"]',
    'xpath=//span[contains(.,"Continue")]/input'
  ];

  // 1) Capture currently visible modal-like element handles so we can watch them
  const modalLocator = page.locator('div[role="dialog"], .a-popover, div[id^="a-popover"], .a-modal');
  const initialHandles = [];
  try {
    const modalCount = await modalLocator.count();
    for (let i = 0; i < modalCount; i++) {
      const loc = modalLocator.nth(i);
      if (await loc.isVisible().catch(() => false)) {
        const handle = await loc.elementHandle();
        if (handle) initialHandles.push(handle);
      }
    }
  } catch (e) {
    // ignore capture errors
  }

  // Helper: check if all captured handles are gone/hidden
  async function capturedModalsGoneOrHidden() {
    try {
      if (initialHandles.length === 0) {
        // no explicit handles captured — fall back to generic no visible dialog
        const anyVisible = await page.locator('div[role="dialog"], .a-popover, div[id^="a-popover"], .a-modal').filter({ hasText: '' }).count().catch(() => 0);
        return anyVisible === 0;
      }
      // Evaluate each handle in page context to see if connected & visible
      for (const h of initialHandles) {
        try {
          // if handle is detached, treat as gone
          const isConnected = await page.evaluate(el => !!el && !!el.isConnected, h).catch(() => false);
          if (!isConnected) continue;
          // check visibility via offsetParent or computed style
          const isVisible = await page.evaluate((el) => {
            try {
              const cs = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return cs && cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            } catch (e) { return false; }
          }, h).catch(() => false);
          if (isVisible) return false; // at least one captured modal still visible
        } catch (e) {
          // if any per-handle check fails, be conservative and assume it's still present
          return false;
        }
      }
      return true; // all captured handles gone or not visible
    } catch (e) {
      return false;
    }
  }

  // 2) Try candidate continue selectors
  for (const sel of continueSelectors) {
    if (Date.now() - start > timeout) break;
    try {
      const loc = sel.startsWith('xpath=') ? page.locator(sel.slice(6)) : page.locator(sel);
      if (await loc.count() === 0) continue;
      const first = loc.first();
      // try clicking via safeClick helper
      const clicked = await safeClick(page, first, { timeout: 8000 }).catch(() => false);
      if (!clicked) {
        // fallback: focus+enter
        try { await first.focus(); await page.keyboard.press('Enter'); } catch (e) {}
      }
      // After attempting click, wait for captured modals to disappear
      const remainingTime = Math.max(1000, timeout - (Date.now() - start));
      const endWait = Date.now() + remainingTime;
      while (Date.now() < endWait) {
        if (await capturedModalsGoneOrHidden()) {
          return true; // closed successfully
        }
        await page.waitForTimeout(poll);
      }
      // Not closed after this selector — try the next
    } catch (e) {
      // continue to next selector
    }
  }

  // 3) Try escape + outside click fallback
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(10, 10).catch(() => {});
    // wait short time
    const endWait = Date.now() + 3000;
    while (Date.now() < endWait) {
      if (await capturedModalsGoneOrHidden()) return true;
      await page.waitForTimeout(poll);
    }
  } catch (e) { /* ignore */ }

  // 4) If still present, forcibly hide/remove the captured modal elements and known overlays (last-resort)
  try {
    await page.evaluate(() => {
      // remove/hide common overlays
      const overlayIds = ['redir-overlay', 'glow-ingress-overlay'];
      overlayIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.pointerEvents = 'none'; el.style.display = 'none'; }
      });
      // hide any visible dialogs/popovers
      document.querySelectorAll('div[role="dialog"], .a-popover, .a-modal, div[id^="a-popover"]').forEach(el => {
        try { el.style.pointerEvents = 'none'; el.style.display = 'none'; } catch(e) {}
      });
    });
    // short wait for DOM to settle
    await page.waitForTimeout(500);
    if (await capturedModalsGoneOrHidden()) return true;
  } catch (e) { /* ignore */ }

  // 5) Give up — capture debug artifacts and return false
  try {
    const stamp = Date.now();
    await page.screenshot({ path: `debug-modal-still-open-${stamp}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`debug-modal-still-open-${stamp}.html`, await page.content().catch(() => '<no html>'));
    console.warn('Modal did not close — debug files saved:', `debug-modal-still-open-${stamp}.png`, `debug-modal-still-open-${stamp}.html`);
  } catch (e) { /* ignore */ }

  return false;
}

// check #glow-ingress-line2 contains a zip code
async function getGlowIngressText(page, timeout = 3000) {
  const css = '#glow-ingress-line2';
  const xpath = '/html/body/div[1]/header/div/div[1]/div[1]/div[2]/span/a/div[2]/span[2]';
  try {
    // Prefer CSS, fallback to xpath
    try {
      await page.waitForSelector(css, { timeout });
      let txt = await page.locator(css).innerText();
      if (typeof txt === 'string') {
        // remove invisible/zero-width and normalize whitespace
        txt = txt.replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
        return txt;
      }
    } catch (e) {
      // CSS not found in time — try xpath
      const loc = page.locator(`xpath=${xpath}`);
      if (await loc.count() > 0) {
        let txt = await loc.first().innerText();
        txt = txt.replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
        return txt;
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}


async function glowHasZip(page, expectedZip = null, timeout = 3000) {
  /**
   * Waits for the glow ingress element and checks for a 5-digit ZIP code.
   * - expectedZip (string) optional: if provided, the function returns true only if the found zip equals expectedZip.
   * - timeout in ms to wait for the element (default 3000)
   */
  try {
      const txt = await getGlowIngressText(page, timeout);
      if (!txt) return false;
      // Extract first 5-digit zip (allow optional +4 part)
      const match = txt.match(/\b(\d{5})(?:-\d{4})?\b/);
      if (!match) return false;
      const zip = match[1];
      if (expectedZip) return zip === String(expectedZip);
      return true;
  } catch (e) {
    return false;
  }
}


async function zipVerify(page){
  // ==================== ZIP VERIFICATION LOOP ====================
  const MAX_ZIP_RETRIES = 5;
  let zipConfirmed = false;

  for (let zipAttempt = 0; zipAttempt < MAX_ZIP_RETRIES; zipAttempt++) {
    console.log(`ZIP verification attempt ${zipAttempt + 1}/${MAX_ZIP_RETRIES}...`);
    
    await page.waitForTimeout(1000);
    
    const glowText = await getGlowIngressText(page, 3000);
    console.log(`Glow ingress text: "${glowText}"`);
    
    const hasZip10022 = await glowHasZip(page, '10022', 3000);
    
    if (hasZip10022) {
      console.log(`✅ ZIP 10022 confirmed in header — safe to scrape.`);
      zipConfirmed = true;
      break; // Success! Exit loop
    } else {
      console.warn(`⚠️ ZIP 10022 not in header (attempt ${zipAttempt + 1}/${MAX_ZIP_RETRIES})`);
      
      // Not the last attempt? Try again
      if (zipAttempt < MAX_ZIP_RETRIES - 1) {
        console.log(`Retrying ZIP submission...`);
        
        // Re-open modal by clicking deliver-to
        const deliverToXpath = '/html/body/div[1]/header/div/div[1]/div[1]/div[2]/span/a/div[2]/span[2]';
        const deliver = page.locator(`xpath=${deliverToXpath}`);
        
        if (await deliver.count() > 0) {
          await removeOverlayIfPresent(page);
          await safeClick(page, deliver, { timeout: 5000 });
          await page.waitForTimeout(1000);
          
          // Find and fill ZIP
          const zipResult = await findZipInputAcrossFrames(page);
          
          if (zipResult && zipResult.locator) {
            console.log(`Found ZIP input on retry, filling...`);
            await zipResult.locator.fill('10022');
            await zipResult.locator.press('Enter');
            await page.waitForTimeout(600);
            
            // Close modal
            const closed = await closeModalWithContinueEnhanced(page, { timeout: 15000 });
            if (closed) {
              console.log(`Modal closed on retry`);
              await page.waitForTimeout(500);
            }
          }
        }
      }
    }
  }

  if (!zipConfirmed) {
    console.warn(`⚠️ Failed to confirm ZIP after ${MAX_ZIP_RETRIES} attempts.`);
    console.warn(`Proceeding with scraping anyway (results may not be accurate)...`);
    // Optional: return [] to abort if ZIP not set
  }
  // ==================== END ZIP VERIFICATION LOOP ====================
}

/**
 * safeGoto(page, url, opts)
 * - retries navigation up to maxAttempts
 * - first tries waitUntil 'domcontentloaded', then 'load'
 * - logs response status if available
 * - on final failure saves screenshot and page HTML for debugging
 */
async function safeGoto(page, url, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const baseTimeout = opts.baseTimeout || 30000; // 30s default
  const screenshotDir = opts.screenshotDir || path.join(process.cwd(), 'debug-screens');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeout = Math.min(120000, baseTimeout * Math.pow(1.8, attempt-1)); // increasing timeout
    try {
      // try lightweight 'domcontentloaded' first (faster, often enough)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (response) {
        const status = response.status();
        console.log(`safeGoto attempt ${attempt} -> response status: ${status}`);
      } else {
        console.log(`safeGoto attempt ${attempt} -> no response object`);
      }

      // optionally wait for main content selector (reduce false positives)
      try {
        await page.waitForSelector('div.s-main-slot, #search, main', { timeout: 5000 });
      } catch (err) {
        // not fatal — continue; we'll decide by response or content
      }

      // if we got here, treat as success
      return response || null;
    } catch (err) {
      console.warn(`safeGoto attempt ${attempt} failed (timeout or navigation error): ${err.message}`);
      // small random backoff before next try
      await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random()*1200)));
      // final attempt fallback: try with waitUntil 'load'
      if (attempt === maxAttempts) {
        try {
          console.log('Final attempt: trying waitUntil "load" with longer timeout...');
          const response2 = await page.goto(url, { waitUntil: 'load', timeout: Math.min(120000, baseTimeout * 2) });
          return response2 || null;
        } catch (err2) {
          // capture artifacts for debugging
          const safeName = `failed-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
          const pngPath = path.join(screenshotDir, `${safeName}.png`);
          const htmlPath = path.join(screenshotDir, `${safeName}.html`);
          try {
            await page.screenshot({ path: pngPath, fullPage: true });
            const html = await page.content();
            fs.writeFileSync(htmlPath, html);
            console.error(`Navigation finally failed. Saved screenshot: ${pngPath} and HTML: ${htmlPath}`);
          } catch (saveErr) {
            console.error('Failed to save debug artifacts:', saveErr);
          }
          throw err2; // rethrow so upstream can handle/log
        }
      }
    }
  }
  return null;
}

// robust wait helper for Amazon location modal
async function waitForAmazonLocationModal(page, { initialTimeout = 8000, retryTimeout = 9000, maxIndex = 22 } = {}) {
  const logger = console; // replace with your logger if you have one

  // 1) Try the index-based xpath scanning (common on Amazon: modal gets high index)
  async function scanIndexRange(timeoutPerCandidate = 1000) {
    for (let i = 5; i <= Math.min(maxIndex, 40); i++) {
      const xpath = `/html/body/div[${i}]/div`;
      const loc = page.locator(`xpath=${xpath}`);
      try {
        if (await loc.count() > 0) {
          // wait slightly for visibility
          await loc.waitFor({ state: 'visible', timeout: timeoutPerCandidate });
          logger.info(`Found modal at xpath ${xpath}`);
          return loc;
        }
      } catch (err) {
        // ignore and continue scanning
      }
    }
    return null;
  }

  // 2) Try role-based and semantic selectors (preferred when available)
  async function trySemanticSelectors(tout = 2000) {
    // role=dialog (Playwright supports getByRole)
    try {
      const dlg = page.getByRole ? page.getByRole('dialog').first() : page.locator(`xpath=//div[@role="dialog"]`).first();
      if (dlg && await dlg.count() > 0) {
        await dlg.waitFor({ state: 'visible', timeout: tout });
        logger.info('Found modal via role=dialog');
        return dlg;
      }
    } catch (err) {}

    // fallback: look for a top-level div that contains likely modal text (deliver, address, zip)
    try {
      const textCandidates = ['Delivery options', 'Choose a delivery', 'Select a delivery address', 'Choose your location', 'Select a shipping address'];
      for (const t of textCandidates) {
        const loc = page.locator(`xpath=//div[contains(normalize-space(.), "${t}")]`).first();
        if (loc && await loc.count() > 0) {
          await loc.waitFor({ state: 'visible', timeout: tout });
          logger.info(`Found modal via contains text "${t}"`);
          return loc;
        }
      }
    } catch (err) {}
    return null;
  }

  // 3) Try scanning all top-level body divs and pick the first visible one that looks like a modal (heuristic)
  async function heuristicTopLevelScan(timeoutPerCandidate = 500) {
    try {
      const nodes = await page.$$('xpath=/html/body/div');
      for (let idx = 0; idx < Math.min(nodes.length, maxIndex); idx++) {
        const i = idx + 1;
        const loc = page.locator(`xpath=/html/body/div[${i}]`);
        try {
          await loc.waitFor({ state: 'visible', timeout: timeoutPerCandidate });
          // heuristics: modal often has a child with role, button, or large content
          const text = (await loc.textContent() || '').slice(0, 300);
          if (text && (text.match(/shipping|address|zipcode|postal/i) || (await loc.locator('button').count() > 0))) {
            logger.info(`Heuristic found visible top-level div at index ${i}`);
            return loc;
          }
        } catch (err) { /* not visible or timed out  */ }
      }
    } catch (err) {}
    return null;
  }

  // MAIN FLOW: try quick attempts then retry after clicking Deliver-to & handling overlays
  // 1st pass (fast)
  let modal = null;
  try {
    modal = await Promise.race([
      scanIndexRange(800),
      trySemanticSelectors(1200),
      heuristicTopLevelScan(400)
    ]);
    if (modal) return modal;
  } catch (err) {
    // continue to retry logic below
  }

  // If we reach here, nothing found quickly -> retry: click Deliver-to, remove overlays, try again
  logger.info('Location modal not detected quickly — retrying Deliver-to click and waiting');

  try {
    // re-run your top-region popup handler if present
    if (typeof handleTopRegionPopup === 'function') {
      await handleTopRegionPopup(page).catch(() => {});
    }

    // try clicking Deliver-to element if present
    const deliverToXpath = '/html/body/div[1]/header/div/div[1]/div[1]/div[2]/span/a/div[2]/span[2]';
    const deliver = page.locator(`xpath=${deliverToXpath}`);
    if (await deliver.count() > 0) {
      if (typeof removeOverlayIfPresent === 'function') await removeOverlayIfPresent(page).catch(()=>{});
      await safeClick(page, deliver, { timeout: 5000 }).catch(()=>{});
      // give the page a bit to create the modal
      await page.waitForTimeout(350);
    }
  } catch (err) {
    logger.warn('Error during retry Deliver-to click:', err.message || err);
  }

  // emit debug artifacts before the retry search (keeps your existing debug ops)
  try {
    const stamp = Date.now();
    const png = `debug-modalLocator-${stamp}.png`;
    const html = `debug-modalLocator-${stamp}.html`;
    await page.screenshot({ path: png, fullPage: true }).catch(()=>{});
    const content = await page.content().catch(()=>'<no-html>');
    require('fs').writeFileSync(html, content);
    logger.warn('[modalLocator] Wrote debug files:', png, html);
  } catch (err) {
    logger.warn('[modalLocator] Could not write debug artifacts:', err.message);
  }

  // 2nd pass (longer)
  try {
    modal = await Promise.race([
      scanIndexRange(1200),
      trySemanticSelectors(2000),
      heuristicTopLevelScan(800)
    ]);
    if (modal) return modal;
  } catch (err) {}

  // ultimate fallback: try Playwright API directly searching for dialog role
  try {
    const dlg = page.locator(`xpath=//div[@role="dialog"]`).first();
    if (dlg && await dlg.count() > 0) {
      await dlg.waitFor({ state: 'visible', timeout: retryTimeout }).catch(()=>{});
      logger.info('Fallback found dialog via xpath //div[@role="dialog"]');
      return dlg;
    }
  } catch (err) {}

  // nothing found — return null so caller can continue gracefully
  logger.info('No location modal detected after retries');
  return null;
}


async function runPlaywrightFor(searchTerm,  opts = {}) {
  const externallyProvidedPage = !!opts.page;
  let browser = opts.browser;
  let context = opts.context;
  let page = opts.page;


  if (!externallyProvidedPage) {
    // create isolated browser/context/page if not provided
    if (!browser) {
      browser = await chromium.launch({ headless: true });
      // note: if you create a browser here you should close it in finally; prefer providing sharedBrowser from caller
    }
    context = await browser.newContext();

    page = await context.newPage({
        // Before navigation set user agent on the page
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    });
  }

  const taskId = opts.taskId ?? 'local';
  logger.log(`[${taskId}] runPlaywrightFor start:`, searchTerm);

  const maxResults = Number(opts.maxResults || 52);
  const targetUniqueCount = maxResults /* Number(opts.targetUniqueCount || 9) */;

  if (!page) {
    throw new Error('runPlaywrightFor requires opts.page (a Playwright Page).');
  }

  try {
    // strictly use the local `page` variable only
    const searchUrl = `${AMAZON_BASE}/s?k=${encodeURIComponent(searchTerm)}&i=fashion-novelty&rh=n%3A7147445011%2Cp_6%3AATVPDKIKX0DER&s=review-rank&dc&crid=1WROLBEY3M3HE&qid=1772027461&refresh=1&rnid=2661622011&sprefix=${encodeURIComponent(searchTerm)}%2Cfashion-novelty%2C549&ref=sr_st_review-rank&ds=v1%3ATdzw0sGIfMiGvl4yIBBpl%2ByOmAlhDgvxsucMqLHEv0w`;

    console.log(`[${taskId}] runPlaywrightFor start: "${searchTerm}" maxResults=${maxResults} targetUnique=${targetUniqueCount}`);

    // Before navigation set headers on the page
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9'
    });
    page.setDefaultNavigationTimeout(60000); // 60s
    page.setDefaultTimeout(45000);

    logger.log(`[${taskId}] Navigating to searchUrl` /* :', searchUrl */);
    
    // safe goto (uses retries + artifact capture on failure)
    const navResp = await safeGoto(page, searchUrl, { maxAttempts: 3, baseTimeout: 30000 });
    if (!navResp) {
      console.warn(`[${taskId}] page.goto returned no response; returning empty results`);
      return [];
    }
    
    // Check HTTP status if response available
    const resStatus = navResp.status ? navResp.status() : null;
    if (resStatus && resStatus >= 400) {
      logger.log(`[${taskId}] navigation returned status ${resStatus} for ${searchUrl}`);
      // decide whether to continue or return empty
      return [];
    }

    logger.info('Attempting to Enter US Zip');

    // Wait for the location modal to appear (use the modal xpath that Amazon uses)
    const modalLocator = await waitForAmazonLocationModal(page, { initialTimeout: 8000, retryTimeout: 9000 });

    if (modalLocator) {
      // proceed with modal interactions
      await modalLocator.click().catch(()=>{});
      // or use modalLocator.locator(...) to find buttons/inputs inside
    } else {
      // modal not present — continue gracefully
      logger.info('Proceeding without location modal (not present)');
    }

    // Now modalLocator should represent the modal; take a scoped screenshot for debugging
    let zipHandled = false;
    try {
        // after opening the modal and waiting a bit:
        await page.waitForTimeout(800);
        const debug = await inspectModalAndSave(page, 'after-open'); // optional: helpful
        const zipResult = await findZipInputAcrossFrames(page);

        if (!zipResult) {
          // --- handle "Change Address" button and retry ZIP detection ---
          try {
            // Try to click the "Change Address" button inside the modal
            const changeAddressBtn = page.locator('.a-spacing-top-base:has-text("Change Address")');

            if (await changeAddressBtn.count() > 0) {
              logger.info('Found "Change Address" button; attempting to click it...');
              const clicked = await safeClick(page, changeAddressBtn, { timeout: 10000 });
              if (!clicked) {
                logger.info('safeClick failed on Change Address; trying force-click and DOM click fallback...');
                try { await changeAddressBtn.first().click({ force: true, timeout: 5000 }); } catch (e) {}
                try { await page.evaluate(() => {
                  const el = Array.from(document.querySelectorAll('.a-spacing-top-base')).find(n => n && n.textContent && n.textContent.includes('Change Address'));
                  if (el) el.click();
                }); } catch (e) {}
              }

              // Give the modal a moment to change to the address form
              await page.waitForTimeout(900);

              // Optional: save a debug snapshot to inspect what changed
              await inspectModalAndSave(page, 'after-click-change-address');

              // Short wait for any dynamic content
              await page.waitForTimeout(700);

              // Retry finding the ZIP input (search frames too)
              const zipResult2 = await findZipInputAcrossFrames(page);

              if (zipResult2 && zipResult2.locator) {
                logger.info('ZIP input found after clicking Change Address — filling and submitting...');
                const { locator } = zipResult2;
                try {
                  await locator.fill('10022');
                } catch (e) { logger.info('Failed to fill ZIP:', e.message); }

                // Prefer pressing Enter on the input
                try {
                  await locator.press('Enter', { timeout: 8000 });
                } catch (e) {
                  try {
                    await locator.focus();
                    await page.keyboard.press('Enter');
                  } catch (e2) {
                    logger.info('Enter press fallbacks failed; will attempt Apply click fallback.');
                  }
                }

                // after opening modal and short wait:
                await page.waitForTimeout(600);
                const ok = await closeModalWithContinueEnhanced(page, { timeout: 15000 });
                if (!ok) {
                  logger.info('Could not close modal via Continue — skipping ZIP and proceeding to scrape (or abort).');
                } else {
                  logger.info('Modal closed successfully after ZIP submission');
                  zipHandled = true;
                  await page.waitForTimeout(300);
                }

                // Wait briefly for search results to appear
                await waitForSearchResultsOrTimeout(page, 8000);
                logger.info('ZIP submit attempted; continue with scraping.');
                // Verify zip is set, after modal closed and before scraping
                await zipVerify(page);
              } else {
                logger.info('Still no ZIP input after clicking Change Address. Skipping ZIP step (modal may require sign-in).');
              }
            } else {
              logger.info('"Change Address" button not found in modal; skipping that step.');
            }
          } catch (err) {
            const stamp = Date.now();
            try { await page.screenshot({ path: `debug-change-address-fail-${stamp}.png`, fullPage: true }); } catch(e){}
            try { fs.writeFileSync(`debug-change-address-fail-${stamp}.html`, await page.content()); } catch(e){}
            console.warn('Error handling Change Address (saved debug). Error:', err.message);
          }

          if (!zipHandled) {
            logger.info('No ZIP input found (modal may require sign-in or be different). Skipping ZIP step.');
          }
        } else {
          logger.info('Found ZIP input in frame, selector:', zipResult.selector);
          const { frame, locator } = zipResult;
          
          try {
            await locator.fill('10022');
            logger.info('Filled Zip 10022');
            await locator.press('Enter');
            logger.info('Pressed Enter to Apply');

            await page.waitForTimeout(600);
            const ok = await closeModalWithContinueEnhanced(page, { timeout: 15000 });
            if (!ok) {
              logger.info('Could not close modal via Continue — skipping ZIP and proceeding to scrape.');
            } else {
              logger.info('Modal closed successfully after ZIP submission');
              zipHandled = true;
              await page.waitForTimeout(300);
            }
          } catch (e) {
            logger.info('ZIP submission failed:', e.message);
          }
        }
    } catch(e){ 
      logger.info('Modal handling error:', e.message);
    }

    // Verify zip is set, after modal closed and before scraping
    await zipVerify(page);
   

    // Final: wait for actual search results to appear (no strict networkidle)
    await waitForSearchResultsOrTimeout(page, 30000);
    await page.waitForTimeout(800);

   
    // Wait a little for results to reload after sorting/ZIP change
    await sleep(1200);


    // ---------- Scrape top N organic search results ----------
    const resultsLocator = page.locator('div[data-component-type="s-search-result"]');
    const count = await resultsLocator.count();
    const available = Math.min(count, maxResults);
    logger.info(`Found ${count} results on page; scraping top ${available}`);

    // Take a page screenshot of loaded results for debugging
    try {
      const scPath = screenshotFilePath({ dir: 'screenshots', prefix: 'results', term: searchTerm });
      await page.screenshot({ path: scPath }).catch(()=>{});
      console.log('Results screenshot:', scPath);
      const html = `results-${searchTerm}.html`;
      const content = await page.content().catch(()=>'<no-html>');
      require('fs').writeFileSync(html, content);
      console.warn('Wrote debug results html:', html);
      } catch (e) { 
        console.warn('Could not write debug artifacts:', e.message); 
      }

    // Extract up to `maxResults` items from the first page using Playwright locators (NOT $$eval with async code)
    const scrapedResults = [];
    const resultItems = page.locator('div.s-main-slot > div.s-result-item');
    const itemCount = await resultItems.count();

    for (let i = 0; i < itemCount && scrapedResults.length < maxResults; i++) {
      const r = resultItems.nth(i);

      // Check for ASIN
      const asin = await r.getAttribute('data-asin').catch(() => null);
      if (!asin) continue;

      // Title
      const title = await trySelectorsText(r, [
        'h2 a span',
        'h2 span',
      ]);

      // Link (usually relative)
      let link = await trySelectorsAttr(r, ['h2 a', 'a.a-link-normal.s-no-outline'], 'href');
      if (link && link.startsWith('/')) link = AMAZON_BASE + link;
      if (link && !link.startsWith('http')) link = AMAZON_BASE + '/' + link;

      // Image
      let image = await trySelectorsAttr(r, ['img.s-image', 'img'], 'src');
      if (!image) image = await trySelectorsAttr(r, ['img.s-image', 'img'], 'data-src');

      // Prefer specific, relative selectors inside the result element `r`
      const rawReviewCount = await trySelectorsText(r, [
        // common pattern: link to customer reviews then its inner span
        'a[href*="#customerReviews"] span',
        // link with small size class
        'a.a-link-normal .a-size-small, a.a-link-normal .a-size-base',
        // wrapper class used in some Amazon variants
        'span.s-csa-instrumentation-wrapper > a > span',
        // general fallback: small base-size spans inside the result row
        'div.a-row span.a-size-base',
        // relative XPath fallback (search for an a tag that contains "customerReviews")
        'xpath=.//a[contains(@href,"customerReviews")]//span | xpath=.//div[contains(@class,"a-section")]/div[3]//a//span'
      ]);

      // Try the abbreviated parser first (returns integer or null)
      const parsedAbbrev = parseAbbreviatedNumber(rawReviewCount); // returns integer or null

      let reviewCountValue = null;      // numeric value (e.g. 2500)
      let reviewCountFormatted = null;  // human string (e.g. "2,500")

      if (parsedAbbrev !== null && parsedAbbrev !== undefined) {
        reviewCountValue = parsedAbbrev;
        reviewCountFormatted = formatWithCommas(parsedAbbrev);
      } else {
        // fallback: try to extract a plain integer from the raw text
        const fallback = extractNumberFromText(rawReviewCount);
        if (fallback !== null) {
          reviewCountValue = fallback;
          reviewCountFormatted = formatWithCommas(fallback);
        } else {
          reviewCountValue = null;
          reviewCountFormatted = null;
        }
      }

       // ✅ DEBUG: Log what we extracted
      if (scrapedResults.length < 3) {
        console.log(`[${taskId}] Item ${i}: rawReviewCount="${rawReviewCount}" → parsed=${reviewCountValue}`);
      }
              
      // Price
      const price = await trySelectorsText(r, [
        'span.a-price > span.a-offscreen',
        'span.a-price-whole',
        'span.a-color-price',
      ]);

      scrapedResults.push({
          asin: asin || '',
          title,
          link,
          image,
          price,
          reviewCount: reviewCountValue,  // ✅ Use numeric value with correct name
          reviewCountFormatted,
          rank: scrapedResults.length + 1,
          capturedAt: new Date().toISOString()
      });
    }

   console.log(`[${taskId}] scraped ${scrapedResults.length} items from first page`);

    // ✅ DEBUG: Show first 3 items with their review counts
    if (scrapedResults.length > 0) {
      console.log(`[${taskId}] Sample of scraped items:`);
      scrapedResults.slice(0, 3).forEach((item, idx) => {
        console.log(`[${idx}] ASIN=${item.asin} reviews=${item.reviewCount}(${item.reviewCountFormatted})`);
      });
    }

   // -------------------
    // Post-processing per your requested steps:
    // 1) scrape up to maxResults (done)
    // 2) filter out reviewCount < 5
    // 3) for same reviewCount keep only the top-most (first seen)
    // 4) sort unique results (up to maxResults) by reviewCount desc
    // -------------------

    // Step 2: filter out low review counts and items without numeric review count
    const minReviews = 5;
    const filtered = scrapedResults.filter(it => {
      return it.reviewCount !== null && Number.isFinite(it.reviewCount) && it.reviewCount >= minReviews;
    });

    logger.info(`[${taskId}] after review-count filter (>=${minReviews}): ${filtered.length} items`);

    // Step 3: keep only the top-most item per reviewCount value (first seen wins)
    const seenReviewCounts = new Map();
    const topMostPerReview = [];
    for (const item of filtered) {
      const rc = item.reviewCount;
      if (!seenReviewCounts.has(rc)) {
        seenReviewCounts.set(rc, true);
        topMostPerReview.push(item);
      }
    }

    logger.info(`[${taskId}] after collapsing same review-count values: ${topMostPerReview.length} items`);

    // Step 4: sort by reviewCount descending and cap to maxResults
    topMostPerReview.sort((a, b) => {
      // fallback to 0 if missing (shouldn't be), keep stable ordering otherwise
      return (b.reviewCount || 0) - (a.reviewCount || 0);
    });


  // Dedupe by image similarity
  const { unique } = await dedupeResults(topMostPerReview, { concurrency: 6, threshold: 3, keep: 'first' });
  console.log(`[${taskId}] after deduplication: total scraped=${topMostPerReview.length}, uniqueImages=${unique.length}`);

  const uniqueSorted = unique.slice(0, maxResults);
    logger.info(`[${taskId}] final uniqueSorted length (capped to maxResults=${maxResults}): ${uniqueSorted.length}`);


  // Return up to targetUniqueCount results (sorted by review count desc)
  const finalResults = uniqueSorted.slice(0, targetUniqueCount);
  console.log(`[${taskId}] returning ${finalResults.length} unique results (target was ${targetUniqueCount})`);
  return finalResults;

  } catch (err) {
    console.error(`[${taskId}] runPlaywrightFor fatal error:`, err && err.stack ? err.stack : err);
    return [];
  }
  finally {
    // close only what we created
    if (!externallyProvidedPage) {
      try { await context.close(); } catch (e) {}
      if (!opts.browser) {
        try { await browser.close(); } catch (e) {}
      }
    }
  }
}

// If run directly, test with the given sample search term:
if (require.main === module) {
  (async () => {
    const term = process.argv.slice(2).join(' ') || 'costume fitness trainer';
    try {
      const results = await runPlaywrightFor(term);
      logger.log('Done. Got', results.length, 'items.');
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}

// amazon-scrape.js (export)
module.exports = { runPlaywrightFor };