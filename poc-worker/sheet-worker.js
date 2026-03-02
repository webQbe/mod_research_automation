const { google } = require('googleapis');
require('dotenv').config(); // npm i dotenv

// require your scraper - make sure amazon-scrape.js exports runPlaywrightFor
const { runPlaywrightFor } = require('./amazon-scrape');

// For writing scraped results for a search-term found
const { writeResultsRows } = require('./writeRows');
// For Skipping duplicate searchTerms
const { claimPendingRowsDedup } = require('./claimRows');


// ---------- config (adjust columns indexes to match your sheet) ----------
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';

if (!SPREADSHEET_ID) throw new Error('Set SPREADSHEET_ID env var');

// Columns (1-based)
// A id, B main_niche, C sub_niche, D search_term, E status, F notes, then G+ for results
const COL_SEARCH_TERM = 4;   // column D
const COL_STATUS = 6;        // column F
const COL_NOTES = 12;         // column L
const FIRST_RESULT_COL = 7;  // column G - we'll write results here: title|link|price|reviews per result

const MAX_RESULTS_TO_SCRAPE = 3; // how many results to store per row

// ---------- Sheets auth ----------
async function authSheets() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function colToLetter(col) {
  let letter = '';
  while (col > 0) {
    const mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// write status and optional note
async function updateRowStatus(sheets, sheetRow, newStatus, note) {
  const updates = [{
    range: `${SHEET_NAME}!${colToLetter(COL_STATUS)}${sheetRow}`,
    values: [[newStatus]],
  }];
  if (note !== undefined) {
    updates.push({
      range: `${SHEET_NAME}!${colToLetter(COL_STATUS)}${sheetRow}`,
      values: [[note]],
    });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
  });
}

// write results (title|link|price|reviews) into columns starting at FIRST_RESULT_COL
async function writeResultsIntoRow(sheets, sheetRow, scrapedResults) {
  // We'll flatten up to MAX_RESULTS_TO_SCRAPE results into columns:
  // For result i: columns: title_i, link_i, price_i, reviews_i (4 columns per result)
  const cells = [];
  for (let i = 0; i < MAX_RESULTS_TO_SCRAPE; i++) {
    const r = scrapedResults[i];
    if (r) {
      cells.push(r.title || '');
      cells.push(r.link || '');
      cells.push(r.price || '');
      cells.push(r.reviewCount || '');
    } else {
      // empty placeholders
      cells.push('', '', '', '');
    }
  }
  const endCol = FIRST_RESULT_COL + cells.length - 1;
  const range = `${SHEET_NAME}!${colToLetter(FIRST_RESULT_COL)}${sheetRow}:${colToLetter(endCol)}${sheetRow}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [cells] },
  });
}

// ---------- Main flow ----------
async function processClaimedRows() {
  const sheets = await authSheets(); // your existing auth helper
  const claimed = await claimPendingRowsDedup(sheets, /*maxToClaim=*/ 5);
  console.log('Claimed rows:', claimed.map(c => c.sheetRow));

  if (!claimed || claimed.length === 0) {
    console.log('No pending rows to process.');
    return;
  }

  for (const item of claimed) {
    const sheetRow = Number(item.sheetRow);
    const rowValues = item.rowValues || [];

    if (!Number.isInteger(sheetRow) || sheetRow <= 1) {
      console.warn('Skipping invalid sheetRow:', sheetRow);
      continue;
    }

    try {
      const searchTerm = String(rowValues[3] || '').trim(); // column D (index 3)
      if (!searchTerm) {
        // update the claimed row status to error
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!G${sheetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [['error: no search term']] }
        });
        continue;
      }

      console.log(`Processing sheet row ${sheetRow} term="${searchTerm}"`);

      // Run the scraper (this should return an array of results)
      const scraped = await runPlaywrightFor(searchTerm); // returns up to N results

      // Ensure scraped is an array
      const scrapedArr = Array.isArray(scraped) ? scraped : [];

      // Write results into rows sheetRow .. sheetRow+4 (H..N) and statuses F
      await writeResultsRows(sheets, SPREADSHEET_ID, SHEET_NAME, sheetRow, scrapedArr, 5);

      // Optionally update the originating row's F-column (status) to 'done'
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!F${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['done']] }
      });

      console.log(`Row ${sheetRow} processed and results written to H${sheetRow}:L${sheetRow + 4}`);
    } catch (err) {
      console.error(`Error processing row ${sheetRow}:`, err.message || err);
      // Write error status to the claimed row's F (or E) column to record failure
      const stamp = new Date().toISOString();
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!G${sheetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`error: ${String(err).slice(0,120)} @ ${stamp}`]] }
      });
    }
  }
}

// call it (if this is your main file)
if (require.main === module) {
  processClaimedRows().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

// sheet-worker.js (export)
module.exports = { colToLetter };