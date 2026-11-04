# Prompt Bench

A Vite + React app for comparing individual chatbot answers through OpenRouter. Choose a project, edit its system prompt, select PDF documents, import questions, choose a model, and run each question independently. Responses include elapsed time and provider-reported token usage. There is no automatic scoring.

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

Use Vercel Deployment Protection and set an OpenRouter key spending limit before sharing a deployment. These endpoints spend the server account's credits and do not implement authentication or a global rate limit. There is no arbitrary upstream URL or client-supplied message proxy: only the server-configured completion endpoint and official public model metadata endpoint are used. The frontend launches selected cases concurrently (up to 50); direct HTTP clients are not constrained by the 50-case UI limit. Admin login protects saving shared defaults, not benchmark calls. Configure deployment protection and provider spending limits separately.

## Use

- **Import CSV/ XLSX** accepts `.csv` or `.xlsx` files with one column named `input`, one question per row. For XLSX, only the first worksheet is read. Header case and surrounding spaces are ignored. Extra columns/sheets are ignored; IDs are generated. Quoted CSV fields, multiline text, and Chinese are supported. Blank questions are skipped. Input cells must be plain text: formulas (even cached results), merged input cells, numbers, dates, and booleans in XLSX are rejected. Invalid imports preserve existing cases and results. Legacy `.xls`, macro-enabled files, encrypted/corrupt workbooks, and renamed non-workbooks are unsupported.
- New runs currently use only `qwen/qwen3.8-flash`, selected from OpenRouter’s compatible text-model metadata. The server rejects other model IDs, and the UI never silently switches to another model if the configured model is unavailable. Router/automatic-selection models are excluded. Model metadata is cached on the server for five minutes. The model's supported output-limit parameter is used; the app never silently changes the selected model.
- Admins can upload selectable-text PDFs. All visitors can check the saved documents to use. Their **full extracted text**, with document names, is included as reference data for each question. There is no chunking, embedding search, OCR, database, or chat memory. Extraction happens once in the browser. Unselected documents are not sent to OpenRouter.
- The document icon opens the original PDF in a separate tab. Selecting documents and reading them are separate actions. Only admins see PDF upload and document Remove controls. Guests can select documents, open PDFs, edit the prompt, import questions, and run benchmarks; refresh restores the saved project.
- The system prompt can be expanded into a larger editor. Edits sync automatically within this page. On each visit or refresh, the selected project’s saved prompt, PDF library, benchmark cases, and results are loaded. Guest changes are temporary; no data is read from or written to local storage. Admins explicitly save project data. The current project is selected with the URL’s `project` query parameter; model selection is not persisted.
- Run all or retry one case. Stop prevents queued cases from starting and aborts active browser requests. A provider may already have accepted a request and may still bill for it. Stopped cases return to queued. Changing model, prompt, or documents clears previous results. Each case captures its own model, prompt, document names and text hashes, and run date. Retrying one case does not change the historical source of other cases. Loaded results are marked **Admin-saved** and show their original model ID, even if that model is no longer available.
- Export includes answers, status/error, elapsed milliseconds, token usage, each row’s original model ID, document names and SHA-256 fingerprints, full run prompt, run date, and project ID/name. Missing provider usage stays empty rather than becoming zero. When a model reaches the output limit, partial text stays visible with a warning and a manual Retry action. If the limit is reached before any answer text arrives, the case shows an explicit error while preserving available time, token usage, and finish reason. The app does not retry automatically or change the model’s reasoning settings. Each row records its actual output limit; older saved rows without this field retain their original 1,024-token limit, while new requests use 4,096. CSV exports include `output_limit`.

## Fixed limits

