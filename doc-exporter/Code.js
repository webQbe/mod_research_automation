

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

// SpreadsheetApp.getUi().alert('Export complete.');