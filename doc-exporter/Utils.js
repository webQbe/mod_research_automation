function log(msg) {
  Logger.log(msg);
  appendExportLog(msg);
}

/**
 * Mark duplicate rows in the "results" sheet by ASIN found in the link column (col D).
 * Keeps the row with the lowest numeric rank (col B) and writes "DUPLICATE" into column J (notes)
 * for the other duplicate rows.
 *
 * Behavior/details:
 * - Header is expected in row 1.
 * - Sheet name: "results".
 * - Columns (1-based): A parent_id, B rank, C title, D link, E price, F review_count, G notes (will be modified), ...
 * - ASIN is matched by the pattern "/dp/ASIN" (standard 10-char ASIN). Adjust regex if you need to support other patterns.
 * - If a notes cell already contains text, "DUPLICATE" will be appended (separated by " | ") unless "DUPLICATE" is already present.
 * - Rows without a matching ASIN are left unchanged.
 */
function dedupeResultsByASINMark() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('results');
  if (!sheet) {
    log('Sheet "results" not found.');
    return;
  }

  const HEADER_ROWS = 1;
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROWS) {
    log('No data rows to process.');
    return;
  }

  const lastCol = sheet.getLastColumn();
  const dataRange = sheet.getRange(HEADER_ROWS + 1, 1, lastRow - HEADER_ROWS, lastCol);
  const values = dataRange.getValues(); // 2D array of rows

  // Regex to match ASIN after "/dp/". ASINs are typically 10 alphanumeric chars.
  const asinRegex = /\/dp\/([A-Za-z0-9]{10})/i;

  // Map asin -> { bestIndex: data-array-index, bestRank: number }
  const asinMap = {};
  const rowsToMark = [];

  for (let i = 0; i < values.length; i++) {
    const row = values[i];

    // rank is column B -> index 1
    let rawRank = row[1];
    let rank = Number.POSITIVE_INFINITY;
    if (typeof rawRank === 'number' && !isNaN(rawRank)) {
      rank = rawRank;
    } else if (rawRank != null && String(rawRank).trim() !== '') {
      const parsed = parseFloat(String(rawRank).replace(/[^\d.\-]/g, ''));
      if (!isNaN(parsed)) rank = parsed;
    }

    // link is column D -> index 3
    const link = row[3] ? String(row[3]) : '';
    const m = link.match(asinRegex);
    if (!m) {
      // no ASIN -> skip
      continue;
    }
    const asin = m[1].toUpperCase();

    if (!(asin in asinMap)) {
      asinMap[asin] = { bestIndex: i, bestRank: rank };
    } else {
      const existing = asinMap[asin];
      if (rank < existing.bestRank) {
        // current row is better (lower rank). Mark previous best for marking,
        // and update map to keep current row as best.
        rowsToMark.push(HEADER_ROWS + 1 + existing.bestIndex);
        asinMap[asin] = { bestIndex: i, bestRank: rank };
      } else {
        // current row is worse (or equal) -> mark current for marking
        rowsToMark.push(HEADER_ROWS + 1 + i);
      }
    }
  }

  if (rowsToMark.length === 0) {
    log('No duplicates found by ASIN.');
    return 0;
  }

  // Convert to a set of 0-based data-array indices for easier updates
  const markRowNumsSet = new Set(rowsToMark.map(r => r - (HEADER_ROWS + 1))); // indices into values[]

  // Prepare notes column updates (column J = 10)
  const notesColIndex = 9; // zero-based index in values[] (A=0 -> G=9)
  const notesUpdates = [];

  for (let i = 0; i < values.length; i++) {
    let currentNote = values[i][notesColIndex];
    if (currentNote == null) currentNote = '';
    else currentNote = String(currentNote);

    if (markRowNumsSet.has(i)) {
      // If note already contains DUPLICATE (case-insensitive), do nothing; otherwise append or set.
      if (!/DUPLICATE/i.test(currentNote)) {
        currentNote = currentNote.trim() === '' ? 'DUPLICATE' : (currentNote + ' | DUPLICATE');
      }
    }
    notesUpdates.push([currentNote]); // must be 2D array for setValues
  }

  // Write notes back in one bulk operation to column J rows (HEADER_ROWS+1 .. lastRow)
  const notesRange = sheet.getRange(HEADER_ROWS + 1, notesColIndex + 1, notesUpdates.length, 1);
  notesRange.setValues(notesUpdates);

  log('Marked ' + markRowNumsSet.size + ' duplicate rows by ASIN (wrote to column J).');
  return markRowNumsSet.size;
}


function appendExportLog(msg) {
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName('export_log') || ss.insertSheet('export_log');
    const tz = Session.getScriptTimeZone();
    const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, msg]);
  } catch (e) {
    // fallback to Logger if sheet write fails
    log('appendExportLog failed: ' + e + ' — original msg: ' + msg);
  }
}

// Safe property helpers
function getExportState() {
  const p = PropertiesService.getScriptProperties().getProperty('MERCH_EXPORT_STATE_v1');
  return p ? JSON.parse(p) : null;
}

function setExportState(state) {
  PropertiesService.getScriptProperties().setProperty('MERCH_EXPORT_STATE_v1', JSON.stringify(state));
}

function clearExportState() {
  PropertiesService.getScriptProperties().deleteProperty('MERCH_EXPORT_STATE_v1');
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

/**
   * Fill down main_niche and sub_niche, but first set sub_niche = "General"
   * for any row that has a main_niche but an empty sub_niche.
   *
   * Call this BEFORE you build `rows`. After calling, re-read the sheet data.
*/
function fillMainSub_fillDown_withGeneral(sheetName) {

  const lastCol = sheetName.getLastColumn();
  const lastRow = sheetName.getLastRow();
  if (lastRow < 2) return;

  // tolerant header lookup
  const headers = sheetName.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const norm = s => String(s || '').trim().toLowerCase().replace(/[_\s]+/g, '');
  const cMain = headers.findIndex(h => norm(h) === 'mainniche' || norm(h) === 'main_niche' || norm(h) === 'main');
  const cSub  = headers.findIndex(h => norm(h) === 'subniche'  || norm(h) === 'sub_niche'  || norm(h) === 'sub');

  if (cMain === -1 || cSub === -1) {
    log('Headers main_niche or sub_niche not found. Aborting fill-down.');
    return;
  }

  const dataRange = sheetName.getRange(2, 1, lastRow - 1, lastCol);
  const data = dataRange.getValues();

  // Step 1: where main exists but sub is blank, set sub = "General"
  for (let i = 0; i < data.length; i++) {
    const mainVal = String(data[i][cMain] || '').trim();
    const subVal  = String(data[i][cSub]  || '').trim();
    if (mainVal && !subVal || subVal === '-') {
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
  log('Filled main_niche/sub_niche with General for main rows missing sub, then filled down.');
}