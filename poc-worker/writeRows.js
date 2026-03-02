/**
 * writeResultsRows()
 *
 * sheets: authorized google sheets client (google.sheets({version:'v4', auth}))
 * spreadsheetId: your SPREADSHEET_ID
 * sheetName: name of sheet (e.g. 'raw_data')
 * sheetRow: starting row for results (e.g. 24) -> writes rows sheetRow .. sheetRow+4
 * scrapedResults: array of result objects (preferably up to 5), each { image, link, price, reviewCount }
 * numResultsToWrite: number of rows to write (default 5)
 */
async function writeResultsRows(sheets, spreadsheetId, sheetName, sheetRow, scrapedResults, numResultsToWrite = 5) {
  sheetRow = Number(sheetRow);
  if (!Number.isInteger(sheetRow) || sheetRow <= 0) throw new Error('Invalid sheetRow passed to writeResultsRows');
  
  // Ensure scrapedResults is an array
  scrapedResults = Array.isArray(scrapedResults) ? scrapedResults : [];
  const startRow = sheetRow;
  const endRow = sheetRow + numResultsToWrite - 1;
  const nowIso = new Date().toISOString();


  // Build values for columns H..N (H=8 .. N=14 => 7 columns)
  // We'll place: [ H:image, I:link, J:price, K:review_count, L: captured_at ]
  const rows = [];
  for (let i = 0; i < numResultsToWrite; i++) {
    const r = scrapedResults[i] || {};
    const image = r.image || '';           // H
    const link = r.link || '';             // I
    const price = r.price || '';           // J
    const reviewCount = (r.reviewCount !== undefined && r.reviewCount !== null) ? String(r.reviewCount) : ''; // K
    const capturedAt = r.capturedAt || nowIso; // L (use any scraped timestamp else now)

    rows.push([ image, link, price, reviewCount, capturedAt ]);
  }

  // Write the block H{startRow}:L{endRow}
  const rangeBlock = `${sheetName}!H${startRow}:L${endRow}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: rangeBlock,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // Update statuses in column F (6) for each corresponding row
  // We'll set 'done' if we had a result at that index, otherwise 'no-result'
  const statusUpdates = [];
  for (let i = 0; i < numResultsToWrite; i++) {
    const rowNum = startRow + i;
    const status = scrapedResults[i] ? 'done' : 'no-result';
    statusUpdates.push({
      range: `${sheetName}!F${rowNum}`,
      values: [[ status ]]
    });
  }

  // Batch update statuses
  if (statusUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: statusUpdates
      }
    });
  }

  return { startRow, endRow, written: numResultsToWrite };
}

// writeRows.js (export)
module.exports = { writeResultsRows };