// Add menu on open
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merch Export')
    .addItem('Check State', 'showExportState')
    .addItem('Resume', 'processBatch')
    .addItem('Clear Pending', 'stopExportAndClearState')
    .addItem('Export Docs', 'startExport')
    .addItem('Dedup by ASIN', 'dedupeResultsByASINMark')
    .addToUi();
}

// ---------- START / INIT ----------
/*
 * Initialize export state and start processing in batches.
 * Call this from your UI/menu instead of calling buildAndMergeByMainNiche() directly.
 */
function startExport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    log('Could not obtain lock for startExport(); another start may be running.');
    return;
  }
  try {
    // check existing state
    const existing = getExportState();
    if (existing && existing.running) {
      log('Export is already running (state.running=true). Aborting new start.');
      return;
    }

    // prepare state (adapted to new "tasks" sheet layout)
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName('tasks');
    if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "tasks" not found.'); return; }

    // ensure main/sub filled down if you still want that behavior
    try { fillMainSub_fillDown_withGeneral(sheet); } catch (e) {
      // Non-fatal if helper not present; still continue
      log('fillMainSub_fillDown_withGeneral failed: ' + (e && e.message));
    }

    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) { SpreadsheetApp.getUi().alert('No data rows in tasks.'); return; }

    const header = data[0].map(h => String(h).trim());
    const rows = data.slice(1);
    const idx = name => header.indexOf(name);

    const colId = idx('id');
    const colMain = idx('main_niche');
    const colSub = idx('sub_niche');
    const colSearch = idx('search_term');
    const colKeywords = idx('keywords');

    // sanity checks
    if (colMain < 0 || colSub < 0 || colSearch < 0 || colId < 0) {
      SpreadsheetApp.getUi().alert('Expected headers missing in tasks sheet. Required: id, main_niche, sub_niche, search_term.');
      return;
    }

    const groups = {};
    for (const r of rows) {
      const id = String(r[colId] || '').trim();
      const main = String(r[colMain] || '').trim();
      const searchTerm = String(r[colSearch] || '').trim();
      if (!main || !searchTerm) continue; // skip incomplete tasks

      const sub = String(r[colSub] || 'General').trim() || 'General';
      const keywordsRaw = colKeywords >= 0 ? String(r[colKeywords] || '').trim() : '';

      groups[main] = groups[main] || {};
      groups[main][sub] = groups[main][sub] || [];

      groups[main][sub].push({
        id: id,
        searchTerm: searchTerm,
        keywordsRaw: keywordsRaw
      });
    }

    const state = {
      mains: Object.keys(groups),
      groups: groups,
      created: [],
      index: 0,
      batchSize: DEFAULT_BATCH_SIZE,
      outputFolderId: outputFolderId,
      docTemplateId: docTemplateId,
      spreadsheetId: spreadsheetId,
      running: true
    };

    setExportState(state);

    // delete any existing processBatch triggers to avoid duplicates
    deleteExistingProcessTriggers_();

    // schedule first run shortly (don’t call processBatch() inline)
    scheduleProcessBatchInSeconds(5);
    log('Export started and first batch scheduled in 5s. State saved.');
  } finally {
    lock.releaseLock();
  }
}

// ---------- BATCH PROCESSOR ----------
/**
 * Processes up to batchSize mains per execution and persists progress.
 * If more remain, schedules a time-trigger to continue shortly.
 */
