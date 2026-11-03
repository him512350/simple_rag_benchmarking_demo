# Prompt Bench

A Vite + React app for comparing individual chatbot answers through OpenRouter. Edit a system prompt, select PDF documents, import questions, choose a model, and run each question independently. Responses include elapsed time and provider-reported token usage. There is no automatic scoring.

## Run locally

Use Node.js 24 and npm.

```sh
npm install
cp .env.example .env.local
# Set OPENROUTER_API_KEY in .env.local
npm run dev
```

Open the local URL printed by Vite. Its development middleware runs the same API handlers used by Vercel, so no separate backend or Vercel login is needed. Restart the dev server after changing environment variables. Without a key the UI displays a configuration error and does not create fake results. `npm run preview` serves the built frontend only; use `npm run dev` or Vercel for API requests.

```sh
npm test
npm run build
```

## Deploy to Vercel

Import this repository as a Vite project, use Node.js 24, and set **OPENROUTER_API_KEY** in the project's server environment variables. The build command is `npm run build` and output directory is `dist`. The `api/models.js` and `api/benchmark.js` files are ESM Node.js functions; `vercel.json` configures a 60-second benchmark function duration. The upstream request is cancelled after 55 seconds. No credentials belong in `VITE_*` variables, source files, or the browser.

Use Vercel Deployment Protection and set an OpenRouter key spending limit before sharing a deployment. These endpoints spend the server account's credits and do not implement authentication or a global rate limit. There is no arbitrary upstream URL or client-supplied message proxy: only the configured OpenRouter endpoints are used. The frontend runs at most two cases concurrently; direct HTTP clients are not constrained by that browser queue.

## Use

- A CSV needs one column named `input`, one question per row. Header case and surrounding spaces are ignored. Extra columns are ignored; IDs are generated. Quoted commas, multiline fields, and Chinese text are supported. Blank questions are skipped. Invalid imports preserve existing cases.
- Choose a current text-output model from OpenRouter's model metadata. Router/automatic-selection models are excluded. Model metadata is cached on the server for five minutes. The model's supported output-limit parameter is used; the app never silently changes the selected model.
- Upload selectable-text PDFs and check the documents to use. Their **full extracted text**, with document names, is included as reference data for each question. There is no chunking, embedding search, OCR, database, or chat memory. Extraction happens once in the browser. Unselected documents are not sent to OpenRouter.
- The document icon opens the original PDF locally in a separate tab. Selecting documents and reading them are separate actions. Remove documents to free space in the current session.
- The system prompt can be expanded into a larger editor. Edits sync automatically and the prompt draft is saved in this browser's local storage. Documents, extracted content, models selected, and results are kept in memory only; reloading clears them.
- Run all or retry one case. Stop prevents queued cases from starting and aborts active browser requests. A provider may already have accepted a request and may still bill for it. Stopped cases return to queued. Changing model, prompt, or documents clears previous results. Each run captures its model, prompt, and document selection for CSV attribution.
- Export includes answers, status/error, elapsed milliseconds, token usage, selected model ID, document names, and the full system prompt. Missing provider usage stays empty rather than becoming zero. Token-cap truncation is identified in the response table.

## Fixed limits

| Item | Limit |
| --- | --- |
| PDF file | 5 MiB, 10 pages, at most 10 files in the page |
| Selected document text | 60,000 JavaScript characters total |
| System prompt | 12,000 characters |
| Question | 4,000 characters |
| CSV | 1 MiB, 50 nonblank questions |
| Request JSON | 256 KiB (UTF-8, checked in browser and server) |
| Model output | 1,024 tokens per case |

Scanned, password-protected, damaged PDFs, and **any PDF containing a page without selectable text (including blank pages)** are rejected. PDF extraction captures text, not page layout, tables, or images. Documents are not silently truncated. The model context check uses UTF-8 bytes plus an output reserve and message overhead as a conservative token upper bound; it is not a precise tokenizer and can reject content that a model might otherwise fit. Provider-specific model restrictions can still cause an individual case to fail.

Sending a benchmark shares the selected extracted PDF text, system prompt, and question with OpenRouter and its selected model provider. Files themselves are not uploaded to app storage. There is no database and nothing is uploaded to Google Drive.

The original standalone design is preserved in `Prompt Bench.html` as a historical prototype. The running application is `src/App.jsx`.

## Verification

`npm test` covers API validation, fixed upstream requests, secret handling, metadata filtering/caching, output limits, context limits, cancellation, and CSV parsing/export. Browser checks use mocked OpenRouter responses when no server key is available; those checks do not establish live provider accuracy or performance. No production deployment is required to build or test locally.

Verified with Node.js 24: ten automated tests and the production build pass. Chrome browser checks covered English and Chinese PDF text extraction, multiple selected documents, file/page/text limits, CSV import, cancellation with two active requests, retries and provider errors, token display/truncation, full-prompt/document attribution in exports, and 320/390/920/1440-pixel layouts. The model dialog was also checked with over 400 real model metadata entries. Completion responses and reported durations in these browser checks were mocked: no paid/live completion request or deployed Vercel execution was performed.
