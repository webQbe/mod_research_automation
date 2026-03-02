const { chromium } = require('playwright');
const fs = require('fs');
const { parseAbbreviatedNumber, formatWithCommas } = require('./utils/abbrev-number');


const HEADLESS = process.env.HEADLESS !== '0'; // set HEADLESS=0 to see the browser
const ZIP = '90001';
const MAX_RESULTS = 5;
const AMAZON_BASE = 'https://www.amazon.com';

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
];

function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function extractNumberFromText(s) {
        if (!s) return null;
        // keep digits and commas, remove stuff like "ratings" or "stars"
        const cleaned = s.replace(/[^\d,]/g, '').replace(/,/g, '');
        const n = parseInt(cleaned, 10);
        return Number.isNaN(n) ? null : n;
}


async function safeGotoWith503Handling(page, url, opts = {}) {
  const maxAttempts = opts.retries ?? 5;
  const navTimeout = opts.navTimeout ?? 60000;
  const waitSelector = opts.waitSelector ?? 'div[data-component-type="s-search-result"], .s-main-slot, #search';
  const baseBackoffMs = opts.baseBackoffMs ?? 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`safeGoto attempt ${attempt} -> ${url}`);

      // rotate UA and headers per attempt (helps avoid basic blocking heuristics)
      const ua = randChoice(DEFAULT_USER_AGENTS);
      try {
        await page.context().setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9', 'user-agent': ua });
      } catch (e) { /* ignore */ }
      try { page.context().setDefaultNavigationTimeout(navTimeout); } catch (e) { /* ignore */ }

      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });

      let status = null;
      try { status = resp && typeof resp.status === 'function' ? resp.status() : (resp && resp.status) || null; } catch (e) { /* ignore */ }

      console.log('Navigation response status:', status);

      // If 5xx, treat as retryable
      if (status && status >= 500 && status < 600) {
        const backoff = baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        console.warn(`Got ${status} — retrying after ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
        await page.waitForTimeout(backoff);
        continue; // next attempt
      }

      // Wait for meaningful content OR fallback timeout
      try {
        await Promise.race([
          page.waitForSelector(waitSelector, { timeout: 20000 }),
          page.waitForTimeout(opts.postWaitTimeout ?? 10000)
        ]);
      } catch (e) {
        // ignore - fallback allowed
      }

      // success — return response/status for caller if needed
      return { resp, status };
    } catch (err) {
      console.warn(`safeGoto attempt ${attempt} failed: ${err.message}`);

      // final failure: capture debug artifacts
      if (attempt === maxAttempts) {
        const stamp = Date.now();
        try {
          const png = `debug-goto-503-${stamp}.png`;
          const html = `debug-goto-503-${stamp}.html`;
          await page.screenshot({ path: png, fullPage: true }).catch(() => { });
          const content = await page.content().catch(() => '<no-html>');
          fs.writeFileSync(html, content);
          console.warn('Wrote debug files:', png, html);
        } catch (e) { console.warn('Could not write debug artifacts:', e.message); }
        throw err;
      }

      // backoff before retrying
      const backoff = baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      await page.waitForTimeout(backoff);
    }
  }
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

async function runPlaywrightFor(searchTerm) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Build search URL
    const searchUrl = `${AMAZON_BASE}/s?k=${encodeURIComponent(searchTerm)}`;
    console.log('Navigating to:', searchUrl);

    // Use safe goto with retry/backoff
    const { resp, status } = await safeGotoWith503Handling(page, searchUrl, { retries: 4, navTimeout: 90000 });
    if (status === 503) {
      console.warn('Final navigation returned 503 — check debug-goto-503-*.png/.html');
      // We continue but you may want to abort depending on your workflow
    }

    // ---------- Click "Deliver to" (open the location modal) ----------
    const deliverToXpath = '/html/body/div[1]/header/div/div[1]/div[1]/div[2]/span/a/div[2]/span[2]';
    const deliverLocator = page.locator(`xpath=${deliverToXpath}`);
    if (await deliverLocator.count() > 0) {
      console.log('Clicking Deliver to button (xpath)...');
      await deliverLocator.first().click({ timeout: 10000 }).catch(() => { });
      await page.waitForTimeout(1000);
    } else {
      console.log('Deliver-to button not found by given xpath; trying header selector fallback...');
      const fallback = page.locator('#glow-ingress-block, #nav-global-location-popover-link');
      if (await fallback.count() > 0) {
        await fallback.first().click().catch(() => { });
        await page.waitForTimeout(800);
      } else {
        console.log('Could not open Deliver to modal — continuing without setting location.');
      }
    }

    // ---------- Enter ZIP code ----------
    const zipSelectors = [
      'input#GLUXZipUpdateInput',
      'input[name="zipCode"]',
      'input[aria-label*="ZIP"]',
      'xpath=/html/body/div[18]//input',
      'input#GLUXZipInput'
    ];

    let zipLocator = null;
    for (const sel of zipSelectors) {
      const loc = sel.startsWith('xpath=') ? page.locator(sel) : page.locator(sel);
      if (await loc.count() > 0) { zipLocator = loc.first(); break; }
    }

    if (!zipLocator) {
      console.warn('ZIP input not found; skipping ZIP entry/apply.');
    } else {
      // Fill the ZIP
      await zipLocator.fill(ZIP).catch(() => { });
      console.log('Filled ZIP');
      await page.waitForTimeout(250); // small pause

      // Try 1: press Enter on the input locator
      try {
        console.log('Attempting locator.press("Enter") to submit ZIP');
        await zipLocator.press('Enter', { timeout: 8000 });
        await page.waitForTimeout(1000);
      } catch (e) {
        console.warn('locator.press Enter failed (will try other fallbacks)');
        // Try 2: focus then page.keyboard.press('Enter')
        try {
          await zipLocator.focus();
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1000);
        } catch (e2) {
          console.warn('page.keyboard.press Enter failed (will try form submit/click)');
          // Try 3: submit the form via DOM (if input is inside a form)
          try {
            await page.evaluate(() => {
              const input = document.querySelector('input#GLUXZipUpdateInput, input[name="zipCode"], input[aria-label*="ZIP"]');
              if (input && input.form) input.form.submit();
            });
            await page.waitForTimeout(1000);
          } catch (e3) {
            console.warn('DOM form.submit() failed (will try clicking apply control)');
          }
        }
      }

      // After submitting, wait for results selector briefly
      const sawResults = await waitForSearchResultsOrTimeout(page, 8000);
      if (!sawResults) {
        // Try clicking Apply as fallback
        const applySelectors = [
          'xpath=/html/body/div[18]//span/span/input',
          'input#GLUXZipUpdate',
          'input[type="submit"][aria-label*="Apply"]',
          'button:has-text("Apply")',
          'button:has-text("Apply ZIP")'
        ];

        let applied = false;
        for (const s of applySelectors) {
          const loc = s.startsWith('xpath=') ? page.locator(s) : page.locator(s);
          if (await loc.count() > 0) {
            await removeOverlayIfPresent(page);
            applied = await safeClick(page, loc, { timeout: 15000 });
            if (applied) break;
          }
        }

        if (!applied) {
          console.warn('Apply control not found or click failed; attempting JS click fallback.');
          try {
            await page.evaluate(() => {
              const cand = document.querySelector('input[type="submit"], input#GLUXZipUpdate, button');
              if (cand) cand.click();
            });
          } catch (e) { /* ignore */ }
        }
      }
    } // end zipLocator check

    // Try Enter to continue (some flows need another click)
    try {
      console.log('Attempting page.keyboard.press("Enter") to continue');
      await page.keyboard.press('Enter', { timeout: 8000 }).catch(() => { });
      await page.waitForTimeout(1000);
    } catch (e) {
      console.warn('keyboard press Enter failed (will try Continue selectors)');
      // Try Continue selectors
      const contSelectors = [
        'xpath=/html/body/div[19]//input',
        'input#GLUXConfirmClose',
        'button:has-text("Continue")',
        'button:has-text("Done")'
      ];
      for (const s of contSelectors) {
        const loc = s.startsWith('xpath=') ? page.locator(s) : page.locator(s);
        if (await loc.count() > 0) {
          await removeOverlayIfPresent(page);
          const ok = await safeClick(page, loc, { timeout: 12000 });
          if (ok) break;
        }
      }
    }

    // Final: wait for actual search results to appear (no strict networkidle)
    await waitForSearchResultsOrTimeout(page, 30000);
    await page.waitForTimeout(800);

    // ---------- Click sort-by and select "Avg. Customer Review" ----------
    try {
      const sortByXpath = '/html/body/div[1]/div[1]/span/div/h1/div/div[4]/div/div/form/span/span/span/span';
      const sortLocator = page.locator(`xpath=${sortByXpath}`);
      if (await sortLocator.count() > 0) {
        await sortLocator.first().click().catch(() => { });
        await page.waitForTimeout(600);
      } else {
        // fallback: try sort select
        const sortFallback = page.locator('span.a-dropdown-container, span#s-result-sort-select, select[id^="s-result-sort"]');
        if (await sortFallback.count() > 0) {
          await sortFallback.first().click().catch(() => { });
          await page.waitForTimeout(500);
        } else {
          console.log('Sort control not found (skipping explicit sort open)');
        }
      }

      // Now select "Avg. Customer Review" option — xpath provided
      const avgReviewXpath = '/html/body/div[18]/div/div/ul/li[4]/a';
      const avg = page.locator(`xpath=${avgReviewXpath}`);
      if (await avg.count() > 0) {
        console.log('Selecting "Avg. Customer Review" via xpath...');
        await avg.first().click().catch(() => { });
      } else {
        // fallback: look for option text
        const avgFallback = page.locator('a:has-text("Avg. Customer Review"), li:has-text("Avg. Customer Review"), option:has-text("Avg. Customer Review")');
        if (await avgFallback.count() > 0) {
          await avgFallback.first().click().catch(() => { });
        } else {
          console.log('Avg. Customer Review option not found; skipping sort.');
        }
      }
    } catch (e) {
      console.warn('Sort-by step failed (ignored):', e.message);
    }

    // Wait a little for results to reload after sorting/ZIP change
    await sleep(1200);

    // ---------- Scrape top N organic search results ----------
    const resultsLocator = page.locator('div[data-component-type="s-search-result"]');
    const count = await resultsLocator.count();
    const available = Math.min(count, MAX_RESULTS);
    console.log(`Found ${count} results on page; scraping top ${available}`);

    const scraped = [];

    for (let i = 0; i < available; i++) {
      const r = resultsLocator.nth(i);

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

      console.log('rawReviewCount:', rawReviewCount, '->', reviewCountValue, reviewCountFormatted);

          
      // Price
      const price = await trySelectorsText(r, [
        'span.a-price > span.a-offscreen',
        'span.a-price-whole',
        'span.a-color-price',
      ]);

      scraped.push({
        rank: i + 1,
        title: title || null,
        link: link || null,
        image: image || null,
        reviewCount: reviewCountFormatted || null,
        price: price || null,
      });
    }

    console.log('Scrape result:', JSON.stringify(scraped, null, 2));
    return scraped;
  } catch (err) {
    console.error('Fatal error in playwright flow:', err);
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

// If run directly, test with the given sample search term:
if (require.main === module) {
  (async () => {
    const term = process.argv.slice(2).join(' ') || 'costume fitness trainer';
    try {
      const results = await runPlaywrightFor(term);
      console.log('Done. Got', results.length, 'items.');
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}