// Add menu on open
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merch Export')
    .addItem('Export Docs by Main Niche', 'buildAndMergeByMainNiche')
    .addToUi();
}


function buildAndMergeByMainNiche() {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheetName = ss.getSheetByName('raw_data');
  if (!sheetName) { SpreadsheetApp.getUi().alert('Sheet "raw_data" not found.'); return; }
  
  // Fill down main+sub until next non-empty
  fillMainSub_fillDown_withGeneral(sheetName);

  // re-read the sheet now that drive_image_file_id values may exist
  const data = sheetName.getDataRange().getValues();
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

  // Group rows into main->sub->[items]
  const groups = {};
  rows.forEach(r => {
    const main = String(r[colMain] || '').trim();
    if (!main) return;
    const sub = String(r[colSub] || 'General').trim();
    groups[main] = groups[main] || {};
    groups[main][sub] = groups[main][sub] || [];
    groups[main][sub].push({
      screenshot: String(r[colScreenshot] || '').trim(),
      link: String(r[colLink] || '').trim(),
      reviews: String(r[colReviews] || '').trim(),
      keywordsRaw: String(r[colKeywords] || '').trim()
    });
  });

  const created = [];

  // For each main niche: create main doc (one copy of template), then create sub-docs, fill them and merge
  for (const main of Object.keys(groups)) {
    const docName = `Research — ${main} (${new Date().toISOString().slice(0,10)})`;

    // Create mainDoc as a copy of the template so header/footer/styles remain
    const mainCopyFile = DriveApp.getFileById(docTemplateId).makeCopy(docName);
    if (outputFolderId) {
      DriveApp.getFolderById(outputFolderId).addFile(mainCopyFile);
      DriveApp.getRootFolder().removeFile(mainCopyFile);
    }
    const mainDocId = mainCopyFile.getId();
    const mainDoc = DocumentApp.openById(mainDocId);
    const mainBody = mainDoc.getBody();

    // keep header/footer/styles, remove template body
    mainBody.clear();

    // Add main-niche heading on page 1, then force a page break so sub-niches start on page 2
    mainBody.appendParagraph(`Research — ${main}`)
            .setHeading(DocumentApp.ParagraphHeading.TITLE);
    mainBody.appendPageBreak();

    const subGroups = groups[main];
    let firstSub = true;

    for (const sub of Object.keys(subGroups)) {
      const items = subGroups[sub];

      // create temp sub-doc (copy of template)
      const subCopyName = `TEMP - ${main} / ${sub} (${new Date().toISOString().slice(0,10)})`;
      const subFile = DriveApp.getFileById(docTemplateId).makeCopy(subCopyName);
      const subDocId = subFile.getId();
      const subDoc = DocumentApp.openById(subDocId);

      // Log to confirm what’s being inserted
      Logger.log('Items for sub %s: %s', sub, JSON.stringify(items.slice(0,5), null, 2));

      // fill subDoc (this function must NOT call saveAndClose)
      fillSubDocFromData(subDoc, main, sub, items);

      // explicitly save & close the subDoc
      subDoc.saveAndClose();

      // short pause to let Drive finish the copy/save (helps avoid intermittent race conditions)
      Utilities.sleep(400);

      // insert page break before merging (skip for first sub)
      if (!firstSub) {
        mainBody.appendPageBreak();
      }
      firstSub = false;

      // merge source (subDoc) into existing mainBody (this DOES NOT close mainDoc)
      mergeDocIntoBody(mainBody, subDocId);

      // trash temporary sub doc to avoid clutter
      try {
        DriveApp.getFileById(subDocId).setTrashed(true);
      } catch (e) {
        Logger.log('Could not trash temp sub doc: ' + e);
      }
    } // end sub loop

    // finally save & close the main doc once
    mainDoc.saveAndClose();
    created.push({ main, url: mainDoc.getUrl() });
  } // end main loop

  // SpreadsheetApp.getUi().alert('Done. Created ' + created.length + ' main docs.');
  Logger.log(JSON.stringify(created,null,2));

  // Prepare entries for merge helper: convert {main, url} -> {main, docId}
  const entries = created.map(c => ({ main: c.main, docId: c.url }));

  // GENERATE BATCH NUMBER 
  const dateStr = new Date().toISOString().slice(0,10);
  let batchNumber = 1;
  
  // Check for existing "Combined – Batch" files today in the output folder
  if (outputFolderId && outputFolderId.trim()) {
    try {
      const folder = DriveApp.getFolderById(outputFolderId);
      const files = folder.getFiles();
      const pattern = new RegExp(`^Combined – Batch (\\d+) – ${dateStr.replace(/[-]/g, '\\-')}$`);
      
      while (files.hasNext()) {
        const file = files.next();
        const match = file.getName().match(pattern);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= batchNumber) {
            batchNumber = num + 1;
          }
        }
      }
    } catch (e) {
      Logger.log('Could not check existing batch files: ' + e);
    }
  }

  // MERGE 10 MAIN-NICHES INTO ONE COMBINED DOC
  // Define name for combined doc
  const combinedName = `Combined – Batch ${String(batchNumber).padStart(2, '0')} – ${dateStr}`;
  Logger.log('Combined doc name: ' + combinedName);

  try {
    const res = mergeMainDocsAndWriteSheet_WithFolderAndCleanup(
                    entries, 
                    combinedName, 
                    spreadsheetId, // combined doc url is written to the same sheet
                    'raw_data',  // ← Changed from sheetName to 'raw_data'
                    outputFolderId, 
                    'main_niche', 
                    'doc_url' 
                );
    Logger.log('mergeMainDocsAndWriteSheet result: ' + JSON.stringify(res));
  
    // CREATE MASTER INDEX AFTER SUCCESSFUL MERGE 
    // Build entries array for master index
    const masterEntries = [{
      title: combinedName,
      url: res.combinedDocUrl,
      mains: created.map(c => ({
        name: c.main,
        subNiches: Object.keys(groups[c.main]) // get all sub-niches for this main
      }))
    }];

    // Create the master index document
    const masterResult = createMasterIndexDoc(
      masterEntries, 
      outputFolderId, 
      `Master Index — ${new Date().toISOString().slice(0,10)}`,
      { makePageless: true, deleteOldWithSameTitle: true }
    );
    
    Logger.log('Master index created!' /* : ' + JSON.stringify(masterResult) */);
    SpreadsheetApp.getUi().alert('Export complete!' /* Master index created at: ' + masterResult.masterDocUrl */);            
  
  } catch (e) {
    Logger.log('Failed to merge and write combined doc: ' + e);
  }

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
        Logger.log('Trashed previous master file: ' + f.getId());
      }
    } catch (e) {
      Logger.log('Could not delete existing master file(s): ' + e);
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
      Logger.log('Could not set link for title: ' + e);
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
        Logger.log('Could not bold table headers: ' + e);
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
      Logger.log('Moved master index to folder: ' + outputFolderId);
    } else {
      Logger.log('No outputFolderId provided — master left in My Drive root.');
    }
  } catch (e) {
    Logger.log('Error moving master file to folder: ' + e);
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
        Logger.log('Requested pageless mode for master doc.');
      } else {
        Logger.log('Docs Advanced Service not available; pageless not set. Enable Docs service to set pageless.');
      }
    } catch (e) {
      Logger.log('Pageless request failed: ' + e);
    }
  }

  const masterUrl = DriveApp.getFileById(masterDocId).getUrl();
  Logger.log('Master index created: ' + masterUrl);
  return { masterDocId, masterDocUrl: masterUrl };
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
function mergeMainDocsAndWriteSheet_WithFolderAndCleanup(entries, combinedName, spreadsheetId, sheetName, outputFolderId, mainColHeader = 'main_niche', docUrlHeader = 'doc_url') {
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
            Logger.log('Failed to append child: ' + e2);
          }
        }
      }
    } catch (e) {
      Logger.log('Failed to open source doc ' + sourceDocId + ': ' + e);
    }
  }

  // Append each source doc
  normalized.forEach((entry, idx) => {
    combinedBody.appendParagraph(`Main niche: ${entry.main}`).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    appendDocChildrenToTargetBody(combinedBody, entry.docId);
    if (idx < normalized.length - 1) combinedBody.appendPageBreak();
  });

  combinedDoc.saveAndClose();

  // --- Move combined file into OUTPUT_FOLDER_ID if provided ---
  try {
    const combinedDriveFile = DriveApp.getFileById(combinedDocId);
    if (outputFolderId && outputFolderId.toString().trim()) {
      const targetFolder = DriveApp.getFolderById(outputFolderId);
      targetFolder.addFile(combinedDriveFile);
      DriveApp.getRootFolder().removeFile(combinedDriveFile);
      Logger.log('Moved combined doc to folder: ' + outputFolderId);
    } else {
      Logger.log('No outputFolderId provided; combined doc left in My Drive root.');
    }
  } catch (e) {
    Logger.log('Failed to move combined doc to folder ' + outputFolderId + ': ' + e);
  }

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
      Docs.Documents.batchUpdate({ requests: requests }, combinedDocId);
      pagelessSet = true;
      Logger.log('Requested pageless mode via Docs API.');
    } else {
      Logger.log('Docs Advanced Service not available. Skipping pageless request. Enable the Docs advanced service to set pageless programmatically.');
    }
  } catch (e) {
    Logger.log('Attempt to set pageless via Docs API failed: ' + e);
  }

  // --- Trash (delete) the source docs (normalized entries) ---
  let trashedCount = 0;
  normalized.forEach(entry => {
    try {
      const f = DriveApp.getFileById(entry.docId);
      // Avoid trashing the combined doc itself if by chance it was included
      if (f && f.getId() !== combinedDocId) {
        f.setTrashed(true);
        trashedCount++;
      }
    } catch (e) {
      Logger.log('Failed to trash source doc ' + entry.docId + ': ' + e);
    }
  });
  Logger.log('Trashed ' + trashedCount + ' source docs.');

  const combinedFileUrl = DriveApp.getFileById(combinedDocId).getUrl();

  // --- Write combined URL into spreadsheet doc_url column for matching mains ---
  const mainsSet = {};
  normalized.forEach(e => { if (e.main) mainsSet[e.main] = true; });

  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + sheetName);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  const mainIdx = headers.findIndex(h => h.toLowerCase().replace(/[_\s]+/g,'') === mainColHeader.toLowerCase().replace(/[_\s]+/g,''));
  if (mainIdx === -1) throw new Error('Could not find main_niche column header: ' + mainColHeader);

  let docUrlIdx = headers.indexOf(docUrlHeader);
  if (docUrlIdx === -1) {
    // append header if missing
    const newCol = sheet.getLastColumn() + 1;
    sheet.getRange(1, newCol).setValue(docUrlHeader);
    docUrlIdx = newCol - 1;
  }

  const startRow = 2;
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(startRow, 1, Math.max(0, lastRow - 1), sheet.getLastColumn()).getValues();

  const updates = [];
  let updatedCount = 0;

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const mainVal = String(row[mainIdx] || '').trim();
    if (mainVal && mainsSet[mainVal]) {
      updates.push([combinedFileUrl]);
      updatedCount++;
    } else {
      updates.push([String(row[docUrlIdx] || '') || '']);
    }
  }

  // Ensure enough rows/columns
  const outCol = docUrlIdx + 1;
  if (sheet.getMaxRows() < startRow + updates.length - 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), startRow + updates.length - 1 - sheet.getMaxRows());
  }
  sheet.getRange(startRow, outCol, updates.length, 1).setValues(updates);

  Logger.log('Wrote combined doc url to ' + updatedCount + ' rows in sheet ' + sheetName);

  return {
    combinedDocId: combinedDocId,
    combinedDocUrl: combinedFileUrl,
    rowsUpdated: updatedCount,
    trashedCount: trashedCount,
    pagelessRequested: pagelessSet
  };
}

