require('dotenv').config(); // npm i dotenv

// ---------- config (adjust columns indexes to match your sheet) ----------
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';

// read all rows (header + rows)
async function readAllRows(sheets) {
  const range = `${SHEET_NAME}!A1:Z`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const values = res.data.values || [];
  const header = values[0] || [];
  const rows = values.slice(1);
  return { header, rows };
}

/**
 * claimPendingRowsDedup
 *
 * - Reads the whole sheet.
 * - Finds the first occurrence (top-most) of each non-empty searchTerm.
 * - For rows with status === 'pending':
 *     - If the row is the first occurrence -> claim it (set status 'in-progress')
 *     - Otherwise -> mark it 'skipped-duplicate (row X)' where X is the first-occurrence row
 * - Returns an array of claimed rows: { sheetRow, rowValues }
 */
async function claimPendingRowsDedup(sheets, maxToClaim = 5) {
  const COL_SEARCH_TERM = 4; // D
  const COL_STATUS = 6;      // F

  const { header, rows } = await readAllRows(sheets); // must return header + rows[]
  const firstOcc = Object.create(null);

  // Map first occurrence (sheet row number) for each normalized term
  for (let i = 0; i < rows.length; i++) {
    const sheetRow = i + 2;
    const raw = (rows[i][COL_SEARCH_TERM - 1] || '').toString().trim();
    const term = raw ? raw.toLowerCase() : '';
    if (!term) continue;
    if (!firstOcc[term]) firstOcc[term] = sheetRow;
  }

  const toClaim = [];
  const toSkipUpdates = [];

  const { colToLetter } = require('./sheet-worker.js');
  
  for (let i = 0; i < rows.length; i++) {
    const sheetRow = i + 2;
    const status = (rows[i][COL_STATUS - 1] || '').toString().trim().toLowerCase();
    if (status !== 'pending') continue;

    const raw = (rows[i][COL_SEARCH_TERM - 1] || '').toString().trim();
    const term = raw ? raw.toLowerCase() : '';

    if (!term) {
      toSkipUpdates.push({
        range: `${SHEET_NAME}!${colToLetter(COL_STATUS)}${sheetRow}`,
        values: [['error: no search term']]
      });
      continue;
    }

    const firstRow = firstOcc[term] || sheetRow;
    if (firstRow === sheetRow) {
      if (toClaim.length < maxToClaim) {
        toClaim.push({ sheetRow, rowValues: rows[i] });
      }
      // else leave it pending for next run
    } else {
      const note = `skipped-duplicate of row ${firstRow}`;
      toSkipUpdates.push({
        range: `${SHEET_NAME}!${colToLetter(COL_STATUS)}${sheetRow}`,
        values: [[ note ]]
      });
    }
  }

  // mark in-progress for claimed rows
  if (toClaim.length > 0) {
    const claimData = toClaim.map(c => ({
      range: `${SHEET_NAME}!${colToLetter(COL_STATUS)}${c.sheetRow}`,
      values: [['in-progress']]
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: claimData }
    });
  }

  // write skipped-duplicate statuses
  if (toSkipUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: toSkipUpdates }
    });
  }

  // return claimed rows with consistent property name `sheetRow`
  return toClaim.map(p => ({ sheetRow: p.sheetRow, rowValues: p.rowValues }));
}


// claimRows.js (export)
module.exports = { claimPendingRowsDedup };