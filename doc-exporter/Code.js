// Add menu on open
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Merch Export')
    .addItem('Export Docs by Main Niche', 'buildAndMergeByMainNiche')
    .addToUi();
}


function buildAndMergeByMainNiche() {
  SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('raw_data');
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "raw_data" not found.'); return; }
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) { SpreadsheetApp.getUi().alert('No data rows in raw_data.'); return; }

  const header = data[0].map(h=>String(h).trim());
  const rows = data.slice(1);
  const idx = name => header.indexOf(name);

  const colMain = idx('main_niche');
  const colSub = idx('sub_niche');
  const colScreenshot = idx('screenshot_id_or_url');
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