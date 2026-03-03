

### Config

#### `doc-exporter/` module

`doc-exporter/Config.gs` file:
```
// CONFIG - set these
const TEMPLATE_ID = 'Doc_template_id';      // <-- put your template ID here
const OUTPUT_FOLDER_ID = ''; // optional: folder to store final main docs (leave '' to put in My Drive)
const SPREADSHEET_ID = 'google_sheet_id';
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

#### `poc-worker/` module
`poc-worker/.env` file:
  ```
  HEADLESS=0
  SPREADSHEET_ID=google_sheet_id
  SHEET_NAME=raw_data
  PORT=8080
  WEBHOOK_URL=webhook_appsscript_url
  WEBHOOK_TOKEN=supersecret123
  ```

#### `data-receiver/` module

`data-receiver/Config.js` file:
```
  // ---------- CONFIG ----------
  const SPREADSHEET_ID = 'google_sheet_id';
  const SHEET_NAME = 'raw_data';
  const OUTPUT_FOLDER_NAME = 'scraper_images';
  const FOLDER_ID = 'drive_folder_id'; // optional
  const SECRET_TOKEN = 'supersecret123';
  const MAX_RESULTS_TO_WRITE = 5; // up to N results written to subsequent rows

  const WEBHOOK_VERSION = 'v2.1-20260129';

  // Header A..L
  const HEADER_ROW = ['id','main_niche','sub_niche''search_term','keywords','status','Error','product_link','price','review_count','captured_at','drive_image_file_id'];
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

#### `react-form/` module
`react-form/.env` file:
```
VITE_SCRAPER_ENDPOINT="http://localhost:8080/api/run-scrape"
```