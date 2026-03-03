import React, { useState } from 'react';

export default function ScraperForm() {
  const [mainNiche, setMainNiche] = useState('');
  const [subNiche, setSubNiche] = useState('');
  const [keywords, setKeywords] = useState('');
  const [token, setToken] = useState(''); // optional client token (if you choose)
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const endpoint = import.meta.env.VITE_SCRAPER_ENDPOINT || '/run-scrape';

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);

    // simple validation
    if (!mainNiche && !subNiche && !keywords) {
      setError('Give at least one of main niche, sub niche or keywords.');
      return;
    }

    setLoading(true);
    try {
      // Build payload - server will build searchTerm (or you can build here)
      const payload = {
        token: token.trim() || '',       // optional client token (not the webhook secret)
        main_niche: mainNiche.trim(),
        sub_niche: subNiche.trim(),
        keywords: keywords.trim()
      };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = { ok: resp.ok, text }; }

      if (!resp.ok) throw new Error(data.error || data.text || `HTTP ${resp.status}`);

      setResult(data);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{maxWidth:640,margin:'1rem auto',padding:16,border:'1px solid #eee',borderRadius:8}}>
      <h2>Run Scraper</h2>

      <label style={{display:'block',margin:'8px 0'}}>
        Main niche:
        <input value={mainNiche} onChange={e=>setMainNiche(e.target.value)} placeholder="e.g. Fitness" style={{width:'100%'}} />
      </label>

      <label style={{display:'block',margin:'8px 0'}}>
        Sub niche:
        <input value={subNiche} onChange={e=>setSubNiche(e.target.value)} placeholder="e.g. Trainer" style={{width:'100%'}} />
      </label>

      <label style={{display:'block',margin:'8px 0'}}>
        Keywords (comma separated):
        <input value={keywords} onChange={e=>setKeywords(e.target.value)} placeholder="e.g. vintage, cool" style={{width:'100%'}} />
      </label>

      <label style={{display:'block',margin:'8px 0'}}>
        Client token:
        <input value={token} onChange={e=>setToken(e.target.value)} placeholder="" style={{width:'100%'}} />
      </label>

      <div style={{marginTop:12}}>
        <button type="submit" disabled={loading} style={{padding:'8px 12px'}}>
          {loading ? 'Running...' : 'Run Scraper'}
        </button>
      </div>

      {error && <div style={{color:'crimson',marginTop:12}}>Error: {error}</div>}

      {result && (
        <pre style={{whiteSpace:'pre-wrap', background:'#f7f7f7', padding:12, marginTop:12}}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </form>
  );
}