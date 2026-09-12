# Velsign

An original agreement preparation and electronic signing workspace. The browser interface is plain HTML, CSS, and JavaScript ES modules. PDF.js renders document pages, an optional WebGPU pipeline composites page textures, and accessible DOM controls provide the editor. A Cloudflare Worker API stores agreements in D1 and document bytes in R2.

## GitHub repository and Pages edition

- Source: https://github.com/wieslawsoltes/Velsign
- GitHub Pages deployment target: https://wieslawsoltes.github.io/Velsign/
- Backend-powered private deployment: https://velsign.wisodev.chatgpt.site

The GitHub Pages edition is a **browser-local signing demo**. It stores agreements, uploaded PDF bytes, templates, contacts, and notes in IndexedDB on the current browser. It does not upload data to the private deployment or provide verified identities or collaboration across users/devices. The interface labels this mode explicitly. Use `local@velsign.example` as the recipient for self-signing demonstrations. Download important documents before clearing site data.

The complete backend implementation and database migrations are also included. Real authenticated multi-user operation requires deploying that backend and configuring its trusted identity gateway and D1/R2 bindings. This repository omits the private deployment’s project identifier so another checkout cannot accidentally target that Site.

Build the static edition with Node.js 24:

```sh
node scripts/build-pages.mjs
node scripts/check-pages.mjs
```

This emits `dist-pages/` with relative paths, a PDF worker, fonts, sample PDFs, and the native HTML/JavaScript app. Generated third-party browser assets are committed for a self-contained static build; their dependency versions and regeneration script are retained.

`.github/workflows/pages.yml` runs the tests, builds the static edition, and deploys on every push to `main`. GitHub Pages must use **Settings → Pages → Source → GitHub Actions**. The PR workflow validates changes without publishing. If repository administration has not enabled Pages yet, configure that setting once and rerun the deployment workflow.

For local development, install the locked dependencies with `pnpm install --frozen-lockfile`, run `pnpm test`, and serve `dist-pages/` through an HTTP server. The backend’s `pnpm build` remains available separately.

## Working features

- Agreement overview, counts derived from saved data, searchable and sortable agreement tables, selection, CSV reporting, and activity notifications.
- PDF upload and PNG/JPEG conversion, multiple documents per agreement, page viewing, zoom, visible-page rendering, text extraction, and completed PDF download.
- Signature, initials, name, email, date, text, checkbox, dropdown, number, company, and title fields. Drag or click to place; drag to move; eight resize handles; field labels; required flags; recipient assignment; simple conditional visibility; undo/redo; keyboard movement; automatic signature/date placement.
- Signer, approver, and copy roles; parallel, sequential, and same-order routing; recipient name/email validation; explicit activation; locked content after activation; expiration enforcement; decline and void workflows.
- Account-bound signing, electronic consent, typed/drawn/uploaded PNG signatures, server validation of required values, sequential progression, and final completion only after all signing/approval recipients finish.
- Durable team comments, resolve/reopen, agreement-specific editor/viewer permissions, five-second presence/update polling, revision conflict detection, and recovery downloads for unsaved edits. The editor deliberately rejects stale saves; it does not silently replace a collaborator’s work.
- Custom templates containing documents, roles, and field positions; fresh template instances; document copying; contacts; profile settings; light and dark themes; responsive layouts.
- Internal SHA-256 chained audit events, document hashes, an activation event binding document/field/routing configuration, Unicode-aware PDF output, and a paginated signing record.
- Three feature-detected WebMCP tools: list agreements, open agreement, and start the upload flow. None signs or activates an agreement implicitly.

## Use the app

1. Sign in. Upload a document, select a starter template, or add sample agreements from the initial welcome dialog.
2. Add recipients and choose their roles and signing order. Use **Only I need to sign** for a self-signing workflow.
3. Drag fields onto the document. Every signer must have an unconditional required signature field. Copy recipients cannot own fields.
4. Save and choose **Review & activate**. Activation freezes the document and field configuration.
5. Share recipient links manually. A recipient must have access to the hosted app and sign in with the exact assigned email. The link is a navigation aid; account authentication is the authorization boundary. Void the agreement to cancel signing access.
6. Review, consent, complete required fields, and finish signing. Download the agreement and its signing record.

