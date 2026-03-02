

### Config

#### `doc-exporter/` module

`Config.gs` file:
```
// CONFIG - set these
const TEMPLATE_ID = 'Doc_template_id';      // <-- put your template ID here
const OUTPUT_FOLDER_ID = ''; // optional: folder to store final main docs (leave '' to put in My Drive)
const SPREADSHEET_ID = 'google_sheet_id';

```


`.clasp.json` file:
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