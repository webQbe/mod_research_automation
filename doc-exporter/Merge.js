/**
 * Kick off incremental merging after all mains are created.
 * Call this instead of mergeAndFinish().
 */
function startMergeChunks() {
  const state = getExportState();
  if (!state || !state.created) {
    log('startMergeChunks: no state or created list found.');
    return;
  }

  // chunk the created array into blocks of up to 10
  const created = state.created || [];
  const chunks = [];
  for (let i = 0; i < created.length; i += 10) {
    chunks.push(created.slice(i, i + 10));
  }

  // persist merge state
  const mergeState = {
    chunks: chunks,                    // array of arrays [{main,url},...]
    currentIndex: 0,                   // which chunk to process next
    results: [],                       // collected combined results
    groups: state.groups || {},       
    spreadsheetId: state.spreadsheetId || spreadsheetId,
    outputFolderId: state.outputFolderId || outputFolderId
  };
  PropertiesService.getScriptProperties().setProperty(MERGE_STATE_KEY, JSON.stringify(mergeState));

  // schedule first merge chunk immediately (or call mergeProcessChunk() once)
  scheduleMergeChunkInSeconds(5);
}

/**
 * Schedule the merge chunk runner.
 */
function scheduleMergeChunkInSeconds(seconds) {
  // delete existing merge triggers to avoid duplicates
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const t of allTriggers) {
    if (t.getHandlerFunction && t.getHandlerFunction() === 'mergeProcessChunk') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('mergeProcessChunk').timeBased().after(seconds*1000).create();
}

/**
 * Process one merge chunk (one combined doc). Safe to run repeatedly.
 */
function mergeProcessChunk() {
  const raw = PropertiesService.getScriptProperties().getProperty(MERGE_STATE_KEY);
  if (!raw) { log('mergeProcessChunk: no merge state found'); return; }
  const state = JSON.parse(raw);

  const chunks = state.chunks || [];
  const idx = state.currentIndex || 0;
  if (idx >= chunks.length) {
    log('mergeProcessChunk: all chunks done. Proceeding to finalize.');
    finalizeMergesAndCreateMaster(state);
    // clear merge state
    PropertiesService.getScriptProperties().deleteProperty(MERGE_STATE_KEY);
    return;
  }

  const chunk = chunks[idx];
  const ssId = state.spreadsheetId;
  const outFolderId = state.outputFolderId;
  const dateStr = new Date().toISOString().slice(0,10);
  const batchNumber = idx + 1;
  const combinedName = `Combined – Batch ${String(batchNumber).padStart(2,'0')} – ${dateStr}`;

  log('mergeProcessChunk: processing chunk ' + idx + ' with ' + chunk.length + ' mains => ' + combinedName);

  try {
    // prepare entries for the existing merge helper
    const entries = chunk.map(c => ({ main: c.main, docId: c.url }));

    // IMPORTANT: optionally disable trashing (edit helper) or pass an option if implemented
    const res = mergeMainDocsAndWriteSheet_WithFolderAndCleanup(entries, combinedName, ssId, 'raw_data','main_niche', 'doc_url', {});

    // push to results
    state.results = state.results || [];
    state.results.push(res);
    log('mergeProcessChunk: merged chunk ' + idx + ' => ' + (res.combinedDocUrl || res.combinedDocId));

  } catch (e) {
    log('mergeProcessChunk: failed processing chunk ' + idx + ': ' + e);
    // record failure (do not bail out; you can retry the chunk)
    state.results = state.results || [];
    state.results.push({ error: String(e), chunkIndex: idx });
  }

  // increment and persist state
  state.currentIndex = idx + 1;
  PropertiesService.getScriptProperties().setProperty(MERGE_STATE_KEY, JSON.stringify(state));

  // if more chunks remain, schedule next run; otherwise finalize will run next time
  if (state.currentIndex < chunks.length) {
    log('mergeProcessChunk: scheduled next chunk (index now ' + state.currentIndex + '/' + chunks.length + ')');
    scheduleMergeChunkInSeconds(5); // short delay
  } else {
    log('mergeProcessChunk: all chunks scheduled; next run will finalize.');
    scheduleMergeChunkInSeconds(5);
  }
}