Sample agreements are labeled. They do not grant the owner permission to impersonate another recipient. One sample is addressed to the signed-in owner so the complete signing flow can be explored.

## Source layout

| Path | Purpose |
|---|---|
| `app/workspace.html` | Native browser document and module entrypoint |
| `public/style.css` | Responsive light/dark application theme |
| `public/js/app.js` | Workspace, editor, signing, and collaboration UI |
| `public/js/core.js` | Reusable state transitions, validation, routing, audit hashing |
| `public/js/renderer.js` | PDF.js page renderer, WebGPU compositor, PDF exports |
| `server/service.js` | Request handling, authorization, durable reads/writes |
| `app/api/[...path]/route.ts` | Thin Worker API adapter |
| `db/schema.ts`, `drizzle/` | D1 schema and generated migration |
| `tests/` | Workflow, authorization, concurrency, and export regression tests |
| `scripts/vendor.mjs` | Rebuild self-hosted browser PDF/font dependencies |
| `scripts/generate-samples.mjs` | Regenerate the three sample PDFs and their hashes |

The browser UI uses no React rendering. Vinext/Vite supplies the deployment scaffold and request routing, and the repository retains that starter’s dependencies. The application’s browser modules can be served by any same-origin server implementing the API.

## Runtime and development

Requires Node.js 24 for the native SQLite test adapter, pnpm 11.25.0, D1, R2, and a trusted identity gateway in production.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

The source declares logical `DB` and `BUCKET` bindings in `.openai/hosting.json`. Hosting provisions and wires them. The schema migration is `drizzle/0000_tranquil_mach_iv.sql` and contains only schema statements. `pnpm db:generate` creates a new migration after schema changes; published migrations must not be rewritten.

For the starter’s standalone portable development environment, `pnpm dev` serves the app and provides the bundled loopback-only sign-in path. Managed preview and publishing use the Sites lifecycle. No application API keys are required. `.env.example` lists the binding/identity contract without secrets.

The hosted dispatcher supplies `oai-authenticated-user-id`, `oai-authenticated-user-email`, and optional display name headers. They are trusted only because the production gateway controls them. An independent deployment must strip untrusted incoming identity headers and authenticate users before injecting them; this repository does not include a standalone public authentication provider.

## API outline

All API routes require authenticated identity. Mutations reject cross-origin browser requests.

| Endpoint | Operations |
|---|---|
| `/api/bootstrap` | Current user/profile and accessible agreement summaries |
| `/api/envelopes` | Create a draft or template |
| `/api/envelopes/:id` | Read authorized agreement state |
| `/api/envelopes/:id/action` | Revision-checked edit, activate, sign, decline, void, reminder preparation |
| `/api/envelopes/:id/duplicate` | Create a fresh agreement or template copy |
| `/api/envelopes/:id/links` | Create a random, hashed recipient navigation token |
| `/api/envelopes/:id/comments` | Read/add/resolve collaborative comments |
| `/api/envelopes/:id/members` | List/grant/revoke agreement access |
| `/api/envelopes/:id/presence` | Heartbeat and current revision |
| `/api/envelopes/:id/audit` | Verify internal chain and return document hashes/events |
| `/api/files` | Upload a validated PDF |
| `/api/files/:id?envelope=:id` | Download authorized original PDF |
| `/api/sign/:envelope/:recipient` | Open an account-bound signing session |
| `/api/contacts`, `/api/profile` | Owner-scoped address book and profile |

Agreement updates use one compare-and-swap SQL update containing workflow state and audit events, so a signature cannot commit separately from its audit event. Comments, memberships, and presence are independent records. Uploaded files are immutable; copies receive new storage objects. Bootstrap never exposes draft agreements merely because an email was added as a prospective recipient.

## Rendering and performance

