export const LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  pdfPages: 10,
  files: 10,
  contextChars: 60000,
  systemChars: 12000,
  questionChars: 4000,
  requestBytes: 256 * 1024,
  csvBytes: 1024 * 1024,
  cases: 50,
  outputTokens: 1024,
});
export const utf8Bytes = value => new TextEncoder().encode(value).length;