/**
 * Finalize after all chunk merges are done: build master index and cleanup.
 */
function finalizeMergesAndCreateMaster(mergeState) {
  log('finalizeMergesAndCreateMaster: building master index from merge results.');

  const results = mergeState.results || [];
  const chunks    = mergeState.chunks   || [];   // ← add this: persist chunks into mergeState
  const groups    = mergeState.groups   || {};   // ← add this: persist groups into mergeState
  const outFolderId = mergeState.outputFolderId || outputFolderId;

  // log('groups sample: ' + JSON.stringify(Object.entries(groups).slice(0, 2)));

  // Build detailed master entries: use results and original chunks to include mains/subs if possible
  // For simplicity, map results -> title/url pairs
    const masterEntries = results.map((r, i) => {
    const chunk = chunks[i] || [];
    return {
      title: `Combined Batch ${i + 1}`,
      url:   r.combinedDocUrl || '',
      mains: chunk.map(c => ({          // ← was always [] before
        name:      c.main,
        subNiches: Object.keys(groups[c.main] || {})
      }))
    };
  });

  try {
    const dateStr = new Date().toISOString().slice(0,10);
    const masterRes = createMasterIndexDoc(
      masterEntries, outFolderId,
      `Master Index — ${dateStr}`,
      { makePageless: true, deleteOldWithSameTitle: true }
    );    
    log('finalizeMergesAndCreateMaster: master created => ' + masterRes.masterDocUrl);
    // Optionally notify user:
    try { SpreadsheetApp.getUi().alert('Export complete! Master index created: ' + masterRes.masterDocUrl); } catch(e) { /* ignore in trigger context */ }
  } catch (e) {
    log('finalizeMergesAndCreateMaster: failed to create master index: ' + e);
  }
}

// ---------- MERGE + MASTER INDEX FINAL STEP ----------
/**
 * Called once all mains processed. Groups created[] into blocks of up to 10 mains,
 * calls mergeMainDocsAndWriteSheet_WithFolderAndCleanup() for each 10-block,
 * and then creates the master index.
 */
function mergeAndFinish(state) {
  const created = state.created || [];
  if (!created || created.length === 0) {
    log('No created mains found; nothing to merge.');
    return;
  }

  const ssId = state.spreadsheetId || spreadsheetId;
  const outFolderId = state.outputFolderId || outputFolderId;

  // group created list into chunks of 10
  const chunks = [];
  for (let i = 0; i < created.length; i += 10) {
    chunks.push(created.slice(i, i + 10));
  }

  const combinedResults = [];
  let batchNumber = 1;
  const dateStr = new Date().toISOString().slice(0,10);

  for (const chunk of chunks) {
    const entries = chunk.map(c => ({ main: c.main, docId: c.url }));

    const combinedName = `Combined – Batch ${String(batchNumber).padStart(2,'0')} – ${dateStr}`;
    log('Creating combined doc for batch ' + batchNumber + ' with ' + entries.length + ' mains => ' + combinedName);
    
    try {
      const res = mergeMainDocsAndWriteSheet_WithFolderAndCleanup(entries, combinedName, ssId, 'raw_data','main_niche', 'doc_url', {});
      combinedResults.push(res);
      log('Combined result: ' + JSON.stringify(res));
    } catch (e) {
      log('Error combining batch ' + batchNumber + ': ' + e);
    }

    batchNumber++;
  }

  // Better: build masterEntries with actual mains/subs using original state.groups
  // Here I construct detailed master entries per combined chunk:
  const detailedMasterEntries = [];
  let chunkIndex = 0;
  for (const chunk of chunks) {
    const entry = { title: '', url: '', mains: [] };
    const comboRes = combinedResults[chunkIndex] || {};
    entry.title = comboRes.combinedDocUrl ? ('Combined Batch ' + (chunkIndex+1)) : ('Combined Batch ' + (chunkIndex+1));
    entry.url = comboRes.combinedDocUrl || '';
    // fill mains from chunk
    entry.mains = chunk.map(c => ({ name: c.main, subNiches: Object.keys(state.groups[c.main] || {}) }));
    detailedMasterEntries.push(entry);
    chunkIndex++;
  }

  // Create the master index doc
  const masterResult = createMasterIndexDoc(detailedMasterEntries, outFolderId, `Master Index — ${dateStr}`, { makePageless: true, deleteOldWithSameTitle: true });
  log('Master index created: ' + JSON.stringify(masterResult));

  return { combinedResults, masterResult };
}

