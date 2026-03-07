# Market Research & Export Pipeline

Automated product-research + export pipeline: a Playwright-based scraper that pushes structured listing data to a webhook, a webhook service that deduplicates and stores results in Google Sheets and Drive, and an Apps Script exporter that composes consolidated Google Docs (plus a Master Index).

---

## Project description

This project scrapes Amazon marketplace listings, post-processes results (dedupe, image similarity, filtering), stores rows in Google Sheets and uploads images to Drive, and finally exports grouped research into Google Docs using Apps Script. The exporter supports grouping up to **10 main-niches per combined document** and creates a **Master Index** linking all combined docs.

---

## Core functionality (expanded)

* **Scraper (`poc-worker`)**

  * Playwright-based headless browser scraper.
  * Builds search terms from configurable main-niche / sub-niche / styles / intents.
  * `buildSearchTerm(main, sub)` omits `main` from the query when:
    * (a) `sub` is non-blank **and** `main` contains two or more tokens (e.g. `"Ball Games"`), **or**
    * (b) any token from `main` appears as a substring inside `sub`.
  * Suffix rotation is index-based (`idx`) for consistent, reproducible term variation.
  * Robust location-modal wait-helper ensures the location prompt is fully dismissed before scraping begins.
  * Scrapes the **full first page** of results (all visible listing cards).
  * Results are **sorted and filtered by average rating and review count** before being emitted.
  * Large result payloads are **chunked and sent to the webhook sequentially** to avoid size-limit errors.
  * Deduplicates listings (image-similarity using `jimp`).
  * Controlled concurrency + modal handling + retry on network issues.
  * Generates debug artifacts (screenshots, HTML snippets) for troubleshooting.

* **Webhook & Processing (`data-receiver`)**

  * Scraper POSTs found rows to a webhook endpoint.
  * Webhook filters suspicious/fake review counts and persists to Google Sheets.
  * Sheet layout has been **split into two separate tabs**:
    * **Tasks sheet** — tracks scraping jobs and their status.
    * **Results sheet** — stores individual product listing rows.
  * Webhook logic updated to write to the correct sheet for each data type.
  * Saves product images to Google Drive and writes Drive file IDs to the Results sheet.

* **React Form frontend (`react-form`)**

  * A small React app provides a web form to create scraping jobs without editing CSVs manually.
  * Collects: API token (or job token), main niche, optional sub-niche, search keywords, and advanced options (concurrency, location).
  * Supports CSV upload for bulk niche lists.
  * Posts a JSON job to the scraper  and receives a job id/acknowledgement.
  * Optionally polls for job status or displays a success message + job link.

* **Export Layer (`doc-exporter`)**

  * Apps Script reads the **Results sheet** (reflecting the Tasks/Results split) and groups rows by main_niche → sub_niche.
  * `Export.processBatch()` now:
    * Groups tasks by `search_term`.
    * Filters duplicate rows (ASIN-based; see Deduplication below).
    * Sorts remaining rows by `review_count` descending within each group.
    * Takes the **top 9 results** per `search_term`.
    * Creates a **temporary sub-doc per `search_term`**, then merges these into the main-niche doc.
  * For each main_niche, creates main-niche docs (kept in My Drive root).
  * Merges up to 10 main-niches into one **Combined** doc (stored in `OUTPUT_FOLDER_ID`).
  * Creates a **Master Index** doc (stored in `OUTPUT_FOLDER_ID`) linking all combined docs and listing mains/sub-niches.
  * Implements **robust blob fetching and validation** when inserting Drive images into Docs (retries malformed or missing blobs before failing gracefully).
  * Exporter runs in **batches** and uses incremental merge chunks to avoid Apps Script execution timeouts.
  * Document rendering (token replacements, image insertion) is isolated in its own module.
  * Blank sub-niches are normalized to `General`.

* **Deduplication (`doc-exporter` / sheet menu)**

  * Product links are checked against ASINs extracted from URLs.
  * Duplicate rows in the Results sheet are **marked** (not deleted) using ASIN matching, preserving the original data for auditing.
  * `dedupeResultsByASINMark()` is exposed as a **sheet menu item** so it can be run manually at any time before export.
  * The export pipeline also respects these marks when selecting rows, ensuring no duplicate products appear in the output docs.

---

## Getting started

### Prerequisites

