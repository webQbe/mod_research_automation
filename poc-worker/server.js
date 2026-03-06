require('dotenv').config();
const express = require('express');
const fetch = global.fetch || require('node-fetch'); // node <18 fallback
const { runPlaywrightFor } = require('./amazon-scrape'); // your existing scraper
const { buildSearchTerm } = require('./search-term');
const { sendScrapedResultInChunks } = require('./chunk-forward');
const { chromium } = require('playwright'); // or import from your existing setup

const PORT = process.env.PORT || 8080;
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // optional for forwarding
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

const app = express();

const cors = require('cors');
app.use(cors({
  origin: ['http://localhost:3000'], // list allowed origins
  methods: ['POST'],
  allowedHeaders: ['Content-Type']
}));

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

app.post('/api/run-scrape', async (req, res) => {
  try {
    console.log('--- HEADERS ---');
    console.log(req.headers);

    console.log('RAW BODY (preview):', (req.rawBody || '').slice(0, 2000));
    console.log('Parsed req.body:', req.body);

    const body = req.body || {};
    const clientToken = body.token || '';

    if (process.env.CLIENT_TOKEN && clientToken !== process.env.CLIENT_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid client token' });
    }

    const main_niche = body.main_niche || body.mainNiche || '';
    const sub_niche = body.sub_niche || body.subNiche || '';
    const keywordsRaw = body.keywords || body.kw || '';
    const keywords = normalizeKeywords(keywordsRaw);

    console.log('Normalized keywords:', keywords);

    // Build search term
    const searchTerm = buildSearchTerm(main_niche, sub_niche);
    console.log('Built searchTerm:', searchTerm);

    // Respond immediately with accepted status
    res.json({ 
      ok: true, 
      accepted: 1, 
      searchTerm,
      message: 'Scraping started' 
    });

    // Process asynchronously after responding
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Starting scrape: ${searchTerm}`);
    console.log(`${'='.repeat(60)}\n`);

    // Launch browser
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    let taskResult = { searchTerm, success: false };

    try {
      // Run scraper
      const scraped = await runPlaywrightFor(searchTerm, { 
        page, 
        context, 
        browser, 
        taskId: 'single' 
      });
      
      const scrapeResult = Array.isArray(scraped) ? scraped : [];
      console.log(`✓ Scraped ${scrapeResult.length} results`);

      // Forward to webhook if configured
      if (WEBHOOK_URL) {
        // Ensure keywords is a plain string for webhook
        const keywordsForWebhook = Array.isArray(keywords)
          ? keywords.join(', ')
          : (keywords === undefined || keywords === null ? '' : String(keywords));

        const webhookPayload = {
          token: WEBHOOK_TOKEN,
          main_niche,
          sub_niche,
          keywords: keywordsForWebhook,
          search_term: searchTerm,
          scrapeResult,
          clientId: 'single'
        };

        console.log('Webhook payload keywords (type):', typeof keywordsForWebhook, keywordsForWebhook);
        console.log('Forwarding to webhook...');

        // ✅ Use the chunked forwarding function
        const forwardResp = await sendScrapedResultInChunks(webhookPayload);
        
        if (!forwardResp || !forwardResp.ok) {
          console.log(`❌ Webhook forward failed`, forwardResp);
          taskResult.success = false;
          taskResult.error = forwardResp?.error || 'Webhook forward failed';
          taskResult.webhookStatus = forwardResp?.status;
        } else {
          console.log(`✅ All chunks forwarded successfully`);
          taskResult.success = true;
          taskResult.webhookStatus = forwardResp.status;
          taskResult.webhookData = forwardResp.data;
        }
        
        taskResult.scrapedCount = scrapeResult.length;
      } else {
        // No webhook configured
        console.log('No webhook URL configured, scrape complete');
        taskResult.success = true;
        taskResult.scrapedCount = scrapeResult.length;
      }

    } catch (err) {
      console.error('❌ Scrape error:', err.message);
      taskResult.error = err.message;
      taskResult.success = false;
    } finally {
      await context.close();
      await browser.close();
    }

    // Final summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SCRAPE COMPLETE`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Search term: ${searchTerm}`);
    console.log(`Status: ${taskResult.success ? '✅ Success' : '❌ Failed'}`);
    if (taskResult.scrapedCount !== undefined) {
      console.log(`Scraped: ${taskResult.scrapedCount} items`);
    }
    if (taskResult.webhookStatus) {
      console.log(`Webhook: HTTP ${taskResult.webhookStatus}`);
    }
    if (taskResult.error) {
      console.log(`Error: ${taskResult.error}`);
    }
    console.log(`${'='.repeat(60)}\n`);

  } catch (err) {
    console.error('run-scrape error:', err);
    // Response already sent, just log the error
  }
});

app.listen(PORT, () => console.log(`Scraper server listening on ${PORT}`));