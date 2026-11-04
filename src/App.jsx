import React, { useEffect, useRef, useState } from 'react';
import { defaultModelId, isModelAllowed } from '../lib/model-config.js';
import { resultMetadata } from '../lib/result-metadata.js';
import { LIMITS, utf8Bytes } from '../lib/limits.js';
import { rowsFromCSV, resultsCSV } from './csv.js';
import { extractPDF } from './pdf.js';
import { uploadPresigned } from '@vercel/blob/client';
import { SAMPLE_PROMPT, SAMPLE_ROWS } from './sample.js';

const queued = row => ({ id: row.id, input: row.input, provenance: null, adminSaved: false, status: 'queued', response: '', error: '', elapsedMs: null, usage: null, truncated: false, finishReason: null });
async function textHash(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join(''); }
const urlProject = () => new URL(location.href).searchParams.get('project') || '';
function ProjectSkeleton() {
  return <div className="grid project-skeleton" role="status" aria-label="Loading project" aria-busy="true">
    <span className="sr-only">Loading project…</span>
    <div className="left-column"><section className="panel skeleton-panel" aria-hidden="true"><div className="skeleton-block skeleton-title" /><div className="skeleton-block skeleton-editor" /></section><section className="panel skeleton-panel" aria-hidden="true"><div className="skeleton-block skeleton-title" /><div className="skeleton-block skeleton-line" /><div className="skeleton-block skeleton-document" /><div className="skeleton-block skeleton-document" /></section></div>
    <section className="panel skeleton-panel" aria-hidden="true"><div className="skeleton-block skeleton-title" /><div className="skeleton-toolbar"><i className="skeleton-block" /><i className="skeleton-block" /><i className="skeleton-block" /></div>{[0, 1, 2, 3, 4].map(index => <div className="skeleton-block skeleton-case" key={index} />)}</section>
  </div>;
}
function OpenIcon({ expand = false }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{expand ? <path d="M8 3H3v5M3 3l7 7M16 21h5v-5M21 21l-7-7M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7" /> : <><path d="M14 3h7v7M21 3l-10 10" /><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>}</svg>;
}
async function readResponse(response) {
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an invalid response. Try again.'); }
  if (!response.ok) { const error = new Error(data.error || 'The request failed. Try again.'); if (data.result) error.result = resultMetadata(data.result); if (Array.isArray(data.projects)) error.projects = data.projects.filter(item => typeof item?.id === 'string' && typeof item?.name === 'string').map(({ id, name }) => ({ id, name })); error.configured = data.configured === true; throw error; }
  return data;
}

export default function App() {
  const [projectId, setProjectId] = useState(urlProject);
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([{ id: 'default', name: 'Default' }]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [createError, setCreateError] = useState('');
  const createDialog = useRef(null);
  const loadSequence = useRef(0);
  const loadController = useRef(null);
  const documentsRef = useRef([]);
  const [prompt, setPrompt] = useState('');
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
  const [authenticated, setAuthenticated] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [defaultsLoading, setDefaultsLoading] = useState(true);
  const [defaultsReady, setDefaultsReady] = useState(false);
  const [defaultsError, setDefaultsError] = useState('');
  const [sharedConfigured, setSharedConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const loginDialog = useRef(null);
  const stopRequested = useRef(false);
  const active = useRef(false);
  const controllers = useRef(new Set());
  const promptDialog = useRef(null);
  const expandedPrompt = useRef(null);
  const modelDialog = useRef(null);
  const busy = running || importing || saving || creating || deleting || defaultsLoading;
  const locked = busy || !defaultsReady || !project;
  documentsRef.current = documents;
  const selected = documents.filter(doc => doc.selected);
  const selectedChars = selected.reduce((count, doc) => count + doc.text.length, 0);
  const done = rows.filter(row => row.status === 'done').length;
  const errors = rows.filter(row => row.status === 'error').length;
  const modelName = models.find(item => item.id === model)?.name || 'Select a model';

  async function loadModels() {
    setModelsLoading(true); setConnectionError('');
    try {
      const data = await readResponse(await fetch('/api/models'));
      const available = Array.isArray(data.models) ? data.models.filter(item => isModelAllowed(item.id)) : [];
      const initial = defaultModelId(available);
      setModels(available); setModel(initial);
    } catch (error) { setModels([]); setModel(''); setConnectionError(error.message); }
    finally { setModelsLoading(false); }
  }
  async function loadDefaults(id = projectId) {
    const sequence = ++loadSequence.current;
    loadController.current?.abort(); const controller = new AbortController(); loadController.current = controller;
    stopRequested.current = true; controllers.current.forEach(item => item.abort()); active.current = false; setRunning(false);
    setImporting(false); setSaving(false); setCreating(false); setDeleting(false);
    promptDialog.current?.close(); createDialog.current?.close();
    documentsRef.current.forEach(doc => { if (doc.url.startsWith('blob:')) URL.revokeObjectURL(doc.url); });
    setDefaultsLoading(true); setDefaultsReady(false); setDefaultsError(''); setProject(null); setPrompt(''); setDocuments([]); setRows([]); setSnapshot(null); setNotice({ text: '', error: false }); setSaveStatus('');
    try {
      const data = await readResponse(await fetch(id ? `/api/defaults?project=${encodeURIComponent(id)}` : '/api/defaults', { cache: 'no-store', signal: controller.signal }));
      if (sequence !== loadSequence.current) return;
      setSharedConfigured(data.configured); setProjects(data.projects);
      const restored = [];
      if (data.defaults) {
        for (const doc of data.defaults.documents) {
          const response = await fetch(doc.url, { cache: 'no-store', redirect: 'error', signal: controller.signal });
          if (!response.ok || Number(response.headers.get('content-length')) > LIMITS.fileBytes) throw new Error(`Could not load ${doc.name}.`);
          const reader = response.body.getReader(); const chunks = []; let size = 0;
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > LIMITS.fileBytes) throw new Error('Saved PDF exceeds 5 MB.'); chunks.push(value); }
          } finally { await reader.cancel(); }
          const file = new File(chunks, doc.name, { type: 'application/pdf' });
          const parsed = await extractPDF(file); const sha256 = await textHash(parsed.text);
          if (sequence !== loadSequence.current) return;
          if (doc.sha256 && sha256 !== doc.sha256) throw new Error(`Saved PDF text changed: ${doc.name}.`);
          restored.push({ ...doc, ...parsed, sha256, id: crypto.randomUUID(), file: null });
        }
        if (restored.filter(doc => doc.selected).reduce((n, doc) => n + doc.text.length, 0) > LIMITS.contextChars) throw new Error('Saved documents exceed the selected text limit.');
      }
      if (sequence !== loadSequence.current) return;
      const resolved = data.project?.id ?? ''; setProjectId(resolved);
      const url = new URL(location.href); if (resolved) url.searchParams.set('project', resolved); else url.searchParams.delete('project'); history.replaceState({}, '', url);
      setProject(data.project); setPrompt(data.project ? data.defaults?.systemPrompt ?? SAMPLE_PROMPT : ''); setDocuments(restored);
      const restoredRows = data.project ? data.defaults?.rows ?? SAMPLE_ROWS.map(queued) : [];
      setRows(restoredRows.map(row => ({ ...row, adminSaved: row.status === 'done' || row.status === 'error' }))); setDefaultsReady(true); setIsSample(Boolean(data.project && !data.defaults)); setFileMeta(data.project ? `${data.project.name} · ${restoredRows.length} cases` : 'No project selected');
      setDocNotice(data.defaults ? 'Project loaded. Your edits stay in this page until an admin saves them.' : 'Your uploads stay in this page until an admin saves the project.');
    } catch (error) { if (sequence === loadSequence.current && !controller.signal.aborted) { if (error.projects) setProjects(error.projects); if (error.configured) setSharedConfigured(true); setDefaultsError(`Could not load project: ${error.message}`); } }
    finally { if (sequence === loadSequence.current) setDefaultsLoading(false); }
  }
  function switchProject(id, updateURL = true) {
    if (updateURL) { const url = new URL(location.href); if (id) url.searchParams.set('project', id); else url.searchParams.delete('project'); history.pushState({}, '', url); }
    setProjectId(id); void loadDefaults(id);
  }
  async function createProject(event) {
    event.preventDefault(); if (busy || creating || !sharedConfigured) return;
    const sequence = loadSequence.current;
    setCreating(true); setCreateError(''); const form = event.currentTarget;
    try {
      const data = await readResponse(await fetch('/api/defaults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name: new FormData(form).get('name') }) }));
      if (sequence !== loadSequence.current) return;
      setProjects(data.projects); createDialog.current.close(); form.reset(); switchProject(data.project.id);
    } catch (error) { if (sequence === loadSequence.current) setCreateError(error.message); }
    finally { if (sequence === loadSequence.current) setCreating(false); }
  }
  async function checkSession() {
    try { const data = await readResponse(await fetch('/api/auth', { cache: 'no-store' })); setAuthenticated(data.authenticated); }
    catch { setAuthenticated(false); }
    finally { setAuthReady(true); }
  }
  useEffect(() => { loadModels(); loadDefaults(urlProject()); checkSession(); const navigate = () => switchProject(urlProject(), false); window.addEventListener('popstate', navigate); return () => { loadController.current?.abort(); window.removeEventListener('popstate', navigate); }; }, []);
  useEffect(() => () => { controllers.current.forEach(controller => controller.abort()); }, []);

  function resetResults() { setSaveStatus(''); setRows(current => current.map(queued)); setSnapshot(null); setNotice({ text: '', error: false }); }
  function changePrompt(value) {
    setPrompt(value); resetResults();
    setSaveStatus('');
  }
  function report(error) { setNotice({ text: error.message, error: true }); }
  async function importCases(event) {
    const file = event.target.files[0]; event.target.value = '';
    if (!file || locked) return;
    const sequence = loadSequence.current;
    setImporting(true);
    try {
      const extension = file.name.split('.').pop().toLowerCase();
      if (!['csv', 'xlsx'].includes(extension)) throw new Error('Import a .csv or .xlsx file. Legacy .xls and macro-enabled files are not supported.');
      if (file.size > (extension === 'csv' ? LIMITS.csvBytes : LIMITS.xlsxBytes)) throw new Error(extension === 'csv' ? 'CSV must be 1 MiB or smaller.' : 'XLSX must be 5 MiB or smaller.');
      const data = extension === 'csv' ? rowsFromCSV(await file.text()) : await (await import('./xlsx-import.js')).readXLSXFile(file);
      if (sequence !== loadSequence.current) return;
      setRows(data.map(queued)); setSnapshot(null); setIsSample(false);
      setFileMeta(`${file.name} · ${data.length} cases`); setNotice({ text: '', error: false });
    } catch (error) { if (sequence === loadSequence.current) report(error); }
    finally { if (sequence === loadSequence.current) setImporting(false); }
  }
  async function uploadDocuments(event) {
    const files = Array.from(event.target.files); event.target.value = '';
    if (!files.length || locked || !authenticated) return;
    const sequence = loadSequence.current;
    setImporting(true);
    try {
      if (documents.length + files.length > LIMITS.files) throw new Error(`Keep at most 10 PDFs in this page. ${authenticated ? 'Remove a document' : 'Reload the project'} before adding more.`);
      const added = [];
      for (const file of files) {
        const result = await extractPDF(file); const sha256 = await textHash(result.text);
        if (sequence !== loadSequence.current) return;
        added.push({ name: file.name, file, ...result, sha256, selected: true });
      }
      if (selectedChars + added.reduce((count, doc) => count + doc.text.length, 0) > LIMITS.contextChars) throw new Error('Selected PDF text exceeds 60,000 characters. Deselect a document before uploading more.');
      setDocuments(current => [...current, ...added.map(doc => ({ ...doc, id: crypto.randomUUID(), url: URL.createObjectURL(doc.file.slice(0, doc.file.size, 'application/pdf')) }))]);
      setDocNotice(`${added.length} PDF(s) ready. Full text is sent only when you run a benchmark.`); resetResults();
    } catch (error) { if (sequence === loadSequence.current) report(new Error(`Upload failed: ${error.message}`)); }
    finally { if (sequence === loadSequence.current) setImporting(false); }
  }
  function toggleDocument(doc, checked) {
    if (checked && selectedChars + doc.text.length > LIMITS.contextChars) return report(new Error('Selected documents must total at most 60,000 characters. Deselect another document first.'));
    setDocuments(current => current.map(item => item.id === doc.id ? { ...item, selected: checked } : item)); resetResults();
  }
  function removeDocument(doc) {
    if (!authenticated || locked) return;
    setDocuments(current => current.filter(item => item.id !== doc.id)); if (doc.url.startsWith('blob:')) URL.revokeObjectURL(doc.url); resetResults();
  }
  async function deleteProject() {
    if (!authenticated || locked || !project) return;
    const target = project;
    if (!window.confirm(`Delete project “${target.name}”? It will be removed from the project list. This cannot be undone from this app.`)) return;
    const sequence = loadSequence.current; setDeleting(true);
    try {
      const data = await readResponse(await fetch('/api/defaults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', projectId: target.id, confirmName: target.name }) }));
      if (sequence !== loadSequence.current) return;
      setProjects(data.projects); switchProject(data.projects.find(item => item.id === 'default')?.id || data.projects[0]?.id || '');
    } catch (error) { if (sequence === loadSequence.current) report(new Error(`Delete could not be confirmed: ${error.message} Reload to check the project list.`)); }
    finally { if (sequence === loadSequence.current) setDeleting(false); }
  }
  async function login(event) {
    event.preventDefault(); setAuthBusy(true); setAuthError('');
    const form = event.currentTarget; const fields = new FormData(form);
    try {
      await readResponse(await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', username: fields.get('username'), password: fields.get('password') }) }));
      setAuthenticated(true); form.reset(); loginDialog.current.close();
    } catch (error) { setAuthError(error.message); }
    finally { setAuthBusy(false); }
  }
  async function logout() {
    setAuthBusy(true);
    try { await readResponse(await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) })); setAuthenticated(false); setSaveStatus(''); }
    catch (error) { report(error); }
    finally { setAuthBusy(false); }
  }
  async function saveDefaults() {
    if (locked || !authenticated || !sharedConfigured) return;
    const sequence = loadSequence.current;
    setSaving(true); setSaveStatus('Saving project…');
    try {
      if (!prompt.trim() || prompt.length > LIMITS.systemChars) throw new Error('System prompt must contain 1–12,000 characters.');
      const prepared = [];
      for (const doc of documents) {
        let pathname = doc.pathname;
        if (!pathname) {
          pathname = `prompt-bench/pdfs/${crypto.randomUUID()}.pdf`;
          await uploadPresigned(pathname, doc.file.slice(0, doc.file.size, 'application/pdf'), { access: 'public', contentType: 'application/pdf', handleUploadUrl: '/api/upload' });
          if (sequence !== loadSequence.current) return;
          setDocuments(current => current.map(item => item.id === doc.id ? { ...item, pathname } : item));
        }
        prepared.push({ pathname, name: doc.name, selected: doc.selected });
      }
      const savedRows = rows.map(({ id, input, status, response, error, elapsedMs, usage, truncated, finishReason, provenance }) => ({ id, input, status, response, error, elapsedMs, usage, truncated, finishReason, provenance }));
      const saveBody = { action: 'save', projectId: project.id, systemPrompt: prompt, documents: prepared, rows: savedRows };
      if (utf8Bytes(JSON.stringify(saveBody)) > LIMITS.defaultsBytes) throw new Error('Project data exceeds the 3 MiB limit. Save fewer or shorter results.');
      const result = await readResponse(await fetch('/api/defaults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saveBody) }));
      if (sequence !== loadSequence.current) return;
      setDocuments(current => current.map(doc => {
        const saved = result.defaults.documents.find(item => item.pathname === doc.pathname);
        if (doc.url.startsWith('blob:')) URL.revokeObjectURL(doc.url);
        return { ...doc, ...saved, file: null };
      }));
      setSaveStatus('Project saved. Visitors will load its prompt, documents, cases, and saved results on refresh.');
    } catch (error) { if (sequence === loadSequence.current) { setSaveStatus(`Save failed: ${error.message} Your edits are still here. Retry or reload to check the latest saved version.`); await checkSession(); } }
    finally { if (sequence === loadSequence.current) setSaving(false); }
  }
  function patchRow(id, patch, sequence) { if (sequence !== loadSequence.current) return; setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row)); }
  async function runQueue(list, reset = false) {
    if (active.current || locked) return;
    const sequence = loadSequence.current;
    const runSnapshot = { outputTokens: LIMITS.outputTokens, projectId: project.id, projectName: project.name, model, systemPrompt: prompt, documentNames: selected.map(doc => doc.name), documentFingerprints: selected.map(doc => ({ name: doc.name, sha256: doc.sha256, pathname: doc.pathname ?? null })), documents: selected.map(({ name, text }) => ({ name, text })) };
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
      while (next < list.length && !stopRequested.current && sequence === loadSequence.current) {
        const row = list[next++]; const controller = new AbortController(); controllers.current.add(controller);
        const { documents: ignored, ...source } = runSnapshot;
        const provenance = { ...source, runAt: new Date().toISOString() };
        patchRow(row.id, { ...queued(row), status: 'running', provenance }, sequence);
        try {
          const data = await readResponse(await fetch('/api/benchmark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: runSnapshot.model, systemPrompt: runSnapshot.systemPrompt, question: row.input, documents: runSnapshot.documents }), signal: controller.signal }));
          const details = resultMetadata(data);
          patchRow(row.id, { status: 'done', response: data.response, ...details, provenance: { ...provenance, outputTokens: details.outputTokens ?? provenance.outputTokens } }, sequence);
        } catch (error) {
          const details = error.result ? resultMetadata(error.result) : {};
          patchRow(row.id, controller.signal.aborted ? queued(row) : { status: 'error', error: error.message.slice(0, LIMITS.errorChars), ...details, provenance: { ...provenance, outputTokens: details.outputTokens ?? provenance.outputTokens } }, sequence);
        } finally { controllers.current.delete(controller); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(1, list.length) }, worker));
    if (sequence !== loadSequence.current) return;
    active.current = false; setRunning(false);
    setNotice({ text: stopRequested.current ? 'Stopped. Unfinished cases remain queued. Requests already accepted by a provider may still be billed.' : 'Benchmark finished. Review responses and usage below.', error: false });
  }
  function stop() { stopRequested.current = true; controllers.current.forEach(controller => controller.abort()); }
  function exportResults() {
    const url = URL.createObjectURL(new Blob([resultsCSV(rows, snapshot, project)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'benchmark-results.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="wrap">
    <header><div><h1>Prompt <span>Bench</span></h1><p className="sub">A workspace for prompts, knowledge, and benchmark cases.</p></div><div className="admin-actions">{authenticated ? <><button id="saveDefaultsBtn" disabled={locked || !sharedConfigured || authBusy} onClick={saveDefaults}>{saving ? 'Saving…' : 'Save project'}</button><button disabled={running || importing || saving || authBusy} onClick={logout}>Log out</button></> : <button id="loginBtn" disabled={!authReady || running || importing || saving} onClick={() => { setAuthError(''); loginDialog.current.showModal(); }}>Admin login</button>}</div></header>
    <section className="project-toolbar panel" aria-label="Project selection"><label htmlFor="projectSelect">Project</label><select id="projectSelect" value={projectId} disabled={running || importing || saving || creating || deleting} onChange={event => switchProject(event.target.value)}>{!projects.length ? <option value={projectId}>{defaultsLoading ? 'Loading projects…' : projectId ? 'Project unavailable' : 'No projects'}</option> : !projects.some(item => item.id === projectId) && <option value={projectId}>{defaultsLoading ? 'Loading projects…' : 'Project unavailable'}</option>}{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{authenticated && <button disabled={busy || !sharedConfigured} onClick={() => { setCreateError(''); createDialog.current.showModal(); }}>New project</button>}{authenticated && project && <button id="deleteProjectBtn" disabled={locked || !sharedConfigured} onClick={deleteProject}>{deleting ? 'Deleting…' : 'Delete project'}</button>}<span className="meta">{defaultsLoading ? 'Loading project…' : defaultsReady && !project ? 'No projects. An admin can create a new project.' : defaultsReady ? 'Guest edits are temporary. Admins can save this project.' : 'Project unavailable'}</span></section>
    {(defaultsLoading || defaultsError || !sharedConfigured) && <div className={`shared-notice${defaultsError ? ' document-error' : ''}`} role="status">{defaultsLoading ? 'Loading project…' : defaultsError || 'Shared defaults are not configured. Your edits are temporary; an admin must connect a public Blob store to save them.'}{defaultsError && <><button onClick={() => loadDefaults(projectId)}>Retry project</button><button onClick={() => switchProject('')}>View available projects</button></>}</div>}
    {saveStatus && <div className="shared-notice" id="saveStatus" role="status">{saveStatus}</div>}
    {defaultsLoading ? <ProjectSkeleton /> : <div className="grid" aria-busy="false"><div className="left-column">
      <section className="panel prompt-panel" aria-labelledby="sysLabel"><div className="panel-h"><span className="label" id="sysLabel">System prompt</span><div className="prompt-actions"><span className="meta" id="sysMeta">{prompt.length.toLocaleString()} chars</span><button id="expandPromptBtn" className="expand-prompt" title="Expand system prompt" aria-label="Expand system prompt" aria-haspopup="dialog" disabled={locked} onClick={() => { promptDialog.current.showModal(); expandedPrompt.current.focus(); }}><OpenIcon expand /></button></div></div><textarea id="sysPrompt" spellCheck="false" aria-labelledby="sysLabel" value={prompt} disabled={locked} onChange={event => changePrompt(event.target.value)} /></section>
      <section className="panel" aria-labelledby="knowledgeLabel"><div className="panel-h"><span className="label" id="knowledgeLabel">Knowledge base</span><span className="chip">{authenticated ? 'Save to share' : 'Shared defaults + your edits'}</span></div><div className="knowledge-body"><p className="sub">{authenticated ? 'Upload text-based PDFs: up to 5 MB and 10 pages each. Selected full text is used for every question.' : 'Select the PDFs to include as knowledge for this benchmark.'}</p>{authenticated && <label className="filebtn" htmlFor="docInput">Upload PDFs<input type="file" id="docInput" multiple accept=".pdf,application/pdf" disabled={locked} onChange={uploadDocuments} /></label>}<div id="documents">{documents.map(doc => <div className="document" key={doc.id}><label className="document-label"><input type="checkbox" checked={doc.selected} disabled={locked} onChange={event => toggleDocument(doc, event.target.checked)} /><span>{doc.name}<small>{doc.pages} page(s) · {doc.text.length.toLocaleString()} chars</small></span></label><div className="document-actions"><a className="document-open" href={doc.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${doc.name} in a new tab`} title={`Open ${doc.name} in a new tab`}><OpenIcon /></a>{authenticated && <button className="remove-document" disabled={locked} onClick={() => removeDocument(doc)} aria-label={`Remove ${doc.name}`}>Remove</button>}</div></div>)}</div>{!documents.length && <p className="sub">{project ? 'No documents yet. You can run with the system prompt alone.' : 'Select or create a project to begin.'}</p>}<p className="sub upload-notice" id="docNotice" role="status">{authenticated ? importing ? 'Reading file…' : docNotice : 'Your selections apply to this page only. Refresh restores the saved project.'}</p><p className="meta">{selectedChars.toLocaleString()} / 60,000 selected characters{authenticated && ' · Up to 10 PDFs. Scans and blank pages are not supported.'}</p></div></section>
    </div>
    <section className="panel" aria-labelledby="casesLabel"><div className="panel-h"><span className="label" id="casesLabel">Benchmark cases {isSample && <span className="sample-tag" id="sampleTag">Sample data</span>}</span><span className="meta" id="fileMeta">{fileMeta}</span></div>
      <div className="toolbar"><label className="filebtn" htmlFor="csvInput">Import CSV/ XLSX<input type="file" id="csvInput" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={locked} onChange={importCases} /></label><button className="model-btn" id="modelBtn" disabled={locked} onClick={() => modelDialog.current.showModal()}>Change model · {modelName}</button><span className="spacer" /><button className="primary" id="runBtn" disabled={locked || modelsLoading || !model || !!connectionError || !rows.length} onClick={() => runQueue(rows, true)}>Run all</button><button id="stopBtn" disabled={!running} onClick={stop}>Stop</button><button id="exportBtn" disabled={locked || !rows.some(row => row.status === 'done' || row.status === 'error')} onClick={exportResults}>Export results</button></div>
      {(modelsLoading || connectionError) && <div className={`notice connection${connectionError ? ' err' : ''}`} role="status">{modelsLoading ? 'Loading OpenRouter models…' : connectionError} {!modelsLoading && <button disabled={locked} onClick={loadModels}>Retry connection</button>}</div>}
      <div className="notice context" id="contextSummary" aria-live="polite">{model || 'No model selected'} · {selected.length} document(s): {selected.map(doc => doc.name).join(', ') || 'None (prompt only)'}</div><div className="bar"><i id="progress" style={{ width: `${rows.length ? (done + errors) / rows.length * 100 : 0}%` }} /></div><div className="stats" id="stats"><span>Cases <b>{rows.length}</b></span><span>Completed <b>{done}/{rows.length}</b></span>{errors > 0 && <span>Errors <b>{errors}</b></span>}<span>New run output cap <b>{LIMITS.outputTokens.toLocaleString()} tokens</b></span></div>
      {notice.text && <div className={`notice${notice.error ? ' err' : ''}`} id="notice" role="status">{notice.text}</div>}
      <div className="tablewrap"><table><thead><tr>{['ID', 'Input', 'Response', 'Status', 'Time / tokens', ''].map((heading, i) => <th key={i}>{heading}</th>)}</tr></thead><tbody id="rows">{rows.map(row => <tr key={row.id}><td className="id">{row.id}</td><td className="txt">{row.input}</td><td className="resp"><div className={`resp-box${!row.response ? ' dim' : ''}`}>{row.adminSaved && <div className="meta historical">Admin-saved · {row.provenance?.model}</div>}{row.status === 'running' ? <div className="response-skeleton" role="status" aria-label="Waiting for model response" aria-busy="true"><span className="sr-only">Waiting for model response…</span><span className="skeleton-block skeleton-line" aria-hidden="true" /><span className="skeleton-block skeleton-line" aria-hidden="true" /></div> : row.response || (row.status === 'error' ? 'No response' : 'Not run yet')}</div>{row.truncated && <div className="meta">Output limit reached. The answer may be incomplete. Retry to try again. Limit: {(row.provenance?.outputTokens ?? 1024).toLocaleString()} tokens.</div>}</td><td><span className={`chip ${row.status}`}>{{ queued: 'Queued', running: 'Running', done: 'Done', error: 'Error' }[row.status]}</span>{row.error && <div className="meta document-error">{row.error}</div>}</td><td className="metrics">{row.elapsedMs == null ? '—' : `${(row.elapsedMs / 1000).toFixed(2)} s`}<br />{row.usage?.total_tokens == null ? '— tokens' : `${row.usage.total_tokens} tokens`}<div className="meta">In {row.usage?.prompt_tokens ?? '—'} / Out {row.usage?.completion_tokens ?? '—'}</div>{row.provenance && <div className="meta">Limit {(row.provenance.outputTokens ?? 1024).toLocaleString()}</div>}</td><td className="act"><button disabled={locked || !model || !!connectionError} onClick={() => runQueue([row])}>{row.status === 'queued' ? 'Run' : 'Retry'}</button></td></tr>)}</tbody></table></div>
      <div className="help">CSV or the first XLSX worksheet needs one column named <code>input</code>, with one question per row. Maximum 50 questions, 4,000 characters each. CSV: 1 MiB; XLSX: 5 MiB. Use plain text without formulas or merged input cells.</div>
    </section></div>}
    <dialog id="createProjectDialog" ref={createDialog} aria-labelledby="createProjectTitle"><h2 id="createProjectTitle">New project</h2><p className="sub">Start with a customer service prompt and no questions, documents or results.</p><form className="login-form" onSubmit={createProject}><label>Project name<input name="name" maxLength={80} required disabled={creating} /></label>{createError && <p className="document-error" role="alert">{createError}</p>}<button className="primary" disabled={creating}>{creating ? 'Creating…' : 'Create project'}</button></form><form method="dialog"><button disabled={creating}>Close</button></form></dialog>
    <dialog id="loginDialog" ref={loginDialog} aria-labelledby="loginTitle"><h2 id="loginTitle">Admin login</h2><p className="sub">Log in to create projects and save their prompts, documents, cases, and results.</p><form className="login-form" onSubmit={login}><label>Username<input name="username" autoComplete="username" required disabled={authBusy} /></label><label>Password<input name="password" type="password" autoComplete="current-password" required disabled={authBusy} /></label>{authError && <p className="document-error" role="alert">{authError}</p>}<button className="primary" disabled={authBusy}>{authBusy ? 'Logging in…' : 'Log in'}</button></form><form method="dialog"><button disabled={authBusy}>Close</button></form></dialog>
    <dialog id="promptDialog" ref={promptDialog} aria-labelledby="expandedPromptTitle" aria-describedby="expandedPromptHelp"><div className="expanded-prompt-layout"><div><h2 id="expandedPromptTitle">System prompt</h2><p className="sub" id="expandedPromptHelp">Changes sync automatically. Maximum 12,000 characters.</p></div><textarea id="expandedPrompt" ref={expandedPrompt} spellCheck="false" aria-labelledby="expandedPromptTitle" value={prompt} disabled={locked} onChange={event => changePrompt(event.target.value)} /><form method="dialog"><button>Close</button></form></div></dialog>
    <dialog id="modelDialog" ref={modelDialog} aria-labelledby="modelTitle"><h2 id="modelTitle">Choose a model</h2><p className="sub">Text models available through OpenRouter. Usage is billed to the server account.</p><input className="model-search" aria-label="Search models" placeholder="Search name or model ID" value={search} onChange={event => setSearch(event.target.value)} /><div className="model-options" id="modelOptions">{models.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.id} aria-pressed={model === item.id} onClick={() => { if (item.id !== model) { setModel(item.id); resetResults(); } modelDialog.current.close(); }}>{item.name}<small className="meta">{item.id} · {item.contextLength.toLocaleString()} context</small></button>)}{!modelsLoading && !models.length && <p className="sub">{connectionError || 'No models available.'}</p>}</div><form method="dialog"><button>Close</button></form></dialog>
  </div>;
}
