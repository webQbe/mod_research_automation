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
            log('Image fetch failed for ' + item.screenshot + ' : ' + e);
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
          log('Image insertion error for ' + imgToken + ': ' + err);
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
    log('Failed global token cleanup: ' + e);
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