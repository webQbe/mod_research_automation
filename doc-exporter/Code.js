// Add menu on open
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merch Export')
    .addItem('Export Docs by Main Niche', 'buildAndMergeByMainNiche')
    .addToUi();
}


function buildAndMergeByMainNiche() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('raw_data');
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "raw_data" not found.'); return; }

  // Fill down main+sub until next non-empty
  fillMainSub_fillDown_withGeneral(sheet);
  
  // Ensure images are saved to Drive and drive_image_file_id columns are written first
  saveImagesForSheet();
  
  // re-read the sheet now that drive_image_file_id values may exist
  const data = sheet.getDataRange().getValues();
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
    const mainCopyFile = DriveApp.getFileById(TEMPLATE_ID).makeCopy(docName);
    if (OUTPUT_FOLDER_ID) {
      DriveApp.getFolderById(OUTPUT_FOLDER_ID).addFile(mainCopyFile);
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
      const subFile = DriveApp.getFileById(TEMPLATE_ID).makeCopy(subCopyName);
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
}

/**
   * Fill down main_niche and sub_niche, but first set sub_niche = "General"
   * for any row that has a main_niche but an empty sub_niche.
   *
   * Call this BEFORE you build `rows`. After calling, re-read the sheet data.
*/
function fillMainSub_fillDown_withGeneral(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // tolerant header lookup
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const norm = s => String(s || '').trim().toLowerCase().replace(/[_\s]+/g, '');
  const cMain = headers.findIndex(h => norm(h) === 'mainniche' || norm(h) === 'main_niche' || norm(h) === 'main');
  const cSub  = headers.findIndex(h => norm(h) === 'subniche'  || norm(h) === 'sub_niche'  || norm(h) === 'sub');
  if (cMain === -1 || cSub === -1) {
      Logger.log('Headers main_niche or sub_niche not found. Aborting fill-down.');
      return;
  }

  const dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
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


/**
 * Main wrapper: reads image references from the active spreadsheet (sheet "raw_data")
 * column "image_url", saves images to folder OUTPUT_FOLDER_ID ('' = My Drive),
 * and writes back saved file id + url into columns "drive_image_file_id" and "drive_image_url".
 */
function saveImagesForSheet() {
  const SPREADSHEET_ID = '1iA1KF07W6yds3YwxnCAZl25XLTO7iHmluKJGT5OvYak'; // your spreadsheet id (same you used earlier)
  const SHEET_NAME = 'raw_data';
  const SOURCE_COL_NAME = 'image_url';
  const OUT_FILEID_COL = 'drive_image_file_id';
  // const OUT_FILEURL_COL = 'drive_image_url';
  const OUTPUT_FOLDER_ID = '1_xWlhf8bjqESX58e7DdqO7mVmMUu3vYC'; // set folder id or '' to use My Drive root

  saveImagesFromSheet({
    spreadsheetId: SPREADSHEET_ID,
    sheetName: SHEET_NAME,
    sourceColHeader: SOURCE_COL_NAME,
    outFileIdHeader: OUT_FILEID_COL,
    // outFileUrlHeader: OUT_FILEURL_COL,
    folderId: OUTPUT_FOLDER_ID,
    skipIfAlreadySaved: true,   // if true, row with saved_file_id will be skipped
    delayMs: 300                // delay between requests to avoid throttle
  });
}


/**
 * Generic function: reads a given column of a sheet, downloads or copies images and saves them to folder,
 * and writes back file id and url into two output columns.
 *
 * options:
 *  - spreadsheetId
 *  - sheetName
 *  - sourceColHeader
 *  - outFileIdHeader
 *  - outFileUrlHeader
 *  - folderId ('' => root My Drive)
 *  - skipIfAlreadySaved (default true)
 *  - delayMs (default 300)
 */
function saveImagesFromSheet(options) {
  const ss = SpreadsheetApp.openById(options.spreadsheetId);
  const sheet = ss.getSheetByName(options.sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + options.sheetName);

  const startRow = 2;
  const delayMs = options.delayMs || 300;
  const skipIfAlreadySaved = options.skipIfAlreadySaved === undefined ? true : !!options.skipIfAlreadySaved;

  // --- Ensure headers exist and compute indexes ---
  let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  let srcIdx = headers.indexOf(options.sourceColHeader);
  let outIdIdx = headers.indexOf(options.outFileIdHeader);
  let outUrlIdx = headers.indexOf(options.outFileUrlHeader);

  // must have source column
  if (srcIdx === -1) throw new Error('Source column header not found: ' + options.sourceColHeader);

  // append missing out columns (one by one) and then re-read headers
  let appended = false;
  if (outIdIdx === -1) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(options.outFileIdHeader);
    appended = true;
  }
  if (outUrlIdx === -1) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(options.outFileUrlHeader);
    appended = true;
  }
  if (appended) {
    // re-read headers and recompute indexes so we have correct column positions
    headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    srcIdx = headers.indexOf(options.sourceColHeader);
    outIdIdx = headers.indexOf(options.outFileIdHeader);
    outUrlIdx = headers.indexOf(options.outFileUrlHeader);
  }

  const outIdCol = outIdIdx + 1; // 1-based
  const outUrlCol = outUrlIdx + 1;

  // --- read data rows ---
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) {
    Logger.log('No data rows to process.');
    return;
  }
  const data = sheet.getRange(startRow, 1, lastRow - (startRow - 1), sheet.getLastColumn()).getValues();

  const folder = (options.folderId && options.folderId.trim()) ? DriveApp.getFolderById(options.folderId) : DriveApp.getRootFolder();
  const results = [];

  Logger.log('Processing ' + data.length + ' rows; source col index (0-based)=' + srcIdx + '; outIdCol=' + outIdCol);

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const sourceVal = String(row[srcIdx] || '').trim();
    const existingSavedId = String(row[outIdIdx] || '').trim();

    // Skip empty source
    if (!sourceVal) {
      results.push([existingSavedId || '', String(row[outUrlIdx] || '') || '']);
      continue;
    }

    // Optionally skip if already saved
    if (skipIfAlreadySaved && existingSavedId) {
      results.push([existingSavedId, String(row[outUrlIdx] || '') || '']);
      continue;
    }

    try {
      let createdFile = null;

      // strategy: copy drive id, or base64 data uri, or fetch http(s)
      const driveId = extractDriveFileId(sourceVal);
      if (driveId) {
        try {
          const srcFile = DriveApp.getFileById(driveId);
          createdFile = srcFile.makeCopy(`${srcFile.getName()} (copy)`, folder);
        } catch (e) {
          Logger.log('Drive copy failed for id ' + driveId + ': ' + e);
        }
      }

      if (!createdFile && /^data:image\/[a-zA-Z+]+;base64,/.test(sourceVal)) {
        const matches = sourceVal.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
        if (matches) {
          const mime = matches[1];
          const b64 = matches[2];
          const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, `image_row_${r+startRow}.${getExtensionFromMime(mime)}`);
          createdFile = folder.createFile(blob);
        }
      }

      if (!createdFile && /^https?:\/\//i.test(sourceVal)) {
        try {
          const resp = UrlFetchApp.fetch(sourceVal, { muteHttpExceptions: true, followRedirects: true });
          if (resp.getResponseCode && resp.getResponseCode() === 200) {
            const blob = resp.getBlob();
            const ext = getExtensionFromMime(blob.getContentType()) || guessExtensionFromUrl(sourceVal) || 'jpg';
            createdFile = folder.createFile(blob).setName(`image_row_${r+startRow}.${ext}`);
          } else {
            Logger.log('Failed fetch (code ' + resp.getResponseCode() + ') for url: ' + sourceVal);
          }
        } catch (e) {
          Logger.log('UrlFetchApp.fetch error for ' + sourceVal + ': ' + e);
        }
      }

      if (!createdFile) {
        Logger.log('Could not create file for row ' + (r + startRow) + ': ' + sourceVal);
        results.push([existingSavedId || '', String(row[outUrlIdx] || '') || '']);
      } else {
        const fid = createdFile.getId();
        // const furl = createdFile.getUrl ? createdFile.getUrl() : `https://drive.google.com/open?id=${fid}`;
        // results.push([fid, furl]);
        results.push([fid]);
        Logger.log('Saved file for row ' + (r + startRow) + ': ' + fid);
      }
    } catch (err) {
      Logger.log('Unexpected error on row ' + (r + startRow) + ': ' + err);
      results.push([existingSavedId || '', String(row[outUrlIdx] || '') || '']);
    }

    Utilities.sleep(delayMs);
  } // end rows

  // --- write back results (after loop) ---
  // sanitize shape
  const sanitized = results.map(r => {
    if (!Array.isArray(r)) return [String(r || ''), ''];
    return [String(r[0] || ''), String(r[1] || '')];
  });

  if (sanitized.length === 0) {
    Logger.log('No results to write back after processing. Nothing to update.');
  } else {
    const lastNeededRow = startRow + sanitized.length - 1;
    if (sheet.getMaxRows() < lastNeededRow) {
      sheet.insertRowsAfter(sheet.getMaxRows(), lastNeededRow - sheet.getMaxRows());
    }
    // write to the two columns (outIdCol and outUrlCol)
    const outRange = sheet.getRange(startRow, outIdCol, sanitized.length, 2);
    outRange.setValues(sanitized);
    Logger.log('Wrote ' + sanitized.length + ' rows to columns ' + outIdCol + ' and ' + (outIdCol + 1));
  }

  Logger.log('Image save pass complete. Processed ' + results.length + ' rows.');
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
 * Try to guess extension from url path
 */
function guessExtensionFromUrl(url) {
  try {
    const m = url.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
    if (m) return m[1].toLowerCase();
  } catch (e) {}
  return '';
}


// SpreadsheetApp.getUi().alert('Export complete.');