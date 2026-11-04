import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { zipSync, unzipSync, strFromU8, strToU8, Zip, ZipDeflate } from 'fflate';
import { rowsFromXLSX } from '../src/xlsx.js';

function workbook(rows, edit, second) {
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet(rows); if (edit) edit(sheet);
  XLSX.utils.book_append_sheet(book, sheet, 'First'); if (second) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(second), 'Second');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }));
}
function changeEntry(data, pathname, transform) { const entries = unzipSync(data); entries[pathname] = strToU8(transform(strFromU8(entries[pathname]))); return zipSync(entries); }
function changeDeclaredSize(data, name, size) {
  const modified = data.slice(); const view = new DataView(modified.buffer);
  for (let i = 0; i < modified.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) {
    const length = view.getUint16(i + 28, true); if (strFromU8(modified.subarray(i + 46, i + 46 + length)) === name) { view.setUint32(i + 24, size, true); return modified; }
  }
  throw new Error('Fixture central entry not found.');
}

test('XLSX first worksheet accepts trimmed case-insensitive input, Chinese, multiline text and ignores other columns/sheets', () => {
  const file = workbook([['id', ' InPuT ', 'expected'], ['ignored', '你好, world', 'ignored'], ['x', 'two\nlines', 'ignored'], ['x', '   ', 'ignored'], ['x', 'last', 'ignored']], null, [['input'], ['Second sheet ignored']]);
  assert.deepEqual(rowsFromXLSX(file), [{ id: '01', input: '你好, world' }, { id: '02', input: 'two\nlines' }, { id: '03', input: 'last' }]);
});
test('XLSX rejects cached formulas and merged input cells, but ignores formula/merges in unrelated columns', () => {
  assert.throws(() => rowsFromXLSX(workbook([['input'], ['cached']], sheet => { sheet.A2 = { t: 'str', f: '"cached"', v: 'cached' }; })), /Formulas/);
  assert.throws(() => rowsFromXLSX(workbook([['input'], ['cached']], sheet => { sheet.A2 = { t: 'n', f: 'SUM(1,2)' }; })), /Formulas/);
  assert.throws(() => rowsFromXLSX(workbook([['input'], ['Question'], ['Next']], sheet => { sheet['!merges'] = [XLSX.utils.decode_range('A2:A3')]; })), /Merged/);
  const okay = workbook([['input', 'other', 'other2'], ['Question', 'cached', null]], sheet => { sheet.B2 = { t: 'str', f: '"cached"', v: 'cached' }; sheet['!merges'] = [XLSX.utils.decode_range('B2:C2')]; }); assert.equal(rowsFromXLSX(okay)[0].input, 'Question');
});
test('XLSX validates text types, header/empty files, 50 nonblank questions and 4000 characters without truncating', () => {
  for (const value of [42, true, new Date('2026-01-01')]) assert.throws(() => rowsFromXLSX(workbook([['input'], [value]])), /plain text/);
  assert.throws(() => rowsFromXLSX(workbook([['message'], ['Question']])), /required column/);
  assert.throws(() => rowsFromXLSX(workbook([['input'], [' ']])), /Every input/);
  assert.equal(rowsFromXLSX(workbook([['input'], ...Array.from({ length: 50 }, (_, i) => [String(i)]).flatMap(row => [[], row])])).length, 50);
  assert.throws(() => rowsFromXLSX(workbook([['input'], ...Array.from({ length: 51 }, (_, i) => [String(i)])])), /at most 50/);
  assert.equal(rowsFromXLSX(workbook([['input'], ['a'.repeat(4000)]]))[0].input.length, 4000); assert.throws(() => rowsFromXLSX(workbook([['input'], ['a'.repeat(4001)]])), /4,000/);
});
test('XLSX sparse dimensions and far-away cells are read without rectangular range expansion', () => {
  let file = workbook([['input'], ['Sparse question']]);
  file = changeEntry(file, 'xl/worksheets/sheet1.xml', xml => xml.replace(/<dimension[^>]+\/>/, '<dimension ref="A1:XFD1048576"/>').replace('<row r="2">', '<row r="1048576">').replace('r="A2"', 'r="A1048576"'));
  assert.deepEqual(rowsFromXLSX(file), [{ id: '01', input: 'Sparse question' }]);
});
test('XLSX rejects macro/renamed/broken archives and bounded declared/actual decompression failures', () => {
  const valid = workbook([['input'], ['Question']]); const entries = unzipSync(valid);
  assert.throws(() => rowsFromXLSX(new Uint8Array(5 * 1024 * 1024 + 1)), /5 MiB/);
  assert.throws(() => rowsFromXLSX(strToU8('input\nNot a workbook')), /valid.*xlsx/);
  assert.throws(() => rowsFromXLSX(zipSync({ 'not-workbook.xml': strToU8('x') })), /genuine/);
  assert.throws(() => rowsFromXLSX(zipSync({ ...entries, 'xl/vbaProject.bin': strToU8('macro') })), /Macro/);
  assert.throws(() => rowsFromXLSX(changeEntry(valid, '[Content_Types].xml', xml => xml.replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'))), /Macro/);
  assert.throws(() => rowsFromXLSX(zipSync({ ...entries, 'too-large.xml': new Uint8Array(8 * 1024 * 1024 + 1) })), /expanded size/);
  assert.throws(() => rowsFromXLSX(zipSync({ ...entries, ...Object.fromEntries([1, 2, 3].map(i => [`total${i}.xml`, new Uint8Array(7 * 1024 * 1024)])) })), /expanded size/);
  assert.throws(() => rowsFromXLSX(zipSync({ ...entries, ...Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`extra${i}`, new Uint8Array(0)])) })), /200/);
  const inconsistent = changeDeclaredSize(zipSync({ ...entries, 'size-check.xml': strToU8('Actual size') }), 'size-check.xml', 1); assert.throws(() => rowsFromXLSX(inconsistent), /inconsistent entry sizes/);
  const hiddenExpansion = changeDeclaredSize(zipSync({ ...entries, 'large.xml': new Uint8Array(8 * 1024 * 1024 + 1) }), 'large.xml', 1); assert.throws(() => rowsFromXLSX(hiddenExpansion), /expanded size/);
});

test('XLSX accepts streaming ZIP data descriptors with sizes absent from local headers', () => {
  const entries = unzipSync(workbook([['input'], ['Descriptor question']])); const chunks = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  for (const [name, data] of Object.entries(entries)) { const file = new ZipDeflate(name); zip.add(file); file.push(data, true); }
  zip.end(); const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  assert.deepEqual(rowsFromXLSX(bytes), [{ id: '01', input: 'Descriptor question' }]);
});