| Item | Limit |
| --- | --- |
| PDF file | 5 MiB, 10 pages, at most 10 files in the page |
| Selected document text | 60,000 JavaScript characters total |
| System prompt | 200,000 characters |
| Question | 4,000 characters |
| CSV | 1 MiB, 50 nonblank questions |
| XLSX | 5 MiB; first worksheet; 50 nonblank questions |
| XLSX archive / parsing | 200 entries, 20 MiB expanded total, 8 MiB per entry, 50,000 stored first-sheet cells, 10-second worker timeout |
| Benchmark request JSON | 2 MiB (UTF-8, checked in browser and server) |
| Project save request / manifest | 3 MiB (UTF-8) |
| Saved answer / error | 32,000 / 2,000 characters per case |
| Projects | 50, including Default; names are fixed at creation |
| Storage listing | 10,000 entries / 100 pages per operation; excess is an explicit error |
| Model output | 4,096 tokens per new case |

Scanned, password-protected, damaged PDFs, and **any PDF containing a page without selectable text (including blank pages)** are rejected. PDF extraction captures text, not page layout, tables, or images. Documents are not silently truncated. The model context check uses UTF-8 bytes plus an output reserve and message overhead as a conservative token upper bound; it is not a precise tokenizer and can reject content that a model might otherwise fit. Provider-specific model restrictions can still cause an individual case to fail.

Sending a benchmark shares the selected extracted PDF text, system prompt, and question with OpenRouter and its selected model provider. Guest files stay in the browser. Admins explicitly saving shared defaults upload PDFs to public Vercel Blob storage. There is no database and nothing is uploaded to Google Drive.

The original standalone design is preserved in `Prompt Bench.html` as a historical prototype. The running application is `src/App.jsx`.

## Verification

`npm test` covers API validation, fixed upstream requests, secret handling, metadata filtering/caching, output limits, context limits, cancellation, and CSV parsing/export. Browser checks use mocked OpenRouter responses when no server key is available; those checks do not establish live provider accuracy or performance. No production deployment is required to build or test locally.

Verified with Node.js 24: 58 automated tests and the production build pass. Chrome browser checks covered English and Chinese PDF text extraction, multiple selected documents, file/page/text limits, CSV import, cancellation of concurrent requests, retries and provider errors, token display/truncation, full-prompt/document attribution in exports, and 320/390/920/1440-pixel layouts. The model dialog was also checked with over 400 real model metadata entries. Completion responses and reported durations in these browser checks were mocked: no paid/live completion was performed.

## Shared defaults and admin login