* Node.js 14+ for the scraper & webhook.
* Yarn or npm.
* A Google Workspace account with permission to use Drive, Sheets, and Docs.
* Enable Google Docs API (Apps Script Advanced Service) if you want to set pageless programmatically.

### Local quickstart (scraper + webhook)

1. Clone repo and `cd` into `/poc-worker` and `/data-receiver` as needed.
2. `yarn install` (or `npm install`).
3. Configure environment variables:

    - ####  `doc-exporter/` module

      `doc-exporter/Config.gs` file:
      ```
      // CONFIG - set these
      const docTemplateId = 'google_doc_id';    
      const outputFolderId = 'drive_folder_id'; 
      const spreadsheetId = 'google_sheet_id'
      const EXPORT_STATE_PROP = 'MERCH_EXPORT_STATE_v1'; 
      const DEFAULT_BATCH_SIZE = 8; 
      const MERGE_STATE_KEY = 'MERGE_CHUNKS_STATE_v1'; 
      ```

      `doc-exporter/.clasp.json` file:
      ```
      {
        "scriptId": "your_appsscript_id",
        "rootDir": "",
        "projectId": "merchexport", // Attach GCP project
        "scriptExtensions": [
          ".js",
          ".gs"
        ],
        "htmlExtensions": [
          ".html"
        ],
        "jsonExtensions": [
          ".json"
        ],
        "filePushOrder": []
      }
      ```

    - #### `poc-worker/` module
      `poc-worker/.env` file:
        ```
        PORT=8080
        BULK_PORT=3001
        WEBHOOK_URL=https://script.google.com/macros/s/script_id/exec
        WEBHOOK_TOKEN=supersecret123
        MAX_ZIP_RETRIES=5
        CLIENT_TOKEN=from-form
        PLAYWRIGHT_CONCURRENCY=2
        FORWARD_MAX_BATCH=10
        FORWARD_CONCURRENCY=1
        ```

    - #### `data-receiver/` module

      `data-receiver/Config.js` file:
      ```
      // ---------- CONFIG ----------
      const SPREADSHEET_ID = 'google_sheet_id';
      const TASKS_SHEET = 'tasks';
      const RESULTS_SHEET = 'results';
      const OUTPUT_FOLDER_NAME = 'scraper_images';
      const FOLDER_ID = 'drive_folder_id'; 
      const WEBHOOK_TOKEN = 'supersecret123';
      const MAX_RESULTS_TO_WRITE = 52; // all results in first page
      const WEBHOOK_VERSION = 'version_number';
      ```


      `data-receiver/.clasp.json` file:
      ```
      {
        "scriptId": "your_appsscript_id",
        "rootDir": "",
        "scriptExtensions": [
          ".js",
          ".gs"
        ],
        "htmlExtensions": [
          ".html"
        ],
        "jsonExtensions": [
          ".json"
        ],
        "filePushOrder": [],
        "skipSubdirectories": false
      }
      ```
4. Run the scraper server: `npm start`
5. Submit tasks to webhook to run the scraper worker.

### Frontend quickstart (`react-form/` module)

1. `cd react-form/`
2. `yarn install` or `npm install`
3. Create `.env`:
    ```
    VITE_SCRAPER_ENDPOINT="http://localhost:8080/api/run-scrape"
    VITE_RUN_BULK_ENDPOINT="http://localhost:3001/api/run-bulk"
    ```
4. `npm run dev` to run dev server

### Apps Script setup

1. Open the Apps Script project (`doc-exporter`) bound to your Spreadsheet (or create a new standalone project and copy files).
2. Paste the `.gs` files (`Config.gs`, `Utils.gs`, `Export.gs`, `Merge.gs`, `Docs.gs`) into the script editor.
3. Confirm the **tasks** and **results** sheet names match the constants defined in the webhook (`data-receiver/Config.gs`).
4. Enable the Docs Advanced Service for `doc-exporter` (Apps Script Editor → Services → add **Docs API**) and enable **Google Docs API** in the Cloud Console if you need pageless toggling.
5. Save and authorize scopes when prompted.

---

## Typical workflow