function processBatch() {
  const prop = PropertiesService.getScriptProperties().getProperty(EXPORT_STATE_PROP);
  if (!prop) {
    log('No export state found. Run startExport() first.');
    return;
  }
  const state = JSON.parse(prop);

  const mains = state.mains || [];
  const groups = state.groups || {};
  const created = state.created || [];
  let idx = state.index || 0;
  const batchSize = state.batchSize || DEFAULT_BATCH_SIZE;
  const maxIndex = mains.length;

  log(`processBatch: starting at index ${idx} of ${maxIndex}, batchSize=${batchSize}`);

  const ssId = state.spreadsheetId || spreadsheetId;
  const outFolderId = state.outputFolderId || outputFolderId;
  const tmplId = state.docTemplateId || docTemplateId;

  const startTime = Date.now();
  const TIME_LIMIT_MS = 5 * 60 * 1000 - 10 * 1000; // stop ~10s before platform timeout

  // --- Preload results sheet once per run for quick lookups ---
  const ss = SpreadsheetApp.openById(ssId);
  const resultsSheet = ss.getSheetByName('results');
  let parentResultsMap = {}; // parent_id -> [ rowObj, ... ]
  if (resultsSheet) {
    const resData = resultsSheet.getDataRange().getValues();
    if (resData.length > 1) {
      const resHeader = resData[0].map(h => String(h).trim());
      const resRows = resData.slice(1);
      // determine indices (1-based columns: A parent_id, B rank, C title, D link, E price, F review_count, G drive_file_id, H drive_view_url, I captured_at, J notes)
      // zero-based indexes for array:
      const i_parent_id = 0;
      const i_rank = 1;
      const i_title = 2;
      const i_link = 3;
      const i_price = 4;
      const i_review_count = 5;
      const i_drive_file_id = 6;
      const i_drive_view_url = 7;
      const i_captured_at = 8;
      const i_notes = 9;

      for (let r = 0; r < resRows.length; r++) {
        const row = resRows[r];
        const parentId = String(row[i_parent_id] || '').trim();
        if (!parentId) continue;
        const rowObj = {
          parent_id: parentId,
          rank: (() => {
            const v = row[i_rank];
            if (typeof v === 'number' && !isNaN(v)) return v;
            const parsed = parseFloat(String(v || '').replace(/[^\d.\-]/g, ''));
            return isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
          })(),
          title: String(row[i_title] || '').trim(),
          link: String(row[i_link] || '').trim(),
          price: String(row[i_price] || '').trim(),
          review_count: (() => {
            const v = row[i_review_count];
            if (typeof v === 'number' && !isNaN(v)) return v;
            const parsed = parseFloat(String(v || '').replace(/[^\d.\-]/g, ''));
            return isNaN(parsed) ? 0 : parsed;
          })(),
          drive_file_id: String(row[i_drive_file_id] || '').trim(),
          drive_view_url: String(row[i_drive_view_url] || '').trim(),
          captured_at: String(row[i_captured_at] || '').trim(),
          notes: String(row[i_notes] || '').trim()
        };
        parentResultsMap[parentId] = parentResultsMap[parentId] || [];
        parentResultsMap[parentId].push(rowObj);
      }
    }
  } else {
    log('Warning: results sheet not found. No results will be merged.');
  }

  // Process up to batchSize mains (respect time)
  let processedThisRun = 0;
  while (idx < maxIndex && processedThisRun < batchSize && (Date.now() - startTime) < TIME_LIMIT_MS) {
    const main = mains[idx];
    const subGroups = groups[main] || {};

    try {
      const docName = `Research — ${main} (${new Date().toISOString().slice(0,10)})`;
      // Create mainDoc as a copy of the template so header/footer/styles remain.
      const mainCopyFile = DriveApp.getFileById(tmplId).makeCopy(docName);
      const mainDocId = mainCopyFile.getId();
      const mainDoc = DocumentApp.openById(mainDocId);
      const mainBody = mainDoc.getBody();
      mainBody.clear();
      mainBody.appendParagraph(`Research — ${main}`).setHeading(DocumentApp.ParagraphHeading.TITLE);
      mainBody.appendPageBreak();

      // iterate subgroups of this main
      let firstSub = true;
      for (const sub of Object.keys(subGroups)) {
        const items = subGroups[sub]; // array of task objects { id, searchTerm, ... }

        // --- NEW: group the tasks by search_term within this sub ---
        const searchTermMap = {}; // searchTerm -> [taskId,...]
        for (const t of items) {
          const s = String(t.searchTerm || '').trim();
          if (!s) continue;
          searchTermMap[s] = searchTermMap[s] || [];
          if (t.id) searchTermMap[s].push(String(t.id).trim());
        }

        // For each search_term, collect result rows across all parent_ids for that search_term,
        // filter out DUPLICATE notes, sort by review_count desc, take top 9, and create a temp subdoc per search_term.
        let firstSearchTermForSub = true;
        for (const searchTerm of Object.keys(searchTermMap)) {
          const parentIds = searchTermMap[searchTerm]; // array of task ids

          // gather results
          let combinedResults = [];
          for (const pid of parentIds) {
            const arr = parentResultsMap[pid];
            if (Array.isArray(arr)) {
              combinedResults = combinedResults.concat(arr);
            }
          }

          // filter out duplicates marked in notes (case-insensitive) and deduplicate by link if needed
          combinedResults = combinedResults.filter(r => {
            if (!r) return false;
            if (r.notes && /DUPLICATE/i.test(r.notes)) return false;
            return true;
          });

          // optional: dedupe combinedResults by link (if multiple parent ids pointed to same result)
          const seenLinks = new Set();
          combinedResults = combinedResults.filter(r => {
            const linkKey = (r.link || '').trim();
            if (!linkKey) return false;
            if (seenLinks.has(linkKey)) return false;
            seenLinks.add(linkKey);
            return true;
          });

          // sort by review_count desc (highest first)
          combinedResults.sort((a,b) => {
            const ra = (typeof a.review_count === 'number') ? a.review_count : 0;
            const rb = (typeof b.review_count === 'number') ? b.review_count : 0;
            return rb - ra;
          });

          // take top 9
          const topResults = combinedResults.slice(0, 9);

          // create temp sub-doc as copy of template and fill with topResults
          const subCopyName = `TEMP - ${main} / ${sub} / ${searchTerm} (${new Date().toISOString().slice(0,10)})`;
          const subFile = DriveApp.getFileById(tmplId).makeCopy(subCopyName);
          const subDocId = subFile.getId();
          const subDoc = DocumentApp.openById(subDocId);

          // You must ensure fillSubDocFromData can accept the shape of topResults items.
          // Each item here has: { title, link, price, review_count, drive_file_id, drive_view_url, captured_at, rank, parent_id }
          // If your existing fillSubDocFromData expects a different shape, adapt it accordingly.
          fillSubDocFromData(subDoc, main, sub + " — " + searchTerm, topResults);
          subDoc.saveAndClose();
          Utilities.sleep(300); // small pause helps Drive propagate

          if (!firstSub || !firstSearchTermForSub) mainBody.appendPageBreak();
          firstSub = false;
          firstSearchTermForSub = false;

          // merge and trash temp
          mergeDocIntoBody(mainBody, subDocId);
          try { DriveApp.getFileById(subDocId).setTrashed(true); }
          catch (e) { log('Could not trash temp sub doc: ' + e); }
        } // end for each searchTerm
      } // end for each sub

      mainDoc.saveAndClose();
      created.push({ main: main, url: mainDoc.getUrl() });
      log('Created main doc for: ' + main + ' => ' + mainDoc.getUrl());
    } catch (e) {
      log('Error creating main doc for ' + main + ': ' + e);
      // push a placeholder so we don't get stuck
      created.push({ main: main, url: '', error: String(e) });
    }

    // increment
    idx++;
    processedThisRun++;
  } // end while

  // persist state
  state.index = idx;
  state.created = created;
  PropertiesService.getScriptProperties().setProperty(EXPORT_STATE_PROP, JSON.stringify(state));

  // If more remain, schedule another run (time trigger) and return
  if (idx < maxIndex) {
    log(`Processed ${processedThisRun} mains. Scheduling next run (index now ${idx}/${maxIndex}).`);
    // create trigger to run in ~1 minute
    scheduleProcessBatchInSeconds(60);
    return;
  }

  // All mains processed: continue to merging step
  log('All mains processed. Proceeding to merge combined docs.');
  try {
    // start incremental merging: splits created[] into chunks and schedules chunk runner
    startMergeChunks();
  } catch (e) {
    log('Failed to start merge chunks: ' + e);
}
  return;
}

