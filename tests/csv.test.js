import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromCSV, resultsCSV } from '../src/csv.js';

test('input-only CSV supports Chinese, quotes/newlines and ignores other fields', () => {
  assert.deepEqual(rowsFromCSV('\uFEFFid, InPuT ,expected\nx,"你好, world",ignore\ny,"two\nlines",ignore\nz,"A ""quote""",ignore\nk,   ,ignore'), [{ id: '01', input: '你好, world' }, { id: '02', input: 'two\nlines' }, { id: '03', input: 'A "quote"' }]);
});
test('CSV rejects aliases, empty questions, malformed quotes and exceeded caps', () => {
  for (const csv of ['message\nHi', '', 'input\n', 'input\n"unclosed', 'input\n' + 'x'.repeat(4001), 'input\n' + Array(51).fill('Hi').join('\n')]) assert.throws(() => rowsFromCSV(csv));
  assert.equal(rowsFromCSV('input\n' + Array(50).fill('Hi').join('\n')).length, 50);
});
test('export preserves answers, unknown usage and run attribution without expected/scoring', () => {
  const csv = resultsCSV([{ id: '01', input: 'Hi', response: '你好, world', status: 'done', usage: null }], { model: 'test/model', documentNames: ['文件.pdf'], systemPrompt: 'System' });
  assert.match(csv, /"你好, world"/); assert.match(csv, /test\/model/); assert.match(csv, /文件.pdf/); assert.ok(!/expected|exact_match|demo_/.test(csv));
});
