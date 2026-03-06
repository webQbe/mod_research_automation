
require('dotenv').config();
const express = require('express');
const pLimit = require('p-limit'); // npm i p-limit
const { runPlaywrightFor } = require('./amazon-scrape'); // your existing function
const cors = require('cors');
const { chromium } = require('playwright'); // or import from your existing setup
const logger = require('./logger');
const { buildSearchTerm } = require('./search-term');
const { sendScrapedResultInChunks } = require('./chunk-forward');


const app = express();
app.use(express.json({ limit: '30mb' }));

// Config via env
const PORT = process.env.BULK_PORT || 3001; // Changed from 8080 to 3001
const WEBHOOK_URL = process.env.WEBHOOK_URL; // Apps Script /exec URL
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'supersecret123'; // webhook token expected by Apps Script
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || ''; // token to accept bulk requests from client (optional)
const PLAYWRIGHT_CONCURRENCY = Number(process.env.PLAYWRIGHT_CONCURRENCY || 2); // parallel Playwright runs

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
      res.json({ ok:true, accepted: niches.length, concurrency: PLAYWRIGHT_CONCURRENCY, message: 'Processing started' });

      console.log(`\n${'='.repeat(60)}`);
      logger.info(`Starting bulk processing: ${niches.length} niches`);
      console.log(`Concurrency: ${PLAYWRIGHT_CONCURRENCY}`);
      console.log(`Webhook URL: ${WEBHOOK_URL}`);
      console.log(`${'='.repeat(60)}\n`);

      // Launch browser once at startup
      const sharedBrowser = await chromium.launch({ headless: true }); // do this once

      // process in background
      const limit = pLimit(PLAYWRIGHT_CONCURRENCY);
      const results = []; // track all results

      const tasks = niches.map((n, idx) => limit(async () => {
        const main = n.main_niche || n.main || '';
        const sub = n.sub_niche || n.sub || '';

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
        
        const forwardResp = await sendScrapedResultInChunks(payload);
        if (!forwardResp || !forwardResp.ok) {
          logger.log(`[${payload.clientId || 'x'}] Final forward failed`, forwardResp);
          // mark as error / requeue as you already do
        } else {
          logger.log(`[${payload.clientId || 'x'}] All chunks forwarded OK`);
        }
        
        taskResult.success = forwardResp.ok;
        taskResult.webhookStatus = forwardResp.status;
        taskResult.webhookData = forwardResp.data;
        taskResult.scrapedCount = scraped.length;
        
        if (forwardResp.ok) {
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