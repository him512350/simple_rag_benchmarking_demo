import { LIMITS } from './limits.js';

export async function extractPDFText(bytes, load, signal) {
  if (bytes.byteLength > LIMITS.fileBytes) throw new Error('Each PDF must be 5 MB or smaller.');
  const task = load({ data: bytes, isEvalSupported: false });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('PDF validation timed out.');
    const pdf = await task.promise;
    if (!pdf.numPages || pdf.numPages > LIMITS.pdfPages) throw new Error('Each PDF must have 1 to 10 pages.');
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (signal?.aborted) throw new Error('PDF validation timed out.');
      const content = await (await pdf.getPage(i)).getTextContent();
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
  } finally { signal?.removeEventListener('abort', abort); await task.destroy(); }
}