Create a **public** Vercel Blob store and connect it to this Vercel project. Current connections use OIDC by default: Vercel supplies `BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`, and request-scoped identity automatically. A long-lived `BLOB_READ_WRITE_TOKEN` is not required. The Blob SDK resolves and refreshes OIDC credentials for listing, reading, saving, and issuing short-lived presigned PDF upload grants. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET` (a random secret of at least 32 characters). Redeploy after changing environment variables. Local development reads these same names from `.env.local`; restart `npm run dev` after edits. With a linked Vercel project, `vercel env pull` can provide local OIDC settings (`BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`, and the webhook public key). The SDK handles refresh. Alternatively, use an optional legacy `BLOB_READ_WRITE_TOKEN` without `BLOB_STORE_ID` for local server operations; presigned PDF uploads still require the store’s `BLOB_WEBHOOK_PUBLIC_KEY`. When a store ID is present, the app prefers SDK-managed OIDC rather than forcing a legacy token. Production and preview deployments using the same Blob store share their defaults; use separate stores when preview edits must be isolated.

Log in using **Admin login**, create a named project with **New project**, or choose an existing project. A new project starts with the sample prompt and questions, an empty PDF library, and no results. Edit and run cases, then press **Save project**. Saving replaces that project’s prompt, complete PDF library (including checked states), benchmark inputs, and completed/error/queued cases. Each completed or failed case retains its original run details; unrun cases do not acquire invented answers or run provenance. Model selection itself is not saved. Guests can switch projects, edit the prompt, import questions, select/read saved PDFs, and run all or individual cases temporarily, but cannot upload/remove PDFs or create/save projects. If storage is not configured, the UI clearly says so and saving is disabled. If a selected project cannot be loaded, editing and running stay locked until a successful retry, and no previous project’s content remains displayed. A truly empty store exposes Default with the sample prompt, sample questions, and an empty library. Invalid project IDs fail; an unknown valid ID does not fall back to another project.

**Saved project names, prompts, PDFs, questions, answers, error details, and run provenance are public** and intended for everyone visiting the app. Do not save confidential content. Public PDF URLs remain readable without admin login. Files upload directly to Blob through short-lived, PDF-only presigned grants only when an admin saves; guest sessions cannot request Blob upload credentials. The server re-downloads canonical PDFs from this store, checks size and selectable text/page limits using PDF.js, and only then commits an immutable defaults manifest. No extracted full text is stored in the manifest.

Creating a project and saving a project each use a single immutable manifest write after validation. Project IDs and encoded names are contained in their version paths; there is no separate catalog write. Visitors list bounded metadata to discover projects, download only the chosen project’s newest version, then re-extract its PDF text in their browser. The newest upload time wins within each project, with pathname as a tie-breaker; there is no version-management UI. Existing global v1 defaults remain readable as Default only while Default has no v2 project version and has not been deleted. Reading does not migrate or write old data; corrupt v2 data never silently falls back to v1. Validation/upload failures leave the previously committed defaults intact and retain local edits for retry. If the final commit's acknowledgement is lost, reload to check which version was saved. Successfully uploaded staged files are reused on retry. Removing a document only removes it from a future saved library; old versions and orphaned uploads are not automatically deleted. Manage retained files manually in the Blob dashboard.

Admin sessions last eight hours in a signed, HttpOnly, SameSite=Strict cookie (Secure on Vercel and production HTTPS). Changing the username, password, or session secret invalidates existing sessions. Login, logout, saving, and upload-token issuance require a same-origin JSON request. No credentials or server tokens are sent to the frontend bundle. Login uses environment credentials and does not provide account registration, password recovery, or a global login rate limit.

Shared-default verification additionally covers signed sessions, credential rotation, same-origin writes, unauthorized uploads, unsigned SDK callbacks, canonical file validation with the real Node PDF parser, immutable-version pagination, and preserving committed defaults on validation failure. Browser checks used the real upload client SDK with mocked Blob token/PUT responses to test guest refresh behavior, admin saving/logging out, failed-save retry without duplicate uploads, load failures, and delayed initial requests. Storage writes were tested with mocked transport rather than production credentials. The deployment was also checked through its public read-only defaults endpoint; no cloud save or paid completion was submitted. Vercel packaging explicitly includes the legacy PDF worker and optional native canvas files; Node.js 24 parsing/build were verified locally.

OIDC regression checks exercise the actual Blob SDK with mocked HTTP transport and a Vercel request-context identity, without a legacy token. They verify list/head/put, full PDF save/reload metadata, scoped presigned upload grants, real Ed25519 callback acceptance/rejection, and rejection of cross-store document URLs. Store connection identifiers alone do not imply authorization: SDK read failures stay errors instead of falling back to sample defaults.

Project regression checks cover atomic creation, per-project isolation and URL refresh, read-only v1 compatibility, malformed/missing projects, catalog limits, result allowlists and UTF-8 size limits, retired-model provenance, per-row retry/export attribution, and delayed project loads/imports/saves/creation/runs. Browser tests also validate real PDF extraction and server-side hashing on save/reload, plus cancellation and sequence guards that prevent late work from changing a newly selected project. All project writes in verification use mocked storage; no online migration, project creation, or save is performed by the test suite.

## Delete projects

Admins can press **Delete project** and confirm the displayed project name. Cancelling sends no request. Deletion requires an authenticated, same-origin JSON request and an exact project-name confirmation. Guests do not see this action. Default and the final remaining project may be deleted. The app selects another available project afterward; when none remain it shows **No projects**, disables editing/running/saving/uploads, and lets an admin create a fresh project. A deleted project URL returns a clear error with navigation to available projects rather than falling back silently.

Deletion writes an immutable tombstone under `prompt-bench/deleted-projects/<id>.json`. The catalog checks those markers before any normal or legacy versions, so even a stale save completing after deletion cannot restore the deleted project. New projects always receive a new ID. **This removes the project from the app, not from public Blob storage:** PDFs and old manifests are retained, including PDFs referenced by other projects. Their existing public URLs can remain accessible. Do not delete tombstones during storage maintenance, or older versions could become visible again. No `blob.del` operation is used by the app.

Deletion regression checks cover authorization/CSRF, confirmation mismatch, Default/last-project empty state, stale concurrent saves, legacy masking, invalid tombstone paths, failure handling, and preserving physical files. Mocked browser checks cover guest document controls, confirmation cancellation, selection after deletion, deleted URLs, new-project creation from empty, and late delete responses during navigation. No live project or PDF was deleted during verification.

## Model restriction and loading states

The single shared configuration is `lib/model-config.js`. To restore all otherwise-compatible OpenRouter text models, change its setting to `export const ALLOWED_MODEL_IDS = null;`. The default model remains `qwen/qwen3.8-flash` when available; unrestricted mode otherwise chooses the first compatible model. Restricted mode shows an error if the configured model is missing and never falls back to another model. Historical result sources remain unchanged, and clicking an already-selected model does not clear them.

Project loading uses accessible skeleton placeholders for the prompt, knowledge base, and cases until saved PDFs have finished text extraction. They respect reduced-motion preferences, disappear on success/error/empty results, and do not obscure already-loaded historical results while model metadata is still loading.

## Spreadsheet imports

The XLSX parser is loaded dynamically only after an `.xlsx` file is selected and runs in a dedicated worker. It uses the official SheetJS 0.20.3 distribution from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and `fflate` for bounded ZIP validation. No legacy registry `xlsx` release is installed. The parser checks central-directory and actual expanded sizes, completes every entry, rejects macros, and iterates sparse cell keys rather than expanding a worksheet’s dimension rectangle. Exceeded limits fail explicitly; rows are never silently truncated. Imported questions can be saved with the project using the existing admin save action.

Verification covers real XLSX fixtures with Chinese/multiline values, first-sheet selection, cached and uncached formulas, input merges/types, sparse dimensions, ZIP data descriptors, size mismatch/expansion limits, wrong formats, preservation of existing results on error, import/navigation races, and import-save-reload. Production-build browser checks confirm CSV imports do not load the XLSX chunk or worker until an XLSX selection occurs. All storage and completion transport in these tests is mocked.

Only checked knowledge documents are sent with a benchmark. With none checked, the server receives no document context and sends the question with the system prompt alone. A URL written inside the prompt remains ordinary prompt text: this app does not fetch that web page automatically. This does not change the model provider’s own capabilities.

### Company completion gateway

Set `OPENROUTER_BASE_URL=https://projteam-openrouter-proxy-790311698684.asia-east1.run.app/v1` and put the gateway key in server-only `OPENROUTER_API_KEY` for Vercel Production, then redeploy. Omitting the base URL uses `https://openrouter.ai/api/v1`. Only HTTPS bases without credentials, query strings or fragments are accepted; redirects are rejected. Model metadata always comes from the official public OpenRouter models endpoint without Authorization. Completion requests use the configured endpoint and its key. Run all starts every case that is not already running immediately. Individual Run/Retry buttons can start other cases while requests are active; the same case cannot run twice at once. Stop aborts all active requests. The gateway may reject concurrent requests with 429; there is no automatic retry. A 429 can mean the weekly allowance is exhausted or another request is still in progress. Historical model sources remain unchanged.

System prompt limits use JavaScript string length (UTF-16 code units), consistent with the editor counter. Saved projects still have a 3 MiB JSON limit: each completed row retains its full original prompt, so many results with long prompts can exceed that limit. Such saves fail without replacing the previous saved version. The benchmark request limit is 2 MiB; actual model context capacity is checked separately, including the server reference policy and output reserve.
