import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LIMITS } from '../lib/limits.js';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractPDF(file, load = getDocument) {
  if (!/\.pdf$/i.test(file.name)) throw new Error('Only PDF documents are supported.');
  if (file.size > LIMITS.fileBytes) throw new Error('Each PDF must be 5 MB or smaller.');
  const task = load({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > LIMITS.pdfPages) throw new Error('Each PDF must have at most 10 pages.');
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      if (!text) throw new Error(`Page ${i} has no selectable text. Scanned or blank pages are not supported.`);
      pages.push(text);
      if (pages.join('\n\n').length > LIMITS.contextChars) throw new Error('PDF text exceeds the 60,000-character context limit.');
    }
    return { text: pages.join('\n\n'), pages: pdf.numPages };
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('Password-protected PDFs are not supported. Upload an unlocked copy.');
    if (error.name === 'InvalidPDFException') throw new Error('This PDF is invalid or damaged. Upload a readable PDF.');
    if (error.name === 'UnknownErrorException') throw new Error('This PDF could not be read. Try another text-based PDF.');
    throw error;
  } finally {
    await task.destroy();
  }
}
