export const LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  pdfPages: 10,
  files: 10,
  contextChars: 60000,
  systemChars: 12000,
  questionChars: 4000,
  requestBytes: 256 * 1024,
  defaultsBytes: 3 * 1024 * 1024,
  responseChars: 32000,
  errorChars: 2000,
  projects: 50,
  blobEntries: 10000,
  blobPages: 100,
  csvBytes: 1024 * 1024,
  cases: 50,
  outputTokens: 4096,
});
export const utf8Bytes = value => new TextEncoder().encode(value).length;
