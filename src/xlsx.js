import * as XLSX from 'xlsx';
import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { LIMITS } from '../lib/limits.js';
import { questionsToRows } from './csv.js';

class WorkbookImportError extends Error {}
const reject = message => { throw new WorkbookImportError(message); };

function validateArchive(bytes) {
  const names = new Map(); let declaredBytes = 0;
  // The library's filter exposes central-directory metadata without decompressing.
  unzipSync(bytes, { filter(entry) {
    if (names.has(entry.name) || names.size >= LIMITS.xlsxEntries) reject('The XLSX archive has duplicate entries or more than 200 files.');
    names.set(entry.name, entry.originalSize); declaredBytes += entry.originalSize;
    if (entry.originalSize > LIMITS.xlsxEntryBytes || declaredBytes > LIMITS.xlsxExpandedBytes) reject('The XLSX archive exceeds its expanded size limit.');
    if (/vbaproject\.bin$/i.test(entry.name)) reject('Macro-enabled workbooks are not supported.');
    return false;
  } });
  if (!names.has('xl/workbook.xml') || !names.has('[Content_Types].xml')) reject('Use a genuine .xlsx workbook, not .xls or a renamed file.');
  let total = 0; const seen = new Set(); const completed = new Set(); let contentTypes = '';
  const unzip = new Unzip(entry => {
    if (!names.has(entry.name) || seen.has(entry.name)) reject('The XLSX archive is inconsistent.');
    seen.add(entry.name); let size = 0;
    entry.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length; total += chunk.length;
      if (size > LIMITS.xlsxEntryBytes || total > LIMITS.xlsxExpandedBytes) reject('The XLSX archive exceeds its expanded size limit.');
      if (entry.name === '[Content_Types].xml') contentTypes += new TextDecoder().decode(chunk);
      if (final) {
        if (size !== names.get(entry.name)) reject('The XLSX archive has inconsistent entry sizes.');
        completed.add(entry.name);
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed chunks bound the streaming inflater's intermediate output.
  for (let offset = 0; offset < bytes.length; offset += 1024) unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  if (completed.size !== names.size) reject('The XLSX archive is incomplete.');
  if (/<(?:[\w.-]+:)?Override\b[^>]*\bContentType\s*=\s*["'][^"']*macroEnabled/i.test(contentTypes)) reject('Macro-enabled workbooks are not supported.');
}

export function rowsFromXLSX(buffer) {
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength > LIMITS.xlsxBytes) reject('XLSX must be 5 MiB or smaller.');
    validateArchive(bytes);
    const workbook = XLSX.read(bytes, { type: 'array', sheets: 0, dense: false, cellFormula: true, cellHTML: false, cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) reject('The workbook has no readable first worksheet.');
    const keys = Object.keys(sheet).filter(key => !key.startsWith('!'));
    if (keys.length > LIMITS.xlsxCells) reject('The first worksheet has more than 50,000 stored cells.');
    const cells = keys.map(key => ({ address: XLSX.utils.decode_cell(key), cell: sheet[key] }));
    // Iterate sparse cells, never a worksheet dimension or a rectangular !ref range.
    const populated = cells.filter(({ cell }) => cell.v != null && String(cell.v).trim() !== '');
    if (!populated.length) reject('The first worksheet is empty.');
    const headerRow = Math.min(...populated.map(({ address }) => address.r));
    const header = populated.filter(({ address, cell }) => address.r === headerRow && typeof cell.v === 'string' && cell.v.trim().toLowerCase() === 'input').sort((a, b) => a.address.c - b.address.c)[0];
    if (!header) reject('Could not find the required column named "input" in the first worksheet.');
    const column = header.address.c;
    if ((sheet['!merges'] || []).some(range => range.s.c <= column && range.e.c >= column && range.e.r >= headerRow)) reject('Merged cells in the input column are not supported. Unmerge them before importing.');
    const questions = [];
    for (const { address, cell } of cells.filter(({ address }) => address.c === column && address.r >= headerRow).sort((a, b) => a.address.r - b.address.r)) {
      if (Object.hasOwn(cell, 'f') || Object.hasOwn(cell, 'F')) reject('Formulas in the input column are not supported. Paste plain text values before importing.');
      if (address.r === headerRow || cell.v == null) continue;
      if (typeof cell.v !== 'string' || !['s', 'str'].includes(cell.t)) reject('Each input question must be plain text, not a number, date, boolean or error.');
      if (cell.v.trim()) questions.push(cell.v.trim());
    }
    return questionsToRows(questions);
  } catch (error) {
    if (error instanceof WorkbookImportError || /^(Import at most|Each question|Every input)/.test(error.message)) throw error;
    throw new WorkbookImportError('Could not read this XLSX file. Use a valid, unencrypted .xlsx workbook.');
  }
}
