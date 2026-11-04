import { rowsFromXLSX } from './xlsx.js';

self.onmessage = event => {
  try { self.postMessage({ rows: rowsFromXLSX(event.data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
