import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LIMITS } from '../lib/limits.js';
import { extractPDFText } from '../lib/pdf-text.js';

GlobalWorkerOptions.workerSrc = workerUrl;
export async function extractPDF(file, load = getDocument) {
  if (!/\.pdf$/i.test(file.name)) throw new Error('Only PDF documents are supported.');
  if (file.size > LIMITS.fileBytes) throw new Error('Each PDF must be 5 MB or smaller.');
  return extractPDFText(new Uint8Array(await file.arrayBuffer()), load);
}