/**
 * Merge main docs into one combined doc created inside outputFolderId (if provided),
 * set the combined doc to pageless (if Docs Advanced Service is enabled),
 * trash the source docs (entries) after successful creation,
 * and write the combined doc URL into the sheet's doc_url column for matching main_niche rows.
 *
 * entries: [{ main: 'Fitness', docId: 'https://docs.google.com/document/d/ID/...' }, ...]
 * outputFolderId: Drive folder id where combined doc will be placed ('' => root)
 *
 * Returns { combinedDocId, combinedDocUrl, rowsUpdated, trashedCount }.
 */
function mergeMainDocsAndWriteSheet_WithFolderAndCleanup(entries, combinedName, spreadsheetId, sheetName, mainColHeader = 'main_niche', docUrlHeader = 'doc_url', options = {}) {
  /* When running merge chunks you can pass { setPageless: false, trashSources: false } to speed things up and reduce chance of Drive quota errors. */
  const opts = Object.assign({ setPageless: true, trashSources: true }, options);
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries must be a non-empty array');

  // helper: extract docId from url or id
  function extractDocIdFromDocUrl(u) {
    if (!u) return null;
    const m1 = u.match(/\/d\/([-\w]{10,})/);
    if (m1) return m1[1];
    const m2 = u.match(/[?&]id=([-\w]{10,})/);
    if (m2) return m2[1];
    const m3 = u.match(/docs\.google\.com\/document\/d\/([-\w]{10,})/);
    if (m3) return m3[1];
    const plain = u.match(/^([-\w]{10,})$/);
    if (plain) return plain[1];
    return null;
  }

  // normalize entries -> { main, docId }
  const normalized = entries.map(e => {
    const main = (e.main || e.name || '').toString().trim();
    const idOrUrl = (e.docId || e.id || e.url || e.link || '').toString().trim();
    const docId = extractDocIdFromDocUrl(idOrUrl) || idOrUrl;
    return { main, docId };
  }).filter(x => x.main && x.docId);

  if (normalized.length === 0) throw new Error('No valid entries with both main and docId provided.');

  // --- Create combined document (in Drive root first) ---
  const combinedFile = DocumentApp.create(combinedName || ('Combined ' + new Date().toISOString()));
  const combinedDocId = combinedFile.getId();
  const combinedDoc = DocumentApp.openById(combinedDocId);
  const combinedBody = combinedDoc.getBody();

  // Add a simple title page and page break
  combinedBody.appendParagraph('Combined Research').setHeading(DocumentApp.ParagraphHeading.TITLE);
  combinedBody.appendParagraph('Created: ' + new Date().toISOString());
  combinedBody.appendPageBreak();

  // Helper to append children from a source doc
  function appendDocChildrenToTargetBody(targetBody, sourceDocId) {
    try {
      const sourceDoc = DocumentApp.openById(sourceDocId);
      const sourceBody = sourceDoc.getBody();
      const n = sourceBody.getNumChildren();
      for (let i = 0; i < n; i++) {
        const child = sourceBody.getChild(i);
        const type = child.getType();
        try {
          if (type === DocumentApp.ElementType.PARAGRAPH) {
            targetBody.appendParagraph(child.asParagraph().copy());
          } else if (type === DocumentApp.ElementType.TABLE) {
            targetBody.appendTable(child.asTable().copy());
          } else if (type === DocumentApp.ElementType.LIST_ITEM) {
            targetBody.appendListItem(child.asListItem().copy());
          } else {
            // fallback: append plain text
            const text = (typeof child.getText === 'function') ? child.getText() : '';
            targetBody.appendParagraph(text);
          }
        } catch (err) {
          try {
            const fallbackText = (typeof child.getText === 'function') ? child.getText() : '';
            targetBody.appendParagraph(fallbackText);
          } catch (e2) {
            log('Failed to append child: ' + e2);
          }
        }
      }
    } catch (e) {
      log('Failed to open source doc ' + sourceDocId + ': ' + e);
    }
  }

  // Append each source doc
  normalized.forEach((entry, idx) => {
    combinedBody.appendParagraph(`Main niche: ${entry.main}`).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    appendDocChildrenToTargetBody(combinedBody, entry.docId);
    if (idx < normalized.length - 1) combinedBody.appendPageBreak();
  });

  combinedDoc.saveAndClose();

  // --- Try to set the combined doc to pageless using the Docs API (Advanced Service) ---
  let pagelessSet = false;
  try {
    if (typeof Docs !== 'undefined' && Docs.Documents && Docs.Documents.batchUpdate) {
      const requests = [
        {
          updateDocumentStyle: {
            documentStyle: {
              // DocumentFormat is a nested object; set document_mode to PAGELESS
              documentFormat: {
                documentMode: 'PAGELESS'
              }
            },
            fields: 'documentFormat.documentMode'
          }
        }
      ];
      if (opts.setPageless) { 
        Docs.Documents.batchUpdate({ requests: requests }, combinedDocId);
        pagelessSet = true;
        log('Requested pageless mode via Docs API.');
      }
    } else {
      log('Docs Advanced Service not available. Skipping pageless request. Enable the Docs advanced service to set pageless programmatically.');
    }
  } catch (e) {
    log('Attempt to set pageless via Docs API failed: ' + e);
  }

  // --- Trash (delete) the source docs (normalized entries) ---
  let trashedCount = 0;
  normalized.forEach(entry => {
    try {
      const f = DriveApp.getFileById(entry.docId);
      // Avoid trashing the combined doc itself if by chance it was included
      if (f && f.getId() !== combinedDocId) {
        if (opts.trashSources){
          f.setTrashed(true);
        }
        trashedCount++;
      }
    } catch (e) {
      log('Failed to trash source doc ' + entry.docId + ': ' + e);
    }
  });
  log('Trashed ' + trashedCount + ' source docs.');

  const combinedDriveFile = DriveApp.getFileById(combinedDocId);
  const outputFolder = DriveApp.getFolderById(outputFolderId);  // ← get folder object first
  outputFolder.addFile(combinedDriveFile);
  DriveApp.getRootFolder().removeFile(combinedDriveFile); // ← remove from root

  const combinedFileUrl = DriveApp.getFileById(combinedDocId).getUrl();

  return {
    combinedDocId: combinedDocId,
    combinedDocUrl: combinedFileUrl,
    trashedCount: trashedCount,
    pagelessRequested: pagelessSet
  };
}

