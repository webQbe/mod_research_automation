// ---------- doPost ----------
function doPost(e){
  try {
    if (!e || !e.postData || !e.postData.contents) return jsonOut({ ok:false, error:'No POST body' }, 400);
    const payload = JSON.parse(e.postData.contents || '{}');

    // token check
    const token = payload.token || '';
    if (SECRET_TOKEN && token !== SECRET_TOKEN) return jsonOut({ ok:false, error:'Invalid token' }, 403);

    const searchTerm = (payload.search_term || '').toString().trim();
    if (!searchTerm) return jsonOut({ ok:false, error:'search_term is required' }, 400);

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    _ensureHeaderRowExists(sheet);
    const folder = _getOrCreateFolder();

    // Parent row values (A..G)
    const id = Utilities.getUuid();
    const mainNiche = payload.main_niche || '';
    const subNiche = payload.sub_niche || '';
    const keywords = payload.keywords || '';
    const parentRow = [ id, mainNiche, subNiche, searchTerm, keywords, '', '' ];
    sheet.appendRow(parentRow);
    const sheetRow = sheet.getLastRow();

    // Prepare results block: write to rows sheetRow .. sheetRow + max - 1
    const scrapedArr = Array.isArray(payload.scrapeResult) ? payload.scrapeResult : (Array.isArray(payload.results) ? payload.results : []);
    const maxToWrite = Math.min(MAX_RESULTS_TO_WRITE, scrapedArr.length || 0);

    // Build rows for H..L (5 columns per result)
    const rowsToWrite = [];
    const statusUpdates = []; // for column F
    const nowIso = new Date().toISOString();

    for (let i = 0; i < MAX_RESULTS_TO_WRITE; i++) {
      const r = scrapedArr[i] || {};
      const link = r.link || '';
      const price = r.price || '';
      const reviewCount = (r.reviewCount !== undefined && r.reviewCount !== null) ? String(r.reviewCount) : '';
      const capturedAt = r.capturedAt || nowIso;

      let fileId = '';
      let fileViewUrl = '';

      if (r.image) {
        try {
          const {id:fileIdRes, viewUrl:fileViewUrlRes} = _fetchAndSaveImageReturnBoth(r.image, folder, `${searchTerm}_r${i+1}`);
          fileId = fileIdRes || '';
          fileViewUrl = fileViewUrlRes || '';
        } catch (err) {
          fileId = '';
          fileViewUrl = '';
        }
      }

      rowsToWrite.push([ link, price, reviewCount, capturedAt, fileId ]);

      // status for this row (F column)
      const status = fileId ? 'Done' : 'no-image';
      statusUpdates.push({
        range: `${SHEET_NAME}!F${sheetRow + i}`,
        values: [[ status ]]
      });
    }

    // If rowsToWrite length < MAX_RESULTS_TO_WRITE, pad with empty rows so block is rectangular
    while (rowsToWrite.length < MAX_RESULTS_TO_WRITE) {
      rowsToWrite.push(['', '','', '','', '']);
      statusUpdates.push({
        range: `${SHEET_NAME}!F${sheetRow + rowsToWrite.length - 1}`,
        values: [[ 'no-result' ]]
      });
    }

    // Write block H{sheetRow}:M{endRow}
    const startCol = _colToLetter(8); // H
    const endCol = _colToLetter(12);  // L
    const endRow = sheetRow + rowsToWrite.length - 1;
    const rangeBlock = `${SHEET_NAME}!${startCol}${sheetRow}:${endCol}${endRow}`;
    sheet.getRange(rangeBlock).setValues(rowsToWrite);

    // Batch update statuses for column F
    // ---------- Write statuses for column F (fixed indexing) ----------
    // rowsToWrite elements: [ link, price, reviewCount, capturedAt, fileId ]
    // So fileId is at index 4 (0-based)
    const fileIdIndex = 4;
    const statusVals = rowsToWrite.map(r => {
      const fileId = (Array.isArray(r) ? r[fileIdIndex] : '');
      return [ fileId ? 'Done' : 'no-image' ];
    });

    // sheetRow is the starting row for the results we wrote
    const statusStartRow = sheetRow;
    const statusNumRows = statusVals.length;
    if (statusNumRows > 0) {
      // column 6 => F
      sheet.getRange(statusStartRow, 6, statusNumRows, 1).setValues(statusVals);
    }

    // Also set parent-row status (F at sheetRow) to 'Done' if at least one fileId exists among written rows
    const anyFileId = rowsToWrite.some(r => Array.isArray(r) && !!r[fileIdIndex]);
    sheet.getRange(`${SHEET_NAME}!F${sheetRow}`).setValue(anyFileId ? 'Done' : 'no-image');

    // Fix the summary mapping in the response: link is r[0], fileId is r[4]
    return jsonOut({
      ok: true,
      version: WEBHOOK_VERSION,
      sheetRow,
      writtenRows: rowsToWrite.length,
      summary: rowsToWrite.map((r, idx) => ({ rank: idx+1, link: r[0] || null, fileId: r[4] || null }))
    }, 200);

  } catch (err) {
    return jsonOut({ ok:false, error: String(err), stack: err && err.stack ? err.stack : '' }, 500);
  }
} 

// ---------- helpers ----------
function jsonOut(obj) {
  const out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

function _ensureHeaderRowExists(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.getRange(1,1,1,HEADER_ROW.length).setValues([HEADER_ROW]);
    return;
  }
  const existing = sheet.getRange(1,1,1,HEADER_ROW.length).getValues()[0];
  let needsWrite = false;
  for (let i=0;i<HEADER_ROW.length;i++){
    if ((existing[i]||'').toString().trim() !== HEADER_ROW[i]) { needsWrite = true; break; }
  }
  if (needsWrite) sheet.getRange(1,1,1,HEADER_ROW.length).setValues([HEADER_ROW]);
}

function _getOrCreateFolder() {
  if (FOLDER_ID && FOLDER_ID.length) {
    try { return DriveApp.getFolderById(FOLDER_ID); } catch(e){ /* fallthrough */ }
  }
  const it = DriveApp.getFoldersByName(OUTPUT_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(OUTPUT_FOLDER_NAME);
}

function _fetchAndSaveImageReturnBoth(imageUrl, folder, baseName) {
  const res = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true, followRedirects: true });
  if (!res || res.getResponseCode() !== 200) throw new Error('Image fetch failed status=' + (res ? res.getResponseCode() : 'no-res'));
  const blob = res.getBlob();
  const ext = _guessExtension(blob.getContentType(), imageUrl);
  const safe = (baseName||'img').replace(/[^a-z0-9_\-]/ig,'_').substring(0,60) + '.' + ext;
  const file = _getOrCreateFolder().createFile(blob.setName(safe));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return { id: file.getId(), viewUrl: `https://drive.google.com/uc?export=view&id=${file.getId()}` };
}

function _guessExtension(contentType, url) {
  if (contentType) {
    if (contentType.indexOf('jpeg') !== -1) return 'jpg';
    if (contentType.indexOf('png') !== -1) return 'png';
    if (contentType.indexOf('gif') !== -1) return 'gif';
  }
  const m = (url||'').match(/\.([a-z0-9]{2,4})(?:\?|$)/i);
  if (m) return m[1].toLowerCase();
  return 'png';
}

function _colToLetter(col) {
  let letter = '';
  while (col>0) {
    const mod = (col-1)%26;
    letter = String.fromCharCode(65+mod) + letter;
    col = Math.floor((col-1)/26);
  }
  return letter;
} 