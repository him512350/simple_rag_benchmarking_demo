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

Use Vercel Deployment Protection and set an OpenRouter key spending limit before sharing a deployment. These endpoints spend the server account's credits and do not implement authentication or a global rate limit. There is no arbitrary upstream URL or client-supplied message proxy: only the configured OpenRouter endpoints are used. The frontend runs at most two cases concurrently; direct HTTP clients are not constrained by that browser queue. Admin login protects saving shared defaults, not benchmark calls. Configure deployment protection and provider spending limits separately.

## Use

- A CSV needs one column named `input`, one question per row. Header case and surrounding spaces are ignored. Extra columns are ignored; IDs are generated. Quoted commas, multiline fields, and Chinese text are supported. Blank questions are skipped. Invalid imports preserve existing cases.
- Choose a current text-output model from OpenRouter's model metadata. Router/automatic-selection models are excluded. Model metadata is cached on the server for five minutes. The model's supported output-limit parameter is used; the app never silently changes the selected model.
- Upload selectable-text PDFs and check the documents to use. Their **full extracted text**, with document names, is included as reference data for each question. There is no chunking, embedding search, OCR, database, or chat memory. Extraction happens once in the browser. Unselected documents are not sent to OpenRouter.
- The document icon opens the original PDF in a separate tab. Selecting documents and reading them are separate actions. Remove documents to free space in the current session.
- The system prompt can be expanded into a larger editor. Edits sync automatically within this page. On each visit or refresh, the shared prompt and PDF library are loaded. Guest edits and uploads are temporary; no prompt is read from or written to local storage. CSV cases, model selection, and results are never saved.
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

Sending a benchmark shares the selected extracted PDF text, system prompt, and question with OpenRouter and its selected model provider. Guest files stay in the browser. Admins explicitly saving shared defaults upload PDFs to public Vercel Blob storage. There is no database and nothing is uploaded to Google Drive.

The original standalone design is preserved in `Prompt Bench.html` as a historical prototype. The running application is `src/App.jsx`.

## Verification

`npm test` covers API validation, fixed upstream requests, secret handling, metadata filtering/caching, output limits, context limits, cancellation, and CSV parsing/export. Browser checks use mocked OpenRouter responses when no server key is available; those checks do not establish live provider accuracy or performance. No production deployment is required to build or test locally.

Verified with Node.js 24: 27 automated tests and the production build pass. Chrome browser checks covered English and Chinese PDF text extraction, multiple selected documents, file/page/text limits, CSV import, cancellation with two active requests, retries and provider errors, token display/truncation, full-prompt/document attribution in exports, and 320/390/920/1440-pixel layouts. The model dialog was also checked with over 400 real model metadata entries. Completion responses and reported durations in these browser checks were mocked: no paid/live completion request or deployed Vercel execution was performed.

## Shared defaults and admin login

Create a **public** Vercel Blob store and connect it to this Vercel project. Current connections use OIDC by default: Vercel supplies `BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`, and request-scoped identity automatically. A long-lived `BLOB_READ_WRITE_TOKEN` is not required. The Blob SDK resolves and refreshes OIDC credentials for listing, reading, saving, and issuing short-lived presigned PDF upload grants. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET` (a random secret of at least 32 characters). Redeploy after changing environment variables. Local development reads these same names from `.env.local`; restart `npm run dev` after edits. With a linked Vercel project, `vercel env pull` can provide local OIDC settings (`BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`, and the webhook public key). The SDK handles refresh. Alternatively, use an optional legacy `BLOB_READ_WRITE_TOKEN` without `BLOB_STORE_ID` for local server operations; presigned PDF uploads still require the store’s `BLOB_WEBHOOK_PUBLIC_KEY`. When a store ID is present, the app prefers SDK-managed OIDC rather than forcing a legacy token. Production and preview deployments using the same Blob store share their defaults; use separate stores when preview edits must be isolated.

Log in using **Admin login**, edit the prompt and library, then press **Save as default**. Saving replaces the entire shared library, including each document's checked state. It does not save CSV cases, model selection, or results. Guests can edit, upload, and benchmark temporarily but cannot save shared defaults. If storage is not configured, the UI clearly says so and saving is disabled. If saved content cannot be loaded, editing and running stay locked until a successful retry; existing defaults are not silently replaced with samples. A truly empty store starts with the sample prompt and an empty library.

**Saved prompts and PDFs are public** and intended for everyone visiting the app. Do not save confidential content. Public PDF URLs remain readable without admin login. Files upload directly to Blob through short-lived, PDF-only presigned grants only when an admin saves; temporary guest uploads never request Blob upload credentials. The server re-downloads canonical PDFs from this store, checks size and selectable text/page limits using PDF.js, and only then commits an immutable defaults manifest. No extracted full text is stored in the manifest.

Each save creates a new immutable version after all files pass validation. Visitors find the newest completed version by upload time across all listing pages, then re-extract its PDF text in their browser. The last completed save wins; there is no version-management UI. Validation/upload failures leave the previously committed defaults intact and retain local edits for retry. If the final commit's acknowledgement is lost, reload to check which version was saved. Successfully uploaded staged files are reused on retry. Removing a document only removes it from a future saved library; old versions and orphaned uploads are not automatically deleted. Manage retained files manually in the Blob dashboard.

Admin sessions last eight hours in a signed, HttpOnly, SameSite=Strict cookie (Secure on Vercel and production HTTPS). Changing the username, password, or session secret invalidates existing sessions. Login, logout, saving, and upload-token issuance require a same-origin JSON request. No credentials or server tokens are sent to the frontend bundle. Login uses environment credentials and does not provide account registration, password recovery, or a global login rate limit.

Shared-default verification additionally covers signed sessions, credential rotation, same-origin writes, unauthorized uploads, unsigned SDK callbacks, canonical file validation with the real Node PDF parser, immutable-version pagination, and preserving committed defaults on validation failure. Browser checks used the real upload client SDK with mocked Blob token/PUT responses to test guest refresh behavior, admin saving/logging out, failed-save retry without duplicate uploads, load failures, and delayed initial requests. Storage writes were tested with mocked transport rather than production credentials. The deployment was also checked through its public read-only defaults endpoint; no cloud save or paid completion was submitted. Vercel packaging explicitly includes the legacy PDF worker and optional native canvas files; Node.js 24 parsing/build were verified locally.

OIDC regression checks exercise the actual Blob SDK with mocked HTTP transport and a Vercel request-context identity, without a legacy token. They verify list/head/put, full PDF save/reload metadata, scoped presigned upload grants, real Ed25519 callback acceptance/rejection, and rejection of cross-store document URLs. Store connection identifiers alone do not imply authorization: SDK read failures stay errors instead of falling back to sample defaults.