/*
 * Merge sourceDocId into the provided targetBody.
 * This function opens the source document, iterates its children and appends copies to the targetBody.
 * IMPORTANT: it does NOT save or close the document passed to targetBody (caller should handle saving).
 */
function mergeDocIntoBody(targetBody, sourceDocId) {
  const sourceDoc = DocumentApp.openById(sourceDocId);
  const sourceBody = sourceDoc.getBody();
  const n = sourceBody.getNumChildren();

  for (let i = 0; i < n; i++) {
    const child = sourceBody.getChild(i);
    const type = child.getType();

    try {
      if (type === DocumentApp.ElementType.PARAGRAPH) {
        targetBody.appendParagraph(child.asParagraph().copy());
      } else if (type === DocumentApp.ElementType.TABLE) {
        targetBody.appendTable(child.asTable().copy());
      } else if (type === DocumentApp.ElementType.LIST_ITEM) {
        targetBody.appendListItem(child.asListItem().copy());
      } else {
        // fallback: append plain text if unknown type
        const text = (typeof child.getText === 'function') ? child.getText() : '';
        targetBody.appendParagraph(text);
      }
    } catch (err) {
      // fallback to text content on failure
      try {
        const fallbackText = (typeof child.getText === 'function') ? child.getText() : '';
        targetBody.appendParagraph(fallbackText);
      } catch (e2) {
        log('Failed to merge child index ' + i + ': ' + e2);
      }
    }
  }

  // don't save/close target doc here; caller will save once after all merges
}

