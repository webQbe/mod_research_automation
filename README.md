

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
```