/**
 * Create time-driven trigger to call processBatch after `seconds`.
 */
function scheduleProcessBatchInSeconds(seconds) {
  deleteExistingProcessTriggers_();
  const trigger = ScriptApp.newTrigger('processBatch')
    .timeBased()
    .after(seconds * 1000)
    .create();
  log('Scheduled processBatch trigger to run in ' + seconds + ' seconds: ' + trigger.
  getUniqueId());
}

/**
 * Deletes existing time-driven triggers for processBatch to avoid duplicates.
 */
function deleteExistingProcessTriggers_() {
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const t of allTriggers) {
    if (t.getHandlerFunction && t.getHandlerFunction() === 'processBatch') {
      ScriptApp.deleteTrigger(t);
    }
  }
}

// Convenience: show whether state exists (quick check)
function showExportState() {
  const p = PropertiesService.getScriptProperties();
  const s = p.getProperty(EXPORT_STATE_PROP);
  const m = p.getProperty(MERGE_STATE_KEY);
  log('EXPORT_STATE_PROP exists? ' + (s ? 'yes' : 'no'));
  if (s) log('EXPORT_STATE_PROP: ' + s);
  log('MERGE_STATE_KEY exists? ' + (m ? 'yes' : 'no'));
  if (m) log('MERGE_STATE_KEY: ' + m);
}

// Stop & clear everything (state + merge state + triggers)
function stopExportAndClearState() {
  try {
    // clear saved states
    PropertiesService.getScriptProperties().deleteProperty(EXPORT_STATE_PROP);
    PropertiesService.getScriptProperties().deleteProperty(MERGE_STATE_KEY);
  } catch (e) {
    log('Failed to clear properties: ' + e);
  }

  // delete relevant triggers (processBatch, mergeProcessChunk, startExport)
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const t of allTriggers) {
    const fn = t.getHandlerFunction && t.getHandlerFunction();
    if (fn === 'processBatch' || fn === 'mergeProcessChunk' || fn === 'startExport') {
      try { ScriptApp.deleteTrigger(t); } catch (e) { log('Could not delete trigger: ' + e); }
    }
  }

  log('Cleared export & merge state and deleted related triggers.');

  showExportState(); // Confirm both properties are gone and no stale state remains.
}