1. Use the React form (or CSV upload) to submit jobs to the webhook.
2. Scraper runs, builds search terms (omitting redundant main-niche tokens where applicable), scrapes the full first page, sorts/filters by rating and review count, then chunks and POSTs results to the webhook.
3. Webhook persists job metadata to the **Tasks sheet** and product rows to the **Results sheet**; images get uploaded and Drive file IDs are written to the Results sheet.
4. Click `Merch Export > Dedup by ASIN` in sheet menu to flag ASIN duplicates before export.
5. Run `startExport()` from Apps Script UI (menu item: `Export Docs`) to begin document creation; this will:

   * Fill down `main_niche` and `sub_niche` (normalize blank sub to `General`),
   * Group tasks by `search_term`, filter marked duplicates, sort by `review_count` descending, and take top 9 per term,
   * Create temp sub-docs per `search_term`, then merge into main-niche docs (left in root),
   * Batch combine mains (up to 10 per combined doc) into docs inside `OUTPUT_FOLDER_ID`,
   * Create Master Index doc inside `OUTPUT_FOLDER_ID`.

---

## Configuration options & tuning

* `DEFAULT_BATCH_SIZE` — number of main-niches processed per Apps Script run. For stability start with `1` and increase once stable.
* `EXPORT_STATE_PROP` — script property key for persistent run state.
* `MERGE_STATE_KEY` — script property key for merge-chunks state.
* `setPageless`, `trashSources` — optional flags for merge behavior (toggle for debug).
* **Top-N per search term** — currently hard-coded to `9` in `Export.processBatch()`; adjust in `Config.gs` if needed.

---

## Troubleshooting & tips

* **Execution timeouts:** Use incremental batching (as implemented) and keep `DEFAULT_BATCH_SIZE` low if you hit timeouts.
* **Drive/Docs errors:** temporarily disable pageless and trashing while debugging; enable them after stabilization.
* **Missing images in Docs:** verify Drive file permissions and that `drive_image_file_id` was written to the Results sheet. The exporter now retries blob fetches automatically, but persistent failures indicate a permissions issue.
* **Sheet name mismatches:** ensure the Tasks sheet and Results sheet tab names exactly match the constants in `Config.gs`; a mismatch will cause the webhook and exporter to write to or read from the wrong tabs.
* **ASIN deduplication:** if duplicate products appear in output docs, run `dedupeResultsByASINMark()` from the sheet menu before re-running the export.
* **Logs for triggers:** use Apps Script **Executions** panel; for persistent logging add `appendExportLog()` to write messages to a sheet.
* **State recovery:** use `stopExportAndClearState()` to clear persisted state and delete triggers if you want to restart.

---

## Development notes (recent refactor)

* The codebase (`doc-exporter`) was modularized: shared helpers moved to `Utils.gs`, constants to `Config.gs`, orchestrator logic to `Export.gs`, and merge logic to `Merge.gs`.
* Document rendering logic is separated into `Docs.gs`. This improves maintainability and makes it easier to test pieces in isolation.
* The single Review sheet was split into **Tasks sheet** (job tracking) and **Results sheet** (product rows). All webhook and exporter code has been updated accordingly.
* `buildSearchTerm` was updated with smarter main-niche omission logic and index-based suffix rotation.
* Scraper now handles the location modal robustly, scrapes the full first page, and ships results pre-sorted/filtered to reduce downstream processing.
* Large scraper payloads are chunked before sending to avoid webhook payload limits.
* ASIN-based duplicate marking was added both as a sheet menu utility and as a pre-filter step in the export pipeline.
* `Export.processBatch()` now creates temporary sub-docs per `search_term` rather than writing all results into one pass, improving doc structure and making failures easier to isolate.
* Blob fetching in `Docs.gs` is now wrapped with retry and validation logic to handle transient Drive errors gracefully.
* React Form added to allow job submission and CSV upload for bulk jobs.

---

## Contributing

1. Fork the repo.
2. Create a feature branch: `git checkout -b feat/your-feature`.
3. Add tests / run manual checks.
4. Open a pull request with a clear description and changelog entry.

**Suggested commit message patterns**:

* `feat: add incremental merge worker`
* `fix: avoid Apps Script timeout by lowering batch size`
* `refactor: move state helpers to Utils.gs`

---

## Security & operational notes

* Keep API keys and credentials out of source control. Use environment variables or a secure vault.
* Scraping third-party marketplaces may violate terms of service; check the site's TOS before scraping at scale.
* Use reasonable scraping rates, proxied requests if needed, and handle CAPTCHAs ethically.
* For the React form, do not store long-lived tokens in localStorage.

---

## License

```
MIT License
Copyright (c) 2026 Webcube Automation Labs
```

---