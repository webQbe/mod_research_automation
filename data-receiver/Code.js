// ---------- doPost ----------
function doPost(e) {
  // Acquire script-level lock to serialize sheet/drive writes
  const lock = LockService.getScriptLock();
  const got = lock.tryLock(30000); // wait up to 30s
  if (!got) {
    return jsonOut({ ok:false, error: 'Server busy, please retry' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ ok:false, error: 'No POST body' });
    }
    const payload = JSON.parse(e.postData.contents);

    // token check
    if (WEBHOOK_TOKEN && payload.token !== WEBHOOK_TOKEN) {
      return jsonOut({ ok:false, error:'Invalid token' }, 403);
    }

    const mainNiche = payload.main_niche || '';
    const subNiche = payload.sub_niche || '';
    const keywords = payload.keywords || '';
    const searchTerm = (payload.search_term || '').toString().trim();
    if (!searchTerm) {
      return jsonOut({ ok:false, error: 'search_term required' }, 400);
    }

    const scrapedArr = Array.isArray(payload.scrapeResult) ? payload.scrapeResult : [];

    const ss = ensureSheetsAndHeaders();

    // Append parent/task row to tasks sheet
    const tasksSheet = ss.getSheetByName(TASKS_SHEET);
    const parentId = Utilities.getUuid();
    const createdAt = new Date().toISOString();
    const parentRow = [ parentId, mainNiche, subNiche, searchTerm, keywords, 'in-progress', '', createdAt ];
    tasksSheet.appendRow(parentRow);
    const parentRowNum = tasksSheet.getLastRow();

    // Build results rows for results sheet
    const resultsSheet = ss.getSheetByName(RESULTS_SHEET);
    const resultRows = []; // each row: [parent_id, rank, title, link, price, review_count, drive_file_id, drive_view_url, captured_at]

    for (let i = 0; i < scrapedArr.length; i++) {
      const r = scrapedArr[i] || {};
      const rank = r.rank || (i+1);
      const title = r.title || '';
      const link = r.link || '';
      const price = r.price || '';
      const reviewCount = r.reviewCount || r.reviewCountFormatted || '';
      const capturedAt = r.capturedAt || new Date().toISOString();

      let fileId = '';
      let viewUrl = '';
      // If payload includes image_base64 prefer that
      if (r.image_base64) {
        const out = _saveImageAndReturn({ imageBase64: r.image_base64, filenameBase: `${parentId}_r${rank}` });
        fileId = out.id || '';
        viewUrl = out.viewUrl || '';
      } else if (r.image) {
        const out = _saveImageAndReturn({ imageUrl: r.image, filenameBase: `${parentId}_r${rank}` });
        fileId = out.id || '';
        viewUrl = out.viewUrl || '';
      }

      resultRows.push([ parentId, rank, title, link, price, reviewCount, fileId, viewUrl, capturedAt ]);
    }

    // Write result rows in one setValues call if there are any
    if (resultRows.length > 0) {
      const startRow = resultsSheet.getLastRow() + 1;
      resultsSheet.getRange(startRow, 1, resultRows.length, resultRows[0].length).setValues(resultRows);
    }

    // Update parent status to 'Done' if at least one result row was saved, else 'no-result'
    const anySaved = resultRows.length > 0;
    tasksSheet.getRange(parentRowNum, 6).setValue(anySaved ? 'Done' : 'no-result');

    // Optionally write count into parent notes column
    tasksSheet.getRange(parentRowNum, 7).setValue(`results:${resultRows.length}`);

    // Return helpful response
    return jsonOut({
      ok: true,
      version: WEBHOOK_VERSION,
      parentId,
      sheetRow: parentRowNum,
      resultsWritten: resultRows.length
    });

  } catch (err) {
    return jsonOut({ ok:false, error: String(err), stack: err && err.stack ? err.stack : '' });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ---------- helpers ----------
function jsonOut(obj, code) {
  const out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  if (code) {
    // Apps Script doesn't support setting HTTP status directly in doPost return value.
    // But returning JSON with code is fine. Platform sets 200 by default.
  }
  return out;
}

function _ensureHeaderRowExists(ss, sheetName, headerRow) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
  } else {
    // if header missing or different, write/overwrite
    const existing = sheet.getRange(1,1,1, headerRow.length).getValues()[0];
    let needs = false;
    for (let i=0;i<headerRow.length;i++) {
      if ((existing[i]||'').toString().trim() !== headerRow[i]) { needs = true; break; }
    }
    if (needs) sheet.getRange(1,1,1, headerRow.length).setValues([headerRow]);
  }
}

function _getOrCreateFolderByName(name, optionalId) {
  try {
    if (optionalId) return DriveApp.getFolderById(optionalId);
  } catch(e) {}
  const it = DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(name);
}

// Save an image either from a URL or from base64 payload:
// returns { id, viewUrl }
function _saveImageAndReturn({ imageUrl, imageBase64, filenameBase = 'img' }) {
  const folder = _getOrCreateFolderByName(OUTPUT_FOLDER_NAME);
  let blob;
  try {
    if (imageBase64) {
      // imageBase64 should be raw base64 (no data: prefix) or allow data: prefix
      const raw = String(imageBase64);
      const base = raw.indexOf('base64,') !== -1 ? raw.split('base64,')[1] : raw;
      const bytes = Utilities.base64Decode(base);
      blob = Utilities.newBlob(bytes, 'image/png', filenameBase);
    } else if (imageUrl) {
      const res = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true });
      if (res.getResponseCode() !== 200) throw new Error('Image fetch failed status=' + res.getResponseCode());
      blob = res.getBlob();
      // set a filename
      blob.setName(filenameBase);
    } else {
      return { id: '', viewUrl: '' };
    }

    const file = folder.createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
    return { id: file.getId(), viewUrl: `https://drive.google.com/uc?export=view&id=${file.getId()}` };
  } catch (err) {
    // return blank on error so webhook doesn't crash
    return { id: '', viewUrl: '' };
  }
}

function ensureSheetsAndHeaders() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  _ensureHeaderRowExists(ss, TASKS_SHEET, ['id','main_niche','sub_niche','search_term','keywords','status','notes','created_at']);
  _ensureHeaderRowExists(ss, RESULTS_SHEET, ['parent_id','rank','title','link','price','review_count','drive_file_id','drive_view_url','captured_at']);
  return ss;
}