/**
 * Merge all top-level children from sourceDocId into targetDocId (appends to target body).
 * Preserves tables, paragraphs, list items and inline images by using .copy() and type-specific append.
 */
function mergeDocInto(targetDocId, sourceDocId) {
  const targetDoc = DocumentApp.openById(targetDocId);
  const sourceDoc = DocumentApp.openById(sourceDocId);
  const targetBody = targetDoc.getBody();
  const sourceBody = sourceDoc.getBody();

  const n = sourceBody.getNumChildren();
  for (let i = 0; i < n; i++) {
    const child = sourceBody.getChild(i);
    const type = child.getType();

    try {
      if (type === DocumentApp.ElementType.PARAGRAPH) {
        targetBody.appendParagraph(child.asParagraph().copy());
      } else if (type === DocumentApp.ElementType.TABLE) {
        targetBody.appendTable(child.asTable().copy());
      } else if (type === DocumentApp.ElementType.LIST_ITEM) {
        targetBody.appendListItem(child.asListItem().copy());
      } else if (type === DocumentApp.ElementType.INLINE_IMAGE) {
        // inline images usually live inside paragraphs, but handle if encountered
        targetBody.appendParagraph('').appendInlineImage(child.asInlineImage().getBlob());
      } else {
        // fallback: try to append text content
        const text = (typeof child.getText === 'function') ? child.getText() : '';
        targetBody.appendParagraph(text);
      }
    } catch (err) {
      // If an element type copy fails, fallback to plain text of that element
      try {
        const fallbackText = (typeof child.getText === 'function') ? child.getText() : '';
        targetBody.appendParagraph(fallbackText);
      } catch (e2) {
        log('Failed to merge child index ' + i + ': ' + e2);
      }
    }
  }

  // Save target doc (sourceDoc left as-is)
  targetDoc.saveAndClose();
}

/**
 * Create a Master Index doc from combinedFiles entries.
 *
 * @param {Array} entries - array of { title, url, mains: [{name, subNiches: []}, ...] }
 * @param {string} outputFolderId - Drive folder id to store master index ('' => My Drive root)
 * @param {string} masterTitle - Title for the master index doc (optional)
 * @param {Object} [opts] - optional flags: { makePageless: true/false, deleteOldWithSameTitle: true/false }
 * @returns {Object} { masterDocId, masterDocUrl }
 *
 * NOTE: To programmatically set pageless mode, enable the Docs Advanced Service (Docs) and the Google Docs API.
 */
