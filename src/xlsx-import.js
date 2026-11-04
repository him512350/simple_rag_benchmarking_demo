import XLSXWorker from './xlsx.worker.js?worker';
import { LIMITS } from '../lib/limits.js';

export async function readXLSXFile(file) {
  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new XLSXWorker();
    const finish = (error, rows) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(rows); };
    const timer = setTimeout(() => finish(new Error('XLSX import took too long. Use a smaller, simpler workbook.')), LIMITS.xlsxTimeoutMs);
    worker.onmessage = event => finish(event.data.error ? new Error(event.data.error) : null, event.data.rows);
    worker.onerror = () => finish(new Error('Could not read this XLSX file. Use a smaller, valid workbook.'));
    worker.postMessage(buffer, [buffer]);
  });
}
