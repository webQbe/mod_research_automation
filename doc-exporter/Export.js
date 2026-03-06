// Add menu on open
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merch Export')
    .addItem('Check State', 'showExportState')
    .addItem('Resume', 'processBatch')
    .addItem('Clear Pending', 'stopExportAndClearState')
    .addItem('Export Docs', 'startExport')
    .addToUi();
}

// ---------- START / INIT ----------
/*
 * Initialize export state and start processing in batches.
 * Call this from your UI/menu instead of calling buildAndMergeByMainNiche() directly.
 */
// Improved startExport() — uses lock, prevents double-start, schedules first run
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

    // prepare state (your previous logic to build groups)
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName('raw_data');
    if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "raw_data" not found.'); return; }

    fillMainSub_fillDown_withGeneral(sheet);
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) { SpreadsheetApp.getUi().alert('No data rows in raw_data.'); return; }

    const header = data[0].map(h=>String(h).trim());
    const rows = data.slice(1);
    const idx = name => header.indexOf(name);
    const colMain = idx('main_niche');
    const colSub = idx('sub_niche');
    const colScreenshot = idx('drive_image_file_id');
    const colLink = idx('product_link');
    const colReviews = idx('review_count');
    const colKeywords = idx('keywords');

    const groups = {};
    for (const r of rows) {
      const main = String(r[colMain] || '').trim();
      if (!main) continue;
      const sub = String(r[colSub] || 'General').trim();
      groups[main] = groups[main] || {};
      groups[main][sub] = groups[main][sub] || [];
      groups[main][sub].push({
        screenshot: String(r[colScreenshot] || '').trim(),
        link: String(r[colLink] || '').trim(),
        reviews: String(r[colReviews] || '').trim(),
        keywordsRaw: String(r[colKeywords] || '').trim()
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
  const TIME_LIMIT_MS = 5 * 60 * 1000 - 10 * 1000; // aim to stop 10s before platform timeout (approx 5min)

  // Process up to batchSize or until we run out of mains or time
  let processedThisRun = 0;
  while (idx < maxIndex && processedThisRun < batchSize && (Date.now() - startTime) < TIME_LIMIT_MS) {
    const main = mains[idx];
    const subGroups = groups[main] || {};

    try {
      // --- create main doc from template (same as your earlier inner loop) ---
      const docName = `Research — ${main} (${new Date().toISOString().slice(0,10)})`;
      // Create mainDoc as a copy of the template so header/footer/styles remain.
      // Do NOT move main docs into the output folder; leave them in My Drive root.
      const mainCopyFile = DriveApp.getFileById(docTemplateId).makeCopy(docName);
      const mainDocId = mainCopyFile.getId();
      const mainDoc = DocumentApp.openById(mainDocId);
      const mainBody = mainDoc.getBody();
      mainBody.clear();
      mainBody.appendParagraph(`Research — ${main}`).setHeading(DocumentApp.ParagraphHeading.TITLE);
      mainBody.appendPageBreak();

      // iterate subgroups of this main
      let firstSub = true;
      for (const sub of Object.keys(subGroups)) {
        const items = subGroups[sub];

        // create temp sub-doc as copy of template
        const subCopyName = `TEMP - ${main} / ${sub} (${new Date().toISOString().slice(0,10)})`;
        const subFile = DriveApp.getFileById(tmplId).makeCopy(subCopyName);
        const subDocId = subFile.getId();
        const subDoc = DocumentApp.openById(subDocId);

        // fill subDoc and save it
        fillSubDocFromData(subDoc, main, sub, items);
        subDoc.saveAndClose();
        Utilities.sleep(300); // small pause helps Drive propagate

        if (!firstSub) mainBody.appendPageBreak();
        firstSub = false;

        // merge and trash temp
        mergeDocIntoBody(mainBody, subDocId);
        try { DriveApp.getFileById(subDocId).setTrashed(true); } 
        catch (e) { 
          log('Could not trash temp sub doc: ' + e); 
        }
      }

      mainDoc.saveAndClose();
      created.push({ main: main, url: mainDoc.getUrl() });
      log('Created main doc for: ' + main + ' => ' + mainDoc.getUrl());
    } catch (e) {
      log('Error creating main doc for ' + main + ': ' + e);
      // push a placeholder so we don't get stuck
      created.push({ main: main, url: '' , error: String(e)});
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