/**
 * Extract Drive file id from the common drive url patterns.
 * returns id string or null
 */
function extractDriveFileId(text) {
  if (!text) return null;

  // common patterns:
  // https://drive.google.com/file/d/<id>/view?usp=...
  // https://drive.google.com/open?id=<id>
  // plain id (25+ chars of [-_A-Za-z0-9])

  const fileMatch = text.match(/\/d\/([-\w]{25,})/);
  if (fileMatch) return fileMatch[1];

  const idParam = text.match(/[?&]id=([-\w]{25,})/);
  if (idParam) return idParam[1];

  // plain id fallback (very permissive — ensure length)
  const plain = text.match(/^([-\w]{25,})$/);
  if (plain) return plain[1];

  return null;
}

/**
 * Try to guess extension from url path
 */
function guessExtensionFromUrl(url) {
  try {
    const m = url.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
    if (m) return m[1].toLowerCase();
  } catch (e) {}
  return '';
}

/**
 * Get file extension from mime type (basic map)
 */
function getExtensionFromMime(mime) {
  if (!mime) return '';
  const m = mime.toLowerCase();
  if (m.indexOf('jpeg') !== -1 || m.indexOf('jpg') !== -1) return 'jpg';
  if (m.indexOf('png') !== -1) return 'png';
  if (m.indexOf('gif') !== -1) return 'gif';
  if (m.indexOf('bmp') !== -1) return 'bmp';
  if (m.indexOf('webp') !== -1) return 'webp';
  if (m.indexOf('tiff') !== -1) return 'tiff';
  return '';
}

