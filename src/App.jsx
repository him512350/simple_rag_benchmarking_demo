import React, { useEffect, useRef, useState } from 'react';
import { LIMITS, utf8Bytes } from '../lib/limits.js';
import { rowsFromCSV, resultsCSV } from './csv.js';
import { extractPDF } from './pdf.js';
import { SAMPLE_PROMPT, SAMPLE_ROWS } from './sample.js';

const DRAFT_KEY = 'promptbench.systemPrompt';
const queued = row => ({ ...row, status: 'queued', response: '', error: '', elapsedMs: null, usage: null, truncated: false });
function initialPrompt() { try { return localStorage.getItem(DRAFT_KEY) ?? SAMPLE_PROMPT; } catch { return SAMPLE_PROMPT; } }
function OpenIcon({ expand = false }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{expand ? <path d="M8 3H3v5M3 3l7 7M16 21h5v-5M21 21l-7-7M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7" /> : <><path d="M14 3h7v7M21 3l-10 10" /><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>}</svg>;
}
async function readResponse(response) {
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an invalid response. Try again.'); }
  if (!response.ok) throw new Error(data.error || 'The request failed. Try again.');
  return data;
}

export default function App() {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [rows, setRows] = useState(() => SAMPLE_ROWS.map(queued));
  const [documents, setDocuments] = useState([]);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [search, setSearch] = useState('');
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState({ text: '', error: false });
  const [fileMeta, setFileMeta] = useState('5 example cases loaded');
  const [isSample, setIsSample] = useState(true);
  const [docNotice, setDocNotice] = useState('Uploads stay in this page until reload.');
  const [snapshot, setSnapshot] = useState(null);
  const stopRequested = useRef(false);
  const active = useRef(false);
  const controllers = useRef(new Set());
  const promptDialog = useRef(null);
  const expandedPrompt = useRef(null);
  const modelDialog = useRef(null);
  const locked = running || importing;
  const selected = documents.filter(doc => doc.selected);
  const selectedChars = selected.reduce((count, doc) => count + doc.text.length, 0);
  const done = rows.filter(row => row.status === 'done').length;
  const errors = rows.filter(row => row.status === 'error').length;
  const modelName = models.find(item => item.id === model)?.name || 'Select a model';

  async function loadModels() {
    setModelsLoading(true); setConnectionError('');
    try {
      const data = await readResponse(await fetch('/api/models'));
      if (!Array.isArray(data.models) || !data.models.length) throw new Error('No supported text models are available.');
      setModels(data.models);
      setModel(current => data.models.some(item => item.id === current) ? current : data.models.find(item => item.id === 'openai/gpt-4.1-mini')?.id || data.models[0].id);
    } catch (error) { setConnectionError(error.message); }
    finally { setModelsLoading(false); }
  }
  useEffect(() => { loadModels(); }, []);
  useEffect(() => () => { controllers.current.forEach(controller => controller.abort()); }, []);

  function resetResults() { setRows(current => current.map(queued)); setSnapshot(null); setNotice({ text: '', error: false }); }
  function changePrompt(value) {
    setPrompt(value); resetResults();
    try { localStorage.setItem(DRAFT_KEY, value); } catch { /* The editor works without storage. */ }
  }
  function report(error) { setNotice({ text: error.message, error: true }); }
  async function importCSV(event) {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || locked) return;
    setImporting(true);
    try {
      if (file.size > LIMITS.csvBytes) throw new Error('CSV must be 1 MB or smaller.');
      const data = rowsFromCSV(await file.text());
      setRows(data.map(queued)); setSnapshot(null); setIsSample(false);
      setFileMeta(`${file.name} · ${data.length} cases`); setNotice({ text: '', error: false });
    } catch (error) { report(error); }
    finally { setImporting(false); }
  }
  async function uploadDocuments(event) {
    const files = Array.from(event.target.files); event.target.value = '';
    if (!files.length || locked) return;
    setImporting(true);
    try {
      if (documents.length + files.length > LIMITS.files) throw new Error('Keep at most 10 PDFs in this page. Remove a document before adding more.');
      const added = [];
      for (const file of files) {
        const result = await extractPDF(file);
        added.push({ name: file.name, file, ...result, selected: true });
      }
      if (selectedChars + added.reduce((count, doc) => count + doc.text.length, 0) > LIMITS.contextChars) throw new Error('Selected PDF text exceeds 60,000 characters. Deselect a document before uploading more.');
      setDocuments(current => [...current, ...added.map(doc => ({ ...doc, id: crypto.randomUUID(), url: URL.createObjectURL(doc.file.slice(0, doc.file.size, 'application/pdf')) }))]);
      setDocNotice(`${added.length} PDF(s) ready. Full text is sent only when you run a benchmark.`); resetResults();
    } catch (error) { report(new Error(`Upload failed: ${error.message}`)); }
    finally { setImporting(false); }
  }
  function toggleDocument(doc, checked) {
    if (checked && selectedChars + doc.text.length > LIMITS.contextChars) return report(new Error('Selected documents must total at most 60,000 characters. Deselect another document first.'));
    setDocuments(current => current.map(item => item.id === doc.id ? { ...item, selected: checked } : item)); resetResults();
  }
  function removeDocument(doc) {
    setDocuments(current => current.filter(item => item.id !== doc.id)); URL.revokeObjectURL(doc.url); resetResults();
  }
  function patchRow(id, patch) { setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row)); }
  async function runQueue(list, reset = false) {
    if (active.current || locked) return;
    const runSnapshot = { model, systemPrompt: prompt, documentNames: selected.map(doc => doc.name), documents: selected.map(({ name, text }) => ({ name, text })) };
    try {
      if (!model || connectionError) throw new Error('Connect OpenRouter and select a model before running.');
      if (!prompt.trim() || prompt.length > LIMITS.systemChars) throw new Error('Write a system prompt of 1–12,000 characters.');
      if (selectedChars > LIMITS.contextChars) throw new Error('Selected documents exceed 60,000 characters.');
      for (const row of list) {
        if (!row.input.trim() || row.input.length > LIMITS.questionChars) throw new Error('Each question must contain 1–4,000 characters.');
        if (utf8Bytes(JSON.stringify({ model, systemPrompt: prompt, question: row.input, documents: runSnapshot.documents })) > LIMITS.requestBytes) throw new Error('The prompt, question, and documents exceed the 256 KB request limit. Select less text.');
      }
    } catch (error) { report(error); return; }
    active.current = true; stopRequested.current = false; setRunning(true); setSnapshot(runSnapshot); setNotice({ text: '', error: false });
    if (reset) setRows(current => current.map(queued));
    let next = 0;
    async function worker() {
      while (next < list.length && !stopRequested.current) {
        const row = list[next++]; const controller = new AbortController(); controllers.current.add(controller);
        patchRow(row.id, { ...queued(row), status: 'running' });
        try {
          const data = await readResponse(await fetch('/api/benchmark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: runSnapshot.model, systemPrompt: runSnapshot.systemPrompt, question: row.input, documents: runSnapshot.documents }), signal: controller.signal }));
          patchRow(row.id, { status: 'done', response: data.response, elapsedMs: data.elapsedMs, usage: data.usage, truncated: data.truncated });
        } catch (error) {
          patchRow(row.id, controller.signal.aborted ? queued(row) : { status: 'error', error: error.message });
        } finally { controllers.current.delete(controller); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, list.length) }, worker));
    active.current = false; setRunning(false);
    setNotice({ text: stopRequested.current ? 'Stopped. Unfinished cases remain queued. Requests already accepted by a provider may still be billed.' : 'Benchmark finished. Review responses and usage below.', error: false });
  }
  function stop() { stopRequested.current = true; controllers.current.forEach(controller => controller.abort()); }
  function exportResults() {
    const url = URL.createObjectURL(new Blob([resultsCSV(rows, snapshot)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'benchmark-results.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="wrap">
    <header><div><h1>Prompt <span>Bench</span></h1><p className="sub">A workspace for prompts, knowledge, and benchmark cases.</p></div><span className="meta">OpenRouter · Independent requests</span></header>
    <div className="grid"><div className="left-column">
      <section className="panel prompt-panel" aria-labelledby="sysLabel"><div className="panel-h"><span className="label" id="sysLabel">System prompt</span><div className="prompt-actions"><span className="meta" id="sysMeta">{prompt.length.toLocaleString()} chars</span><button id="expandPromptBtn" className="expand-prompt" title="Expand system prompt" aria-label="Expand system prompt" aria-haspopup="dialog" disabled={locked} onClick={() => { promptDialog.current.showModal(); expandedPrompt.current.focus(); }}><OpenIcon expand /></button></div></div><textarea id="sysPrompt" spellCheck="false" aria-labelledby="sysLabel" value={prompt} disabled={locked} onChange={event => changePrompt(event.target.value)} /></section>
      <section className="panel" aria-labelledby="knowledgeLabel"><div className="panel-h"><span className="label" id="knowledgeLabel">Knowledge base</span><span className="chip">This session only</span></div><div className="knowledge-body"><p className="sub">Upload text-based PDFs: up to 5 MB and 10 pages each. Selected full text is used for every question.</p><label className="filebtn" htmlFor="docInput">Upload PDFs<input type="file" id="docInput" multiple accept=".pdf,application/pdf" disabled={locked} onChange={uploadDocuments} /></label><div id="documents">{documents.map(doc => <div className="document" key={doc.id}><label className="document-label"><input type="checkbox" checked={doc.selected} disabled={locked} onChange={event => toggleDocument(doc, event.target.checked)} /><span>{doc.name}<small>{doc.pages} page(s) · {doc.text.length.toLocaleString()} chars</small></span></label><div className="document-actions"><a className="document-open" href={doc.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${doc.name} in a new tab`} title={`Open ${doc.name} in a new tab`}><OpenIcon /></a><button className="remove-document" disabled={locked} onClick={() => removeDocument(doc)} aria-label={`Remove ${doc.name}`}>Remove</button></div></div>)}</div>{!documents.length && <p className="sub">No documents yet. You can run with the system prompt alone.</p>}<p className="sub upload-notice" id="docNotice" role="status">{importing ? 'Reading file…' : docNotice}</p><p className="meta">{selectedChars.toLocaleString()} / 60,000 selected characters · Up to 10 PDFs. Scans and blank pages are not supported.</p></div></section>
    </div>
    <section className="panel" aria-labelledby="casesLabel"><div className="panel-h"><span className="label" id="casesLabel">Benchmark cases {isSample && <span className="sample-tag" id="sampleTag">Sample data</span>}</span><span className="meta" id="fileMeta">{fileMeta}</span></div>
      <div className="toolbar"><label className="filebtn" htmlFor="csvInput">Import CSV<input type="file" id="csvInput" accept=".csv,text/csv" disabled={locked} onChange={importCSV} /></label><button className="model-btn" id="modelBtn" disabled={locked} onClick={() => modelDialog.current.showModal()}>Change model · {modelName}</button><span className="spacer" /><button className="primary" id="runBtn" disabled={locked || modelsLoading || !model || !!connectionError || !rows.length} onClick={() => runQueue(rows, true)}>Run all</button><button id="stopBtn" disabled={!running} onClick={stop}>Stop</button><button id="exportBtn" disabled={locked || !snapshot || !rows.some(row => row.status === 'done' || row.status === 'error')} onClick={exportResults}>Export results</button></div>
      {(modelsLoading || connectionError) && <div className={`notice connection${connectionError ? ' err' : ''}`} role="status">{modelsLoading ? 'Loading OpenRouter models…' : connectionError} {!modelsLoading && <button disabled={locked} onClick={loadModels}>Retry connection</button>}</div>}
      <div className="notice context" id="contextSummary" aria-live="polite">{model || 'No model selected'} · {selected.length} document(s): {selected.map(doc => doc.name).join(', ') || 'None (prompt only)'}</div><div className="bar"><i id="progress" style={{ width: `${rows.length ? (done + errors) / rows.length * 100 : 0}%` }} /></div><div className="stats" id="stats"><span>Cases <b>{rows.length}</b></span><span>Completed <b>{done}/{rows.length}</b></span>{errors > 0 && <span>Errors <b>{errors}</b></span>}<span>Output cap <b>1,024 tokens</b></span></div>
      {notice.text && <div className={`notice${notice.error ? ' err' : ''}`} id="notice" role="status">{notice.text}</div>}
      <div className="tablewrap"><table><thead><tr>{['ID', 'Input', 'Response', 'Status', 'Time / tokens', ''].map((heading, i) => <th key={i}>{heading}</th>)}</tr></thead><tbody id="rows">{rows.map(row => <tr key={row.id}><td className="id">{row.id}</td><td className="txt">{row.input}</td><td className="resp"><div className={`resp-box${!row.response ? ' dim' : ''}`}>{row.response || (row.status === 'running' ? 'Waiting for model…' : row.status === 'error' ? 'No response' : 'Not run yet')}</div>{row.truncated && <div className="meta">Output reached the token cap.</div>}</td><td><span className={`chip ${row.status}`}>{{ queued: 'Queued', running: 'Running', done: 'Done', error: 'Error' }[row.status]}</span>{row.error && <div className="meta document-error">{row.error}</div>}</td><td className="metrics">{row.elapsedMs == null ? '—' : `${(row.elapsedMs / 1000).toFixed(2)} s`}<br />{row.usage?.total_tokens == null ? '— tokens' : `${row.usage.total_tokens} tokens`}<div className="meta">In {row.usage?.prompt_tokens ?? '—'} / Out {row.usage?.completion_tokens ?? '—'}</div></td><td className="act"><button disabled={locked || !model || !!connectionError} onClick={() => runQueue([row])}>Retry</button></td></tr>)}</tbody></table></div>
      <div className="help">CSV needs one column named <code>input</code>, with one question per row. Maximum 50 questions, 4,000 characters each, and a 1 MB CSV. No automatic scoring. Selected document text and questions are sent to OpenRouter when you run.</div>
    </section></div>
    <dialog id="promptDialog" ref={promptDialog} aria-labelledby="expandedPromptTitle" aria-describedby="expandedPromptHelp"><div className="expanded-prompt-layout"><div><h2 id="expandedPromptTitle">System prompt</h2><p className="sub" id="expandedPromptHelp">Changes sync automatically. Maximum 12,000 characters.</p></div><textarea id="expandedPrompt" ref={expandedPrompt} spellCheck="false" aria-labelledby="expandedPromptTitle" value={prompt} disabled={locked} onChange={event => changePrompt(event.target.value)} /><form method="dialog"><button>Close</button></form></div></dialog>
    <dialog id="modelDialog" ref={modelDialog} aria-labelledby="modelTitle"><h2 id="modelTitle">Choose a model</h2><p className="sub">Text models available through OpenRouter. Usage is billed to the server account.</p><input className="model-search" aria-label="Search models" placeholder="Search name or model ID" value={search} onChange={event => setSearch(event.target.value)} /><div className="model-options" id="modelOptions">{models.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.id} aria-pressed={model === item.id} onClick={() => { setModel(item.id); resetResults(); modelDialog.current.close(); }}>{item.name}<small className="meta">{item.id} · {item.contextLength.toLocaleString()} context</small></button>)}{!modelsLoading && !models.length && <p className="sub">{connectionError || 'No models available.'}</p>}</div><form method="dialog"><button>Close</button></form></dialog>
  </div>;
}