PDF interpretation and rasterization run through PDF.js, including its worker. This is not a native GPU PDF interpreter. WebGPU uploads the rendered page and draws a textured quad; unsupported or failed adapters use Canvas. Fields remain DOM overlays for keyboard input, pointer editing, and accessibility.

An IntersectionObserver renders pages within the viewport margin and releases offscreen page textures. Zoom controls raster scale, capped at 2.2x to limit large textures. Page textures and in-flight render tasks are cleaned up when the editor is rebuilt. Database indexes support owner lists, memberships, comments, and presence. Collaboration polls every five seconds; it is not a WebSocket/CRDT synchronization engine.

## Verification

`pnpm test` runs the backend, export, static-path, and IndexedDB tests (34 original regression checks plus Pages coverage) against the actual state-transition and API code with a native SQLite adapter and an in-memory R2-compatible byte store. Coverage includes account isolation, draft privacy, forged file references, role permissions, concurrent updates, required fields/consent, order enforcement, malformed signature images, completion locking, audit tampering, template isolation, comments, presence, persistence across service reconstruction, and PDF export/Unicode/wrapping/pagination.

The production build has been validated. The export tests exercise the real export implementation with PDF.js page viewing stubbed out, because no browser is used by that test. Physical WebGPU devices, full browser interaction, mobile/stylus hardware, WebMCP registration in a supported browser, and production load/security qualification have not been validated here.

## Explicit capability boundaries

This release is a functional original implementation of the principal prepare/sign/manage workflows. It is not full feature parity with the referenced enterprise product and is not a certified electronic trust service.

- Hosting is initially private to the owner. Agreement-level sharing does not expand the app’s audience. Cross-user use requires both app access and agreement/recipient authorization.
- Email/SMS delivery, automatic reminders, bulk sending, external webhooks/integrations, payments, enterprise SSO/admin, ID-document verification, advanced delegation, and distributed event delivery are not implemented.
- Audit chaining is internal integrity checking. There is no PKI signing certificate, qualified signature, independently trusted timestamp, external notarization, or compliance certification. An operator with database write authority can rewrite the chain; downloaded PDFs are not cryptographically sealed.
- Editing adds signature/form fields over a PDF. It does not edit arbitrary original PDF text, perform OCR, author rich contract content, compare/redline versions, or implement a contract lifecycle management/AI system. Native DOCX import is not supported.
- PDFs are limited to 10 MB and 100 pages each, 20 documents per agreement, 25 recipients, and 1,000 placed fields. Rotated, cropped/nonzero-origin, encrypted, and existing AcroForm PDFs must be flattened/normalized before upload; unsupported geometry is rejected so preview and export do not silently disagree.
- Unicode exports use the bundled DejaVu Sans font. Complete complex-script shaping, every PDF feature/font, accessibility-tag preservation, PDF/A, and third-party signature preservation are not certified. Long text is wrapped/scaled into its field and may require a larger field for readability.
- Conditional fields support a single equality test against an unconditional field assigned to the same recipient. They do not implement arbitrary rule expressions or calculations.
- Conflict handling prevents overwrite and offers a JSON recovery download. Automatic merge, character-level collaboration, offline durable editing, and recovery-file import are not implemented.
- File copy/metadata operations can leave unused objects after interrupted operations. Automated orphan cleanup, retention/legal holds, tenant quotas, detailed rate limiting, malware scanning, long-running monitoring, and large-scale operational hardening remain work.

## Dependencies and references

The implementation follows the public prepare/sign/manage workflow described in the reference product’s [eSignature overview](https://www.docusign.com/blog/how-does-docusign-esignature-work) and [feature documentation](https://www.docusign.com/products/electronic-signature/features). The design and branding are original; no proprietary client source, assets, or compatibility claim is included.

PDF rendering follows [PDF.js](https://mozilla.github.io/pdf.js/examples/), document export uses [pdf-lib](https://pdf-lib.js.org/), and GPU composition uses the [WebGPU API](https://gpuweb.github.io/gpuweb/). Browser dependencies are self-hosted with the app. Their licenses are retained in `public/vendor/`; DejaVu fonts retain their accompanying license.
