
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pLimit = require('p-limit'); // npm i p-limit
const { runPlaywrightFor } = require('./amazon-scrape'); // your existing function
const cors = require('cors');
const { chromium } = require('playwright'); // or import from your existing setup
const logger = require('./logger');


const app = express();
app.use(express.json({ limit: '30mb' }));

// Config via env
const PORT = process.env.BULK_PORT || 3001; // Changed from 8080 to 3001
const WEBHOOK_URL = process.env.WEBHOOK_URL; // Apps Script /exec URL
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'supersecret123'; // webhook token expected by Apps Script
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || ''; // token to accept bulk requests from client (optional)
const CONCURRENCY = Number(process.env.CONCURRENCY || 2); // parallel Playwright runs
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

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// forward payload to webhook with retries and backoff
async function forwardToWebhook(payload, attempt = 0) {
  const MAX_ATTEMPTS = 5;
  const taskId = payload.clientId !== undefined ? `[${payload.clientId}]` : '';
  try {
    logger.log(`${taskId} Forwarding to webhook (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
    console.log(`${taskId} Payload summary: search="${payload.search_term}", results=${Array.isArray(payload.scrapeResult) ? payload.scrapeResult.length : 0}`);
    const resp = await axios.post(WEBHOOK_URL, payload, { headers: {'Content-Type':'application/json'}, timeout: 120000 });
    // return { ok:true, status: resp.status, data: resp.data };
    const status = resp.status;
    const data = resp.data;

    // Log successful response
    logger.log(`${taskId} ✅ Webhook SUCCESS (status ${status})`);
    // console.log(`${taskId} Response data:`, JSON.stringify(data, null, 2));

    // Parse and log detailed info if available
    if (data && typeof data === 'object') {
      if (data.ok) {
        console.log(`${taskId} ✓ Apps Script processed successfully`);
        if (data.sheetRow) console.log(`${taskId}   - Sheet row: ${data.sheetRow}`);
        if (data.receivedCount !== undefined) console.log(`${taskId}   - Received: ${data.receivedCount} results`);
        if (data.writtenRows !== undefined) console.log(`${taskId}   - Written: ${data.writtenRows} rows`);
        if (data.resultsWithData !== undefined) console.log(`${taskId}   - With data: ${data.resultsWithData} rows`);
        if (data.summary && Array.isArray(data.summary)) {
          console.log(`${taskId}   - Summary: ${data.summary.length} items`);
          data.summary.forEach((item, idx) => {
            console.log(`${taskId}     [${idx + 1}] Screenshot=${item.fileId ? 'Saved' : 'No image'}`);
          });
        }
      } else {
        logger.log(`${taskId} ⚠️ Apps Script returned ok=false`);
        if (data.error) console.warn(`${taskId}   Error: ${data.error}`);
        if (data.stack) console.warn(`${taskId}   Stack: ${data.stack}`);
      }
    }

    return { ok: true, status, data };

  } catch (err) {
    const status = err.response && err.response.status;
    const responseData = err.response && err.response.data;

    // Log error details
    logger.log(`${taskId} ❌ Webhook FAILED (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    console.log(`${taskId} Error: ${err.message}`);
    if (status) console.log(`${taskId} HTTP Status: ${status}`);
    if (responseData) {
      console.log(`${taskId} Response data:`, JSON.stringify(responseData, null, 2));
    }

    const isRetryable = !status || (status >= 500 || status === 429);
    
    if (attempt >= MAX_ATTEMPTS - 1 || !isRetryable) {
      logger.log(`${taskId} 🛑 Giving up after ${attempt + 1} attempts`);
      return { ok:false, error: err.message || 'forward failed', status, responseData };
    }
    const backoff = Math.min(30000, 500 * Math.pow(2, attempt)); // exp backoff
    logger.log(`${taskId} ⏳ Retrying after ${backoff}ms...`);
    await sleep(backoff + Math.floor(Math.random()*200));
    
    return forwardToWebhook(payload, attempt + 1);
  }
}

app.use(cors({
  origin: 'http://localhost:3000', // Your Vite dev server port (check console)
  credentials: true
}));


// main endpoint: accept a bulk list of niches
// body: { token: 'client token', niches: [ { main_niche, sub_niche, keywords } ] }
app.post('/api/run-bulk', async (req, res) => {
  try {
      const body = req.body || {};
      const clientToken = body.token || '';
      if (CLIENT_TOKEN && clientToken !== CLIENT_TOKEN) {
        return res.status(403).json({ ok:false, error:'invalid client token' });
      }
      const niches = Array.isArray(body.niches) ? body.niches : [];
      if (niches.length === 0) return res.status(400).json({ ok:false, error:'no niches provided' });

      // respond quickly with accepted job info, and process asynchronously
      res.json({ ok:true, accepted: niches.length, concurrency: CONCURRENCY, message: 'Processing started' });

      console.log(`\n${'='.repeat(60)}`);
      logger.info(`Starting bulk processing: ${niches.length} niches`);
      console.log(`Concurrency: ${CONCURRENCY}`);
      console.log(`Webhook URL: ${WEBHOOK_URL}`);
      console.log(`${'='.repeat(60)}\n`);

      // Launch browser once at startup
      const sharedBrowser = await chromium.launch({ headless: true }); // do this once

      // process in background
      const limit = pLimit(CONCURRENCY);
      const results = []; // track all results

      const tasks = niches.map((n, idx) => limit(async () => {
        const main = n.main_niche || n.main || '';
        const sub = n.sub_niche || n.sub || '';

        // pass idx so suffix rotates predictably across the whole list
        const searchTerm = buildSearchTerm(main, sub, idx);     

        console.log(`\n[${idx}] ${'─'.repeat(50)}`);
        logger.info(`Processing search[${idx}]:`, { searchTerm });
        console.log(`[${idx}] Main: "${main}", Sub: "${sub}"`);


      // create an isolated context + page for this task
      const context = await sharedBrowser.newContext();
      const page = await context.newPage();

      let taskResult = { taskId: idx, searchTerm, success: false };

      try {
        // Pass page/context to your scraper
        const scraped = await runPlaywrightFor(searchTerm, { page, context, browser: sharedBrowser, taskId: idx });
        logger.info(`[${idx}] ✓ Scraped ${scraped.length} results`);

        // forward to webhook
        const payload = { 
            token: WEBHOOK_TOKEN, 
            main_niche: main, 
            sub_niche: sub, 
            keywords: n.keywords, 
            search_term: searchTerm, 
            scrapeResult: scraped, 
            clientId: idx 
          };        
        
        const webhookResult = await forwardToWebhook(payload);
        
        taskResult.success = webhookResult.ok;
        taskResult.webhookStatus = webhookResult.status;
        taskResult.webhookData = webhookResult.data;
        taskResult.scrapedCount = scraped.length;
        
        if (webhookResult.ok) {
            logger.info(`[${idx}] ✅ Task completed successfully`);
          } else {
            console.error(`[${idx}] ⚠️ Task completed but webhook failed`);
        }


      } catch (err) {
          console.error(`[${idx}] ❌ Task error:`, err.message);
          taskResult.error = err.message;
      } finally {
        await context.close(); // cleans page as well
      }

      results.push(taskResult);
      console.log(`[${idx}] ${'─'.repeat(50)}\n`);
    }));

    await Promise.all(tasks);
    await sharedBrowser.close();

    // Final summary
    console.log(`\n${'='.repeat(60)}`);
    logger.info(`BULK PROCESSING COMPLETE`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total tasks: ${results.length}`);
    console.log(`Successful: ${results.filter(r => r.success).length}`);
    console.log(`Failed: ${results.filter(r => !r.success).length}`);
    console.log(`\nDetailed Results:`);
    results.forEach(r => {
        const status = r.success ? '✅' : '❌';
        console.log(`  ${status} [${r.taskId}] ${r.searchTerm}`);
        if (r.scrapedCount !== undefined) console.log(`       Scraped: ${r.scrapedCount} items`);
        if (r.webhookStatus) console.log(`       Webhook: HTTP ${r.webhookStatus}`);
        if (r.error) console.log(`       Error: ${r.error}`);
      });
    console.log(`${'='.repeat(60)}\n`);
 
  } catch (err) {
    console.error('run-bulk error', err);
    // if we already responded, just log
  }
});

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Bulk-run server listening on port ${PORT}`);
  console.log(`Webhook URL: ${WEBHOOK_URL || 'NOT SET'}`);
  console.log(`${'='.repeat(60)}\n`);
});