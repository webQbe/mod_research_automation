const axios = require('axios');
const logger = require('./logger');
const pLimit = require('p-limit'); // npm i p-limit

// Config
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // optional for forwarding
const FORWARD_MAX_BATCH = Number(process.env.FORWARD_MAX_BATCH || 5); // send at most 5 results per webhook call
const FORWARD_CONCURRENCY = Number(process.env.FORWARD_CONCURRENCY || 1); // start with 1
const forwardLimit = pLimit(FORWARD_CONCURRENCY);

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// For a scraped payload where scrapeResult may be large, chunk and send sequentially
async function sendScrapedResultInChunks(basePayload) {
  // basePayload: { token, main_niche, sub_niche, keywords, search_term, scrapeResult: [...] }
  const results = Array.isArray(basePayload.scrapeResult) ? basePayload.scrapeResult : [];
  if (results.length === 0) {
    // still send single empty payload so webhook can record parent row
    return await forwardLimit(() => forwardPayloadWithRetries({ ...basePayload, scrapeResult: [] }));
  }

  // chunk results so each webhook call is smaller
  const chunks = chunkArray(results, FORWARD_MAX_BATCH);

  // send each chunk sequentially for this niche (so webhook sees one niche at a time)
  let firstResp = null;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const payload = { ...basePayload, scrapeResult: chunk, chunkIndex: ci, totalChunks: chunks.length };

    // we run forwards through forwardLimit to honor global forward concurrency
    const resp = await forwardLimit(() => forwardPayloadWithRetries(payload));

    // if response is false/failed and forwardToWebhook returned ok:false, it already handles retries
    // but if it fails permanently, bubble it up
    if (!resp || !resp.ok) {
      // return the failing response so caller can mark row as error or requeue
      return resp;
    }

    // save first non-empty successful response (optional)
    if (!firstResp) firstResp = resp;
  }

  // everything OK
  return firstResp || { ok: true };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// send a single payload (calls forwardToWebhook)
async function forwardPayloadWithRetries(payload) {
  // forwardToWebhook already includes retry logic for network errors; just call it
  return await forwardToWebhook(payload);
}

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

     // Return the actual ok status from Apps Script
    return { 
      ok: data && data.ok !== false,  // true only if data.ok is explicitly true
      status, 
      data 
    };

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

    // Check if Apps Script returned ok=false (e.g., lock timeout)
    if (responseData && responseData.ok === false) {
      const errMsg = (responseData.error || '').toString().toLowerCase();
      const shouldRetry = /busy|lock|quota|temporar|timeout|try again|rate limit/.test(errMsg);
      if (shouldRetry && attempt < MAX_ATTEMPTS - 1) {
        const backoff = Math.min(60000, 2000 * Math.pow(2, attempt)); // longer backoff
        logger.log(`${taskId} ⏳ Server busy/lock/quota; retrying after ${backoff}ms... (err="${responseData.error}")`);
        await sleep(backoff + Math.floor(Math.random() * 500));
        return forwardToWebhook(payload, attempt + 1);
      }
      logger.log(`${taskId} 🛑 Server returned ok=false (non-retryable or exhausted retries): ${responseData.error}`);
      return { ok:false, error: responseData.error || 'Apps Script returned ok=false', status };
    }
    
    // Network/timeout errors - check if retryable
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

module.exports = { sendScrapedResultInChunks };