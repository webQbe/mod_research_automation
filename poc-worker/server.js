require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch'); // node <18 fallback
const { runPlaywrightFor } = require('./amazon-scrape'); // your existing scraper

const PORT = process.env.PORT || 8080;
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // optional for forwarding
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'supersecret123';

const app = express();

// use express.json with verify to capture raw body safely
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    try { req.rawBody = buf.toString('utf8'); } catch (e) { req.rawBody = ''; }
  }
}));

// accept urlencoded and text bodies too
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ type: 'text/*', limit: '10mb' }));

function normalizeKeywords(k) {
  if (!k && k !== '') return '';
  if (Array.isArray(k)) return k.map(x => String(x).trim()).filter(Boolean);
  const s = String(k).trim();
  const arr = s.split(',').map(x => x.trim()).filter(Boolean);
  return arr.length > 1 ? arr : (arr[0] || '');
}

app.post('/run-scrape', async (req, res) => {
  try {
    console.log('--- HEADERS ---');
    console.log(req.headers);

    console.log('RAW BODY (preview):', (req.rawBody || '').slice(0, 2000));
    console.log('Parsed req.body:', req.body);

    const body = req.body || {};
    const token = body.token || '';
    const main_niche = body.main_niche || body.mainNiche || '';
    const sub_niche = body.sub_niche || body.subNiche || '';
    const keywordsRaw = body.keywords || body.kw || '';
    const keywords = normalizeKeywords(keywordsRaw);

    console.log('Normalized keywords:', keywords);

    // Build search term
    const parts = [];
    if (main_niche) parts.push(main_niche);
    if (sub_niche) parts.push(sub_niche);
    parts.push('shirt');
    const searchTerm = parts.join(' ').replace(/\s+/g, ' ').trim();

    console.log('Built searchTerm:', searchTerm);

    // run your scraper
    const scraped = await runPlaywrightFor(searchTerm);
    const scrapeResult = Array.isArray(scraped) ? scraped : [];

    // optionally forward to webhook (your Apps Script)
    if (WEBHOOK_URL) {
      // ensure keywords is always a plain string for the webhook
      const keywordsForWebhook = Array.isArray(keywords)
        ? keywords.join(', ')
        : (keywords === undefined || keywords === null ? '' : String(keywords));

      const webhookPayload = {
          token: WEBHOOK_TOKEN,
          main_niche,
          sub_niche,
          keywords: keywordsForWebhook,
          search_term: searchTerm,
          scrapeResult
      };
      
      const webhookResp = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload)
      });
      const text = await webhookResp.text();
      console.log('Webhook payload keywords (type):', typeof keywordsForWebhook, keywordsForWebhook);
      console.log('Forwarded to webhook, status:', webhookResp.status);
      console.log('Webhook body (preview):', text.slice(0,2000));
      return res.json({ ok: true, forwarded: true, webhookStatus: webhookResp.status, scrapedCount: scrapeResult.length });
    }

    // otherwise return the scraped result directly
    res.json({ ok: true, forwarded: false, scrapedCount: scrapeResult.length, scrapeResult });
  } catch (err) {
    console.error('run-scrape error:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Scraper server listening on ${PORT}`));