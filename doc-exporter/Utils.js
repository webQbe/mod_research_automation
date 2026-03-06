function log(msg) {
  Logger.log(msg);
  appendExportLog(msg);
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