function createMasterIndexDoc(entries, outputFolderId = '', masterTitle = '', opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries must be a non-empty array');

  opts = Object.assign({ makePageless: true, deleteOldWithSameTitle: false }, opts);

  // Normalize
  const normalized = entries.map(e => ({
    title: (e.title || e.name || '').toString().trim(),
    url:   (e.url || e.docUrl || e.docId || '').toString().trim(),
    mains: Array.isArray(e.mains) ? e.mains.slice(0, 10).map(m => ({
      name: (m.name || m.main || '').toString().trim(),
      subNiches: Array.isArray(m.subNiches) ? m.subNiches.map(String).map(s=>s.trim()).filter(Boolean) : []
    })) : []
  })).filter(e => e.title && e.url);

  if (normalized.length === 0) throw new Error('No valid normalized entries found.');

  // Optional: delete existing master with same title (safer to test false first)
  const safeTitle = masterTitle || ('Master Index — ' + (new Date()).toISOString().slice(0,10));
  if (opts.deleteOldWithSameTitle && outputFolderId && outputFolderId.trim()) {
    try {
      const folder = DriveApp.getFolderById(outputFolderId);
      const files = folder.getFilesByName(safeTitle);
      while (files.hasNext()) {
        const f = files.next();
        f.setTrashed(true);
        log('Trashed previous master file: ' + f.getId());
      }
    } catch (e) {
      log('Could not delete existing master file(s): ' + e);
    }
  }

  // Create new doc
  const masterDocFile = DocumentApp.create(safeTitle);
  const masterDocId = masterDocFile.getId();
  const masterDoc = DocumentApp.openById(masterDocId);
  const body = masterDoc.getBody();

  // Header: last updated date
  const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  body.appendParagraph('Last updated: ' + nowStr).setHeading(DocumentApp.ParagraphHeading.HEADING3);
  body.appendParagraph(''); // spacer

  body.appendParagraph('Master Index').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(''); // spacer

  body.appendParagraph('Niches in each doc').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(''); // spacer

  // For each combined file, append a subsection: linked title + table of mains & sub-niches
  normalized.forEach((entry, entryIdx) => {
    // Section title with clickable link
    const titlePara = body.appendParagraph(entry.title); 
    try {
      // attach link to the title text
      // 1. Set the heading style FIRST
      titlePara.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      // 2. Then apply specific text formatting
      const titleText = titlePara.editAsText();
      titleText.setText(entry.title);
      titleText.setLinkUrl(entry.url);
      titleText.setForegroundColor('#0000FF'); // blue color
    } catch (e) {
      log('Could not set link for title: ' + e);
    }

    // Build table rows (header + mains)
    const tableRows = [];
    tableRows.push(['Main-niches', 'Sub-niches']); // make bold

    for (let i = 0; i < entry.mains.length; i++) {
      const mn = entry.mains[i];
      const idxLabel = (i + 1) + '. ' + (mn.name || '');
      const subs = (mn.subNiches && mn.subNiches.length) ? mn.subNiches.join(', ') : ''; // blank allowed
      tableRows.push([idxLabel, subs]);
    }

    // Append table only if there are mains; otherwise insert a small placeholder
    if (tableRows.length > 1) {
      const table = body.appendTable(tableRows);
      
      // Make header row (first row) bold
      try {
        const headerRow = table.getRow(0);
        headerRow.getCell(0).editAsText().setBold(true);
        headerRow.getCell(1).editAsText().setBold(true);
      } catch (e) {
        log('Could not bold table headers: ' + e);
      }
    } else {
      body.appendParagraph('No main-niches in this combined doc.');
    }

    // Blank line after each section
    body.appendParagraph('');
  });

  masterDoc.saveAndClose();

  // Move master file into outputFolderId if provided
  try {
    if (outputFolderId && outputFolderId.trim()) {
      const masterDriveFile = DriveApp.getFileById(masterDocId);
      const folder = DriveApp.getFolderById(outputFolderId);
      folder.addFile(masterDriveFile);
      DriveApp.getRootFolder().removeFile(masterDriveFile);
      log('Moved master index to folder: ' + outputFolderId);
    } else {
      log('No outputFolderId provided — master left in My Drive root.');
    }
  } catch (e) {
    log('Error moving master file to folder: ' + e);
  }

  // Try to set pageless (Docs Advanced Service required)
  if (opts.makePageless) {
    try {
      if (typeof Docs !== 'undefined' && Docs.Documents && Docs.Documents.batchUpdate) {
        const requests = [{
          updateDocumentStyle: {
            documentStyle: {
              documentFormat: {
                documentMode: 'PAGELESS'
              }
            },
            fields: 'documentFormat.documentMode'
          }
        }];
        Docs.Documents.batchUpdate({ requests }, masterDocId);
        log('Requested pageless mode for master doc.');
      } else {
        log('Docs Advanced Service not available; pageless not set. Enable Docs service to set pageless.');
      }
    } catch (e) {
      log('Pageless request failed: ' + e);
    }
  }

  const masterUrl = DriveApp.getFileById(masterDocId).getUrl();
  log('Master index created: ' + masterUrl);
  return { masterDocId, masterDocUrl: masterUrl };
}