function fillMainSub_fillDown_withGeneral(sheetName) {
    /**
   * Fill down main_niche and sub_niche, but first set sub_niche = "General"
   * for any row that has a main_niche but an empty sub_niche.
   *
   * Call this BEFORE you build `rows`. After calling, re-read the sheet data.
   */
  const lastCol = sheetName.getLastColumn();
  const lastRow = sheetName.getLastRow();
  if (lastRow < 2) return;

  // tolerant header lookup
  const headers = sheetName.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const norm = s => String(s || '').trim().toLowerCase().replace(/[_\s]+/g, '');
  const cMain = headers.findIndex(h => norm(h) === 'mainniche' || norm(h) === 'main_niche' || norm(h) === 'main');
  const cSub  = headers.findIndex(h => norm(h) === 'subniche'  || norm(h) === 'sub_niche'  || norm(h) === 'sub');

  if (cMain === -1 || cSub === -1) {
    Logger.log('Headers main_niche or sub_niche not found. Aborting fill-down.');
    return;
  }

  const dataRange = sheetName.getRange(2, 1, lastRow - 1, lastCol);
  const data = dataRange.getValues();

  // Step 1: where main exists but sub is blank, set sub = "General"
  for (let i = 0; i < data.length; i++) {
    const mainVal = String(data[i][cMain] || '').trim();
    const subVal  = String(data[i][cSub]  || '').trim();
    if (mainVal && !subVal) {
      data[i][cSub] = 'General';
    }
  }

  // Step 2: fill down main and sub (now with 'General' set where appropriate)
  let lastMain = '';
  let lastSub = '';

  for (let i = 0; i < data.length; i++) {
    const curMain = String(data[i][cMain] || '').trim();
    const curSub  = String(data[i][cSub]  || '').trim();

    // main: inherit lastMain if empty
    if (curMain) {
      lastMain = curMain;
    } else if (lastMain) {
      data[i][cMain] = lastMain;
    }

    // sub: inherit lastSub if empty
    if (curSub) {
      lastSub = curSub;
    } else if (lastSub) {
      data[i][cSub] = lastSub;
    }
  }

  // write back once
  dataRange.setValues(data);
  Logger.log('Filled main_niche/sub_niche with General for main rows missing sub, then filled down.');
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
        Logger.log('Failed to merge child index ' + i + ': ' + e2);
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
        Logger.log('Failed to merge child index ' + i + ': ' + e2);
      }
    }
  }

  // Save target doc (sourceDoc left as-is)
  targetDoc.saveAndClose();
}


/**
 * Enhanced filler: fills known tokens, removes leftover {{...}} tokens, and cleans empty paragraphs.
 * Does NOT call saveAndClose(); caller should save/close after this function returns.
 */
function fillSubDocFromData(subDoc, main, sub, items) {
  const body = subDoc.getBody();

  // === 1) Basic replacements ===
  // body.replaceText('{{MainNiche}}', main);
  body.replaceText('{{SubNiche}}', sub);

  // Keywords: use first row's keywordsRaw (split into up to 20)
  const kwRaw = (items[0] && items[0].keywordsRaw) ? items[0].keywordsRaw : '';
  const kws = kwRaw ? kwRaw.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [];
  for (let k = 1; k <= 20; k++) {
    body.replaceText(`{{Keyword${k}}}`, kws[k - 1] || '');
  }

  // For image slots 1..9: replace review token, hide product link token, insert image if available
  for (let s = 1; s <= 9; s++) {
    const revToken = `{{ReviewCount${s}}}`;
    const linkToken = `{{ProductLink${s}}}`;
    const imgToken = `{{Image${s}}}`;
    const item = items[s - 1] || null;

    // visible review count
    body.replaceText(revToken, item ? (item.reviews || '') : '');

    // remove visible product link token (we attach link to image instead)
    body.replaceText(linkToken, '');

    // Insert image at placeholder if both placeholder exists and item has screenshot
    if (item && item.screenshot) {
      const found = body.findText(imgToken);
      if (found) {
        try {
          const rangeElem = found;
          const el = rangeElem.getElement();
          if (typeof rangeElem.getStartOffset === 'function' && typeof rangeElem.getEndOffset === 'function' && el.editAsText) {
            el.asText().deleteText(rangeElem.getStartOffset(), rangeElem.getEndOffset());
          } else {
            body.replaceText(imgToken, '');
          }

          // Find paragraph / table-cell parent to insert image into
          let parent = el.getParent();
          while (parent && parent.getType && parent.getType() !== DocumentApp.ElementType.TABLE_CELL && parent.getType() !== DocumentApp.ElementType.PARAGRAPH && parent.getType() !== DocumentApp.ElementType.BODY_SECTION) {
            parent = parent.getParent();
          }
          let para;
          if (parent && parent.getType && parent.getType() === DocumentApp.ElementType.TABLE_CELL) {
            para = parent.asTableCell().appendParagraph('');
          } else if (parent && parent.getType && parent.getType() === DocumentApp.ElementType.PARAGRAPH) {
            para = parent.asParagraph();
          } else {
            para = body.appendParagraph('');
          }

          // fetch blob (Drive id or URL)
          let blob = null;
          try {
            if (/^https?:\/\//.test(item.screenshot)) {
              const resp = UrlFetchApp.fetch(item.screenshot, { muteHttpExceptions: true });
              if (resp.getResponseCode && resp.getResponseCode() === 200) blob = resp.getBlob();
            } else {
              blob = DriveApp.getFileById(item.screenshot).getBlob();
            }
          } catch (e) {
            blob = null;
            Logger.log('Image fetch failed for ' + item.screenshot + ' : ' + e);
          }

          if (blob) {
            const img = para.appendInlineImage(blob);
            img.setWidth(200);
            if (item.link) {
              try { img.setLinkUrl(item.link); } catch (e) {
                // fallback invisible link
                const f = para.appendParagraph('');
                const t = f.appendText(' ').setFontSize(1).setForegroundColor('#ffffff');
                try { t.setLinkUrl(item.link); } catch (e2) {}
              }
            }
          }
        } catch (err) {
          Logger.log('Image insertion error for ' + imgToken + ': ' + err);
        }
      } else {
        // placeholder not found in this doc - ignore
      }
    } else {
      // no item or no screenshot: remove the placeholder so it doesn't remain visible later
      body.replaceText(imgToken, '');
    }
  } // end slots

  // === 2) Remove any leftover {{...}} tokens globally ===
  // This removes any placeholder tokens that didn't get data (e.g. {{Keyword17}}, {{Image8}} etc.)
  try {
    body.replaceText('\\{\\{[^}]+\\}\\}', ''); // regex: matches {{...}}
  } catch (e) {
    Logger.log('Failed global token cleanup: ' + e);
  }

  // === 3) Cleanup: remove empty paragraphs (trim whitespace) to avoid blank lines ===
  // iterate backwards so removing children doesn't shift indexes
  for (let i = body.getNumChildren() - 1; i >= 0; i--) {
    const child = body.getChild(i);
    if (child.getType && child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const txt = child.asParagraph().getText();
      if (!txt || txt.trim() === '') {
        try {
          body.removeChild(child);
        } catch (e) {
          // ignore remove error
        }
      }
    }
  }

  // NOTE: do NOT call subDoc.saveAndClose() here; caller will handle that
}

// SpreadsheetApp.getUi().alert('Export complete.');