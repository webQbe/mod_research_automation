/*
 * Fill a sub-document from an array of result items.
 *
 * Expected `items` shape (as produced by processBatch topResults):
 *  [{ title, link, price, review_count, drive_file_id, drive_view_url, captured_at, rank, parent_id }, ...]
 *
 * Notes:
 * - If items[0].keywordsRaw exists we'll still use it for {{KeywordN}} tokens; otherwise keywords are empty.
 * - Image source preference: drive_file_id -> extract file id from drive_view_url -> direct URL fetch.
 * - Writes images inline and sets link on the image (if item.link present).
 * - Replaces review tokens with item.review_count.
 * - Removes {{ProductLinkN}} tokens (we attach link to the image instead).
 * - Removes leftover {{...}} tokens and strips empty paragraphs.
 * - robust blob fetching and validation (drive_file_id → drive_view_url extraction → screenshot fallback)
 * - a small link row is added under the image with "View product" (links to item.link) and "View image" (links to item.drive_view_url or a constructed Drive view URL from drive_file_id)
 * Do NOT call subDoc.saveAndClose() here; caller will handle that.
 */
function fillSubDocFromData(subDoc, main, sub, items) {
  const body = subDoc.getBody();

  // === 1) Basic replacements ===
  body.replaceText('{{SubNiche}}', sub);

  const kwRaw = (items[0] && items[0].keywordsRaw) ? items[0].keywordsRaw : '';
  const kws = kwRaw ? kwRaw.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [];
  for (let k = 1; k <= 20; k++) {
    body.replaceText(`{{Keyword${k}}}`, kws[k - 1] || '');
  }

  for (let s = 1; s <= 9; s++) {
    const revToken = `{{ReviewCount${s}}}`;
    const linkToken = `{{ProductLink${s}}}`;
    const imgToken = `{{Image${s}}}`;
    const item = items[s - 1] || null;

    const revText = item && (item.review_count !== undefined && item.review_count !== null) ? String(item.review_count) : '';
    body.replaceText(revToken, revText);
    body.replaceText(linkToken, '');

    if (item && (item.drive_file_id || item.drive_view_url || item.screenshot)) {
      const found = body.findText(imgToken);
      if (found) {
        const rangeElem = found;
        const el = rangeElem.getElement();

        // remove placeholder text in-place if possible
        try {
          if (typeof rangeElem.getStartOffset === 'function' && typeof rangeElem.getEndOffset === 'function' && el.editAsText) {
            el.asText().deleteText(rangeElem.getStartOffset(), rangeElem.getEndOffset());
          } else {
            body.replaceText(imgToken, '');
          }
        } catch (e) {
          body.replaceText(imgToken, '');
        }

        // find a paragraph/table-cell parent to append image into
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

        // fetch blob (prefer drive_file_id; try extracting id from view url; fallback to screenshot URL)
        let blob = null;
        let blobSourceDesc = null;
        try {
          if (item.drive_file_id) {
            try {
              blob = DriveApp.getFileById(item.drive_file_id).getBlob();
              blobSourceDesc = 'drive_file_id:' + item.drive_file_id;
            } catch (eDriveId) {
              log('Drive file fetch by id failed for ' + item.drive_file_id + ': ' + eDriveId);
              blob = null;
              blobSourceDesc = null;
            }
          }

          if (!blob && item.drive_view_url) {
            const m = String(item.drive_view_url).match(/\/d\/([a-zA-Z0-9_-]{10,})/);
            const idFromView = m ? m[1] : null;
            if (idFromView) {
              try {
                blob = DriveApp.getFileById(idFromView).getBlob();
                blobSourceDesc = 'extracted_from_view:' + idFromView;
              } catch (e2) {
                log('Drive file fetch by extracted id failed for ' + idFromView + ': ' + e2);
                blob = null;
                blobSourceDesc = null;
              }
            }
          }

          if (!blob && item.screenshot && /^https?:\/\//.test(item.screenshot)) {
            try {
              const resp = UrlFetchApp.fetch(item.screenshot, { muteHttpExceptions: true });
              if (resp.getResponseCode && resp.getResponseCode() === 200) {
                blob = resp.getBlob();
                blobSourceDesc = 'screenshot_url';
              }
            } catch (eFetch) {
              log('UrlFetch failed for screenshot ' + item.screenshot + ': ' + eFetch);
              blob = null;
              blobSourceDesc = null;
            }
          }

          if (!blob && item.drive_view_url && /^https?:\/\//.test(item.drive_view_url)) {
            try {
              const resp2 = UrlFetchApp.fetch(item.drive_view_url, { muteHttpExceptions: true });
              if (resp2.getResponseCode && resp2.getResponseCode() === 200) {
                blob = resp2.getBlob();
                blobSourceDesc = 'drive_view_url_fetch';
              }
            } catch (eFetch2) {
              log('UrlFetch failed for drive_view_url ' + item.drive_view_url + ': ' + eFetch2);
              blob = null;
              blobSourceDesc = null;
            }
          }
        } catch (e) {
          blob = null;
          blobSourceDesc = null;
          log('Image fetch unexpected error for item (' + (item.drive_file_id || item.drive_view_url || item.screenshot) + ') : ' + e);
        }

        // Check blob validity (non-null, non-zero size)
        let blobIsGood = false;
        try {
          if (blob && typeof blob.getBytes === 'function') {
            const size = (blob.getBytes() || []).length;
            if (size > 0) blobIsGood = true;
            else log('Blob fetched but size is 0 for ' + (blobSourceDesc || item.drive_view_url || item.screenshot));
          } else if (blob && typeof blob.getLength === 'function') {
            const len = blob.getLength();
            if (len > 0) blobIsGood = true;
            else log('Blob fetched but length is 0 for ' + (blobSourceDesc || item.drive_view_url || item.screenshot));
          } else if (blob) {
            blobIsGood = true;
          }
        } catch (e) {
          log('Error checking blob size: ' + e);
          blobIsGood = false;
        }

        if (blobIsGood) {
          try {
            const img = para.appendInlineImage(blob);
            try { img.setWidth(200); } catch (e) {}
            if (item.link) {
              try { img.setLinkUrl(item.link); } catch (eLinkImg) { log('Failed to set image link for product: ' + eLinkImg); }
            }
          } catch (imgErr) {
            log('Image insertion error for ' + imgToken + ' (blobSource=' + blobSourceDesc + '): ' + imgErr);
          }
        } else {
          log('Skipping image insertion for ' + imgToken + ' — no valid blob (source=' + (blobSourceDesc || 'none') + ')');
          
          // No blob — append visible link text to the SAME paragraph (Version 1 logic)
          try {
            let appended = false;
            if (item.link) {
              const t1 = para.appendText('View product');
              try { t1.setLinkUrl(item.link); } catch (e) {}
              appended = true;
            }

            const imageViewUrl = (item.drive_view_url && String(item.drive_view_url).trim()) ? String(item.drive_view_url).trim() :
                                 (item.drive_file_id ? `https://drive.google.com/file/d/${item.drive_file_id}/view?usp=sharing` : null);

            if (item.link && imageViewUrl) {
              para.appendText(' | ');
            }

            if (imageViewUrl) {
              const t2 = para.appendText('View image');
              try { t2.setLinkUrl(imageViewUrl); } catch (e) {}
              appended = true;
            }
          } catch (eLinkRow) {
            log('Failed to append link text (using appendText): ' + eLinkRow);
          }
        }

      } // end if found
    } else {
      body.replaceText(imgToken, '');
    }
  } // end slots

  // === 2) Remove leftover tokens ===
  try { body.replaceText('\\{\\{[^}]+\\}\\}', ''); } catch (e) { log('Failed global token cleanup: ' + e); }

  // === 3) Remove empty paragraphs ===
  for (let i = body.getNumChildren() - 1; i >= 0; i--) {
    const child = body.getChild(i);
    if (child.getType && child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const txt = child.asParagraph().getText();
      if (!txt || txt.trim() === '') {
        try { body.removeChild(child); } catch (e) {}
      }
    }
  }
}