import { LIMITS } from '../lib/limits.js';

export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const out = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; out.push(row); row = [];
    } else field += c;
  }
  if (quoted) throw new Error('A quoted CSV field is not closed.');
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out.filter(r => r.some(v => v.trim() !== ''));
}

export function rowsFromCSV(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error('The file has no data rows under the header.');
  const column = grid[0].findIndex(header => header.trim().toLowerCase() === 'input');
  if (column < 0) throw new Error('Could not find the required column named "input".');
  const questions = grid.slice(1).map(row => (row[column] ?? '').trim()).filter(Boolean);
  if (!questions.length) throw new Error('Every input cell is empty.');
  if (questions.length > LIMITS.cases) throw new Error(`Import at most ${LIMITS.cases} questions per CSV.`);
  if (questions.some(question => question.length > LIMITS.questionChars)) throw new Error(`Each question must be at most ${LIMITS.questionChars.toLocaleString()} characters.`);
  return questions.map((input, i) => ({ id: String(i + 1).padStart(2, '0'), input }));
}

export const csvCell = value => /[",\n\r]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
export function resultsCSV(rows, snapshot, project) {
  const header = ['id', 'input', 'response', 'status', 'error', 'elapsed_ms', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'model', 'selected_documents', 'system_prompt', 'document_fingerprints', 'run_at', 'project_id', 'project_name'];
  const data = rows.map(row => {
    const source = row.status === 'done' || row.status === 'error' ? row.provenance || snapshot : null;
    return [row.id, row.input, row.response, row.status, row.error, row.elapsedMs ?? '', row.usage?.prompt_tokens ?? '', row.usage?.completion_tokens ?? '', row.usage?.total_tokens ?? '', source?.model ?? '', source?.documentNames?.join('; ') ?? '', source?.systemPrompt ?? '', source?.documentFingerprints ? JSON.stringify(source.documentFingerprints) : '', source?.runAt ?? '', source?.projectId ?? project?.id ?? '', source?.projectName ?? project?.name ?? ''];
  });
  return '\uFEFF' + [header, ...data].map(row => row.map(value => csvCell(value ?? '')).join(',')).join('\r\n');
}
