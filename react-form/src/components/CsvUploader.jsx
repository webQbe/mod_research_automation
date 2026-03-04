
import {useState, useRef} from 'react';
import Papa from 'papaparse';

function CsvUploader({ token, setError, setResult }) {
  // CSV/upload UI state
  const [csvPreview, setCsvPreview] = useState([]);
  const [csvChunksTotal, setCsvChunksTotal] = useState(0);
  const [csvChunksDone, setCsvChunksDone] = useState(0);
  const [csvRunning, setCsvRunning] = useState(false);
  const fileRef = useRef(null);
  
  const RUN_BULK_ENDPOINT = import.meta.env.VITE_RUN_BULK_ENDPOINT || 'http://localhost:3001/api/run-bulk';

   // ----- CSV parsing & mapping helpers -----
  function mapRowToNiche(row, headerMap) {
    // `row` is object keyed by header name as parsed by Papa with header:true
    // headerMap maps normalized header name -> original header
    const get = (keys) => {
      for (const k of keys) {
        const hk = headerMap[k];
        if (hk && row[hk] !== undefined && row[hk] !== null && String(row[hk]).trim() !== '') return String(row[hk]).trim();
      }
      return '';
    };
    return {
      main_niche: get(['main_niche','main niche','main','category']),
      sub_niche: get(['sub_niche','sub niche','sub','subcategory']),
      keywords: get(['keywords','keyword','tags','search_terms'])
    };
  }

  // normalize header names to a lookup map: normalized -> original
  function buildHeaderMap(headers) {
    const map = {};
    headers.forEach(h => {
      if (!h) return;
      const n = String(h).trim().toLowerCase();
      map[n] = h;
      // also map some variants
      map[n.replace(/\s+/g,'_')] = h;
    });
    return map;
  }

  // ----- CSV file select handler (preview only) -----
  function handleFileSelect(e) {
    setCsvPreview([]);
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      preview: 5, // preview first 5 rows
      skipEmptyLines: true,
      complete: (results) => {
        setCsvPreview(results.data || []);
      },
      error: (err) => {
        console.error('CSV parse error', err);
        setError('CSV parse error: ' + err.message);
      }
    });
  }

  // ----- CSV upload & chunked POST -----
  async function handleCsvUpload(e) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
    if (!file) {
      setError('Select a CSV file first');
      return;
    }

    // parse full CSV (header:true)
    setCsvRunning(true);
    setCsvChunksDone(0);
    setCsvChunksTotal(0);

    try {
      const parsed = await new Promise((resolve, reject) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => resolve(res),
          error: (err) => reject(err),
        });
      });

      const rows = parsed.data || [];
      if (!rows.length) throw new Error('CSV has no rows');

      // build header map to map various header names to expected fields
      const headerMap = buildHeaderMap(parsed.meta.fields || Object.keys(rows[0] || {}));

      // convert parsed rows into normalized niche objects
      const niches = rows.map(r => mapRowToNiche(r, headerMap));

      // chunking parameters
      const chunkSize = 100; // adjust - 100 rows per chunk is a good starting point
      const chunks = [];
      for (let i=0;i<niches.length;i += chunkSize) chunks.push(niches.slice(i, i + chunkSize));

      setCsvChunksTotal(chunks.length);

      // POST each chunk sequentially (or concurrently limited) to RUN_BULK_ENDPOINT
      // sequential to avoid DoS on local dev; if you want concurrency, add a pool
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // payload shape expected by your server: { token, niches: [ ... ] }
        const payload = { token: token.trim() || '', niches: chunk };

          const resp = await fetch(RUN_BULK_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Chunk ${i+1}/${chunks.length} upload failed: ${txt || resp.status}`);
        }

        setCsvChunksDone(i+1);
        // optional short delay to be polite to server
        await new Promise(r => setTimeout(r, 150));
      }

      setResult({ ok:true, message: `Uploaded ${niches.length} rows in ${chunks.length} chunks` });
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
    } finally {
      setCsvRunning(false);
    }
  }


  return (
    <section style={{marginTop:18, border:'1px solid #eee', padding:16, borderRadius:8}}>
        <h2>Bulk upload (CSV)</h2>
        <p>CSV header should include columns like <code>main_niche</code>, <code>sub_niche</code>, <code>keywords</code>. The uploader maps common header variants automatically.</p>

        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFileSelect} />
        <div style={{marginTop:8}}>
          <button onClick={handleCsvUpload} disabled={csvRunning} style={{padding:'8px 12px', marginRight:8}}>
            {csvRunning ? 'Uploading...' : 'Upload CSV and Start' }
          </button>
          <button onClick={() => { fileRef.current && (fileRef.current.value = null); setCsvPreview([]); setCsvChunksTotal(0); setCsvChunksDone(0); }} style={{padding:'8px 8px'}}>
            Clear
          </button>
        </div>

        <div style={{marginTop:12}}>
          <strong>Preview:</strong>
          <pre style={{whiteSpace:'pre-wrap', background:'#fafafa', padding:8, border:'1px dashed #eee'}}>
            {csvPreview.length ? JSON.stringify(csvPreview, null, 2) : 'No file selected / preview empty'}
          </pre>
        </div>

        <div style={{marginTop:8}}>
          {csvChunksTotal > 0 && (
            <div>Chunks: {csvChunksDone} / {csvChunksTotal} {csvRunning ? '(running)' : csvChunksDone === csvChunksTotal ? '(done)' : ''}</div>
          )}
        </div>
      </section>
  );
}

export default CsvUploader; // Default export