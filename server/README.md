# Teamspace API

Run with `node --import tsx server/index.ts`. The process listens on `127.0.0.1:5181` by default; `PORT` changes the port and `TEAMSPACE_DATA_DIR` changes the local `data/` directory. The browser development server proxies `/api` to this process.

`createApp({dataDir, seed})` exports an Express app, `attachWebSocket(httpServer)`, and a `close()` function for isolated tests. Attach WebSocket handling to the same HTTP server before accepting live document clients. Seed data is clearly synthetic and is created only when no projects or users exist. No Jira, Confluence, Plane, or Docmost data is read or modified.

Storage is SQLite WAL with foreign keys, transactions, per-project issue sequences, and JSON for rich content/arrays. Tickets, documents, workflows, and saved views carry monotonically increasing versions. Send `expectedVersion` when patching, restoring, or applying schedules; a stale version returns HTTP 409. Live documents store authoritative Yjs state and a derived JSON snapshot in the same transaction.

Use `X-Actor-Id` to attribute operations to a team member. This identifies the actor and is **not authentication**. The first team member is used when no actor is supplied. This development API must not be exposed as a multi-user authenticated service without adding access controls. Account editing here changes team contact data; there is no email login, verification, SSO, or password system.

## Supported APIs

- `GET /api/health`, `GET /api/workspace`
- `POST /api/projects`, `POST /api/users`, `PATCH /api/users/:id`
- `POST /api/issues`, `PATCH /api/issues/:id`, `DELETE /api/issues/:id`
- `POST /api/documents`, `PATCH /api/documents/:id`, `DELETE /api/documents/:id`
- `GET /api/documents/:id/revisions`, `POST /api/documents/:id/restore`
- `GET /api/documents/:id/collaboration`, `POST /api/documents/:id/collaboration/enable`, `POST /api/documents/:id/checkpoint`
- `WS /api/collaboration?documentId=...&actorId=...`
- `GET|PATCH /api/projects/:projectId/issue-schema`
- `GET|PATCH /api/projects/:projectId/workflow`
- `GET|POST /api/planning-items`, `GET|PATCH|DELETE /api/planning-items/:id`, `POST /api/planning-items/:id/issues`
- `GET /api/views?projectId=...`, `POST /api/views`, `PATCH|DELETE /api/views/:id`
- `GET|POST /api/api-keys`, `POST /api/api-keys/:id/revoke`, Bearer automation APIs under `/api/v1`
- `GET /api/comments?resourceType=issue|document&resourceId=...`, `POST /api/comments`
- `GET|POST /api/attachments?resourceType=issue|document&resourceId=...` (POST also needs `filename` query; raw `application/octet-stream`)
- `GET /api/attachments/:id/content`, `DELETE /api/attachments/:id`
- `POST /api/resource-links`, `DELETE /api/resource-links/:id`
- `POST /api/dependencies`, `DELETE /api/dependencies/:id`
- `POST /api/schedule/preview`, `POST /api/schedule/apply`, `POST /api/schedule/undo`
- `GET|PATCH /api/projects/:id/calendar`, `POST /api/schedule/auto-preview`, `POST /api/schedule/auto-apply`
- `GET|POST /api/milestones`, `GET|PATCH|DELETE /api/milestones/:id`
- `GET|POST /api/baselines`, `GET|DELETE /api/baselines/:id`
- `GET /api/search?q=...`, `GET /api/export`, `POST /api/import {data: ...}`
- `GET|PATCH /api/integrations/gitlab`, `POST /api/integrations/gitlab/sync`, `POST /api/integrations/gitlab/webhook`

Creates and patches return the resource directly. Revisions and comments return arrays. Errors return `{error, details?}`. The workspace snapshot follows `shared/types.ts` exactly.

## Schedule behavior

Dates may be partial or absent. A start after an end is rejected. Dependencies are FS relationships inside one project and form a directed acyclic graph. Predecessor/successor relationships are distinct from parent/child grouping.

Bulk moves first return a preview and warnings. Working days use each project's calendar (Mon–Fri by default), including explicit nonworking and working-day overrides. Working-day previews return `calendarVersions`; apply checks them when supplied. Direct manual date edits retain their original version checks. FS gap warnings use the project working calendar and are scoped to changed projects. Connecting dependencies does not move dates.

Manual and automatic apply use one shared mutation hook inside their caller's transaction, including issue validation, per-issue/project history, and undo creation. Undo checks every applied version, refuses if anything changed afterward, and creates new versions instead of rewinding counters. It restores exact prior dates and recomputes warnings with the current calendar. Undo is persisted but does not survive native export/import.

Automatic previews accept `{projectId, issueIds?, anchorDate?, defaultDuration?, seedChanges?}`. They include selected tasks and their successors, preserve working duration, and push unseeded dates later to satisfy nonnegative FS working-day gaps. Explicit seed changes use expected issue versions. The anchor and default duration apply only to fully undated tasks when explicitly supplied; estimates are never treated as duration. Partial/zero-workday periods, unknown predecessor end dates, unsupported negative gaps, fixed completed/cancelled conflicts, and cycles block the whole apply. There is no resource leveling or automatic transition to a completed state.

The server persists a 30-minute actor-bound proposal containing all project issue versions, calendar/workflow/issue-schema versions, dependency fingerprint, and generated dates. `/auto-apply {previewId}` checks them and applies only the stored proposal. A workflow reclassification also invalidates the proposal even when issue versions did not change. Results are retained seven days for idempotent retries. Expired unused proposals and old receipts are pruned on startup/new preview; active proposals are not evicted by a count limit. The current limits are 10,000 project issues, 1,000 changed issues per apply, and 3,650 working days per automatically planned duration. Calendar math supports valid four-digit ISO dates with analytical counts and bounded searches.

Milestones use CAS, owner/date/status and same-project ticket links. Ticket deletion removes current milestone links and increments their versions in the same transaction. Baseline capture requires exact `expectedIssueVersions`, `expectedMilestoneVersions` maps and `expectedCalendarVersion`, then atomically captures every project ticket/milestone and the calendar. Captured values are immutable; only deletion with CAS is supported. Missing historical ticket/milestone IDs remain valid snapshots, while live IDs from another project are rejected. Baseline comparison is between planned dates in calendar days, not actual completion timestamps.

## Project workflows and saved views

Each project starts with six states and all directed transitions allowed. A workflow may rename, reorder, recolor, add, or remove unused states; it must retain a valid initial state. State categories determine completion and overview totals independently of the state ID. Allowed edges may restrict project issue types and require built-in or `custom:fieldId` fields. Additional rules apply required fields by type and destination state. Existing issues are preserved when stricter rules are introduced; their next edit must satisfy the rules. Schedule changes use the same validation.

Workflow PATCH requires `expectedVersion`, `initialStatusId`, `statuses`, `transitions`, and `fieldRules`. Removing an in-use state is rejected. Saved views persist a unique project name, list/board layout, and query/status/assignee/type filters. They are shared team resources; PATCH and DELETE require an expected version. A removed state in a saved filter stays explicit instead of expanding silently to all states.

## Project issue types and custom fields

`GET|PATCH /api/projects/:id/issue-schema` manages one CAS-versioned definition per project. Defaults preserve the original nine Korean type IDs. Type, field, and option IDs remain references when labels change. Types have a name, color, and archive flag. Fields have a name, description, kind, required flag, applicable type IDs (empty means all), option definitions, and archive flag.

Supported kinds are `text`, `number`, `date`, `select`, `multi_select`, `checkbox`, `user`, and `url`. Values live in `Issue.customFields` as an object keyed by field ID. Numbers and booleans remain JSON numbers and booleans; zero and false satisfy required presence. Selections use option IDs, user values use actual team-member IDs, and dates use valid four-digit ISO dates. URL values must use HTTP(S) without embedded credentials and contain at most 4,000 characters. Unknown keys and invalid values fail the mutation rather than being dropped.

PATCH omits `customFields` to preserve values or supplies the entire replacement map. Archived or inapplicable historical values can remain unchanged or be cleared but cannot be assigned afresh. Used field/type/option removal is rejected, and a saved field kind cannot be changed. Referenced workflow rules and saved-view types are also protected. Metadata changes preserve existing nonempty values and do not silently fill required fields; subsequent edits use current definitions. Search uses current type/field/option/user labels, including historical values. Automatic proposals capture the schema version as another stale-plan guard.

A project supports at most 50 types, 100 fields and 200 options per selectable field. Active schemas retain at least one active type and active selectable fields retain at least one active option. Names are unique within each definition list. Fields required by a workflow must be removed from those rules before archiving. Empty stored field keys may be removed together with their definition; affected ticket versions advance to reject stale drafts.

The scoped automation API exposes schema GET and reuses ticket validation for custom values. Definition writes remain on the browser management route; they are not part of the automation allowlist. See [automation examples](../docs/API.md).

## Collaborative documents

Documents retain manual editing until explicitly enabled with the document's current `expectedVersion`. Enabling seeds the Yjs document once from its rich content. Subsequent clients bind only after the server handshake. `shared/collaboration.ts` defines the JSON WebSocket protocol and `shared/editor-schema.ts` defines the common rich document schema.

Clients send a schema version, epoch, and optional Yjs state vector in `hello`. Incoming updates are applied to a candidate Yjs document and validated before commit. The server commits Yjs state, the derived content/plain text, document version, and request receipt together, then acknowledges and broadcasts. Repeated request IDs are idempotent; reusing an ID with different bytes is rejected. A save indicator must use the durable acknowledgment, not socket delivery alone. Updates are limited to 1MiB, rich content to 8MiB, and accumulated Yjs state to 16MiB.

Reconnection merges edits only within the same epoch. REST body replacement, revision restore, and native import rotate epochs and reset open clients. Clients preserve pending old edits for explicit recovery instead of replaying them over restored content. Metadata-only edits keep the epoch. Checkpoints add recoverable document revisions without replacing the live body; revision restore uses the usual version check. Presence identifies live connections; there is no cursor/selection awareness yet.

## Planning items

Cycles, modules, and releases have independent project-scoped records, owner, dates, status, and metadata versions. Tickets store canonical `cycleId`, `moduleId`, and `releaseId`; the old `cycle`, `module`, and `release` fields are derived display names. Runtime legacy label requests resolve existing exact names and never create records implicitly. Startup and legacy native import migrate those names, preserving case and whitespace. Startup migration bumps changed issue versions once and is idempotent on reopen.

Names are unique within project and kind using exact binary equality. A rename updates linked display names and issue versions in the same transaction. Metadata changes do not shift ticket schedules or transition their workflow states. Archived plans retain existing links but reject new assignments. Deletion requires `expectedVersion` and no linked tickets. Metadata PATCH uses CAS and cannot change project or kind.

Bulk membership POST accepts `{expectedVersion, assignments: [{issueId, expectedVersion, assigned}]}`. It checks the plan version and every ticket version, then applies shared workflow and required-field validation before writing tickets and audit records atomically. Independent membership edits do not bump the plan metadata version. No-op assignments do not rewrite tickets; an empty request list is rejected.

## Automation API keys

The local browser surface and actor selector remain trusted development features. `/api/v1` requires Bearer keys, enforces read/write and project scope, and binds writes to the key's actor. It exposes the explicit issue/document/comment mutation and lookup surface documented in [API usage](../docs/API.md); unsupported paths cannot fall through to management, export/import, integrations, or collaboration endpoints.

Keys use 32 random bytes. Only SHA-256 digests and public metadata/prefixes are stored; creation returns the secret once. Revocation and expiry reject subsequent requests, including requests authenticated before revocation whose JSON body arrives later. Management create/revoke and audit changes commit together. Last-use metadata does not change the revocation version. Native JSON excludes keys; successful replacement of users revokes all keys through foreign-key cascade, while a failed import restores them with the transaction.

## Document references, includes and history

Rich documents use one canonical editor schema for manual REST writes, revisions, native import and live Yjs updates. Document bodies are limited to 8MiB, 30,000 nodes and 60 levels. Unknown nodes/attributes, invalid reference IDs and malformed structures fail before persistence. Plain text retains stored reference labels/IDs and folded text; it does not materialize another document's live body.

`issueReference` stores `{issueId,label}`, while `documentReference` and `documentInclude` store `{documentId,label}`. Each is a block atom. `details` contains exactly a `detailsSummary` (inline content) and `detailsContent` (one or more blocks). Fold open/closed state is a local reading choice; toggling it does not write a document version.

References display current workspace titles/statuses, with the saved label/ID as a fallback if a target disappears. Includes render the last-loaded source snapshot read-only and never write to that source. The UI can refresh references while preserving the current draft. Rendering allows at most five include levels, sixty combined structural levels, and 4,000 expanded nodes across direct include blocks, with an explicit notice at the limit. Ordinary reference cycles are allowed; the prospective document-include graph must be acyclic. New missing references fail. Existing missing references may remain, and historical restore/import explicitly permits missing targets while retaining the include-cycle guard. API keys also enforce project scope on embedded issue/document targets; reads return stored references rather than expanding out-of-scope source content.

Collaboration protocol2 adds these nodes. Startup upgrades old persisted rooms atomically, preserves exact Yjs bytes/history, rotates epochs and advances document versions. Invalid rooms roll back the entire migration. Old protocol clients cannot send new updates. Known-v1 pending browser caches can be validated and opened read-only for download or an explicit recovery copy, even when the epoch still matches. They are never automatically merged or rewritten as v2. A successful copy removes only the selected cache; malformed or unknown caches remain downloadable unchanged. Native import normalizes document snapshots and validates their graph once, then verifies each CRDT state's JSON agreement. No include body is copied into another document's CRDT state.

History comparison is read-only and accepts any pair of saved revisions or an explicitly labeled current draft. It compares structural signatures and bounded text chunks, including marks, attributes, tables, images and reference IDs. Comparison accepts body JSON up to 8MiB, a separately bounded 64KiB title, 30,000 nodes and 256 structural levels, with a global 250,000-step matching budget and at most 60 displayed rows per page. A bounded algorithm may show a conservative whole gap as removal/addition when its matching budget is reached; both inputs remain reconstructable. Pagination and collapsed unchanged runs bound DOM size without dropping differences. Restore still uses the original expected-version and unsaved/live-pending checks.

## Native data export/import

Exports use `schemaVersion: 7`, containing reference/include/details rich document nodes, project issue schemas and typed custom values, workspace resources, planning items and canonical ticket references, calendars, milestones, immutable baselines, workflows, saved views, comments, document revisions, `collabStates: {documentId, epoch, schemaVersion, state: base64}[]`, `attachments: Attachment[]`, and `attachmentContents: {id, data: base64}[]`. File IDs and exact binary contents are preserved. The parser accepts 64MiB JSON requests; complete compact exports are capped at 64MiB minus 1KiB to leave room for the `{data: ...}` import envelope. Too-large exports fail with HTTP 413, and unreadable or checksum-invalid files fail the entire export with HTTP 503. Bytes are never silently omitted. Larger workspaces require an operational database-and-files backup.

Import accepts schema1–7. Schema1 has no attachments; schema2 adds them; schema3 retains workflows, views and collaborative document state; schema4 adds canonical planning references. Schema1/2/3 migrate original plan labels. Schema5 additionally requires one valid current calendar per project and validates milestone/baseline snapshots; schema1–4 use default calendars and no milestones/baselines. Schema6 requires a valid issue schema for every project and validates ticket type/field/option/user references; schema1–5 use the original nine types and no custom fields. Schema7 additionally supports document reference/include/details nodes and collaboration schema2. Older package headers cannot claim these new nodes. Legacy collaboration schema1 is accepted only for its original nodes; imported states receive schema2 and new epochs. Imported workflows and saved views are validated against the imported definitions, not the definitions being replaced. Baseline historical dates, source versions and calendars are preserved while current record CAS versions advance. Automatic proposals and undo records are cleared on successful import. All supported attachment formats verify file names, IDs, target resources, authors, sizes, MIME signatures and SHA-256; schema3+ verifies CRDT/JSON agreement. Metadata replacement uses a SQLite transaction; binary files are staged in a separate directory and swapped only after relational validation. A private recovery journal and a generation marker committed in the same SQLite transaction distinguish precommit and postcommit interruption. On restart, an uncommitted import restores previous files; a committed import keeps the new files and removes previous ones. Synchronous SQLite commits and filesystem synchronization protect the generation boundary. Failed validation leaves existing metadata and files intact.

Existing resource version counters advance beyond their pre-import values so open stale editors cannot overwrite restored content. A current document revision is added when needed. Integration credentials/configuration are excluded; native JSON is not a full SQLite backup and is not a Jira/Confluence importer. Import replaces workspace data and should be used with a prior export. Deleting resources is permanent in this initial bundle; parents with children are rejected.

## Attachments

Each upload is a nonempty raw binary body of at most 20MiB, with a safe filename in the query string. Storage uses generated UUID filenames under private `data/uploads/`; original filenames are never storage paths. Files carry SHA-256 checksums and author/resource metadata. Uploads survive restart. The `X-File-Type` hint is untrusted: MIME metadata comes from content signatures, with unknown files treated as `application/octet-stream`.

Downloads use an encoded Content-Disposition filename and `nosniff`. `?inline=1` is allowed only for signature-checked PNG/JPEG/GIF/WebP; SVG/HTML and unrecognized files cannot be served inline. This checks image container signatures, not full image decoding. Downloads and exports verify stored byte length and checksum. Deleting an attachment or its parent removes metadata transactionally and then removes its stored file; an interrupted final cleanup can leave an unreferenced file but does not expose missing bytes through live metadata. There is no antivirus or object-storage backend in this development bundle.

## GitLab

No external calls occur before a base URL and numeric project IDs are explicitly configured. Sync makes read-only GET requests: up to 1000 recent MRs and 50 recent pipelines per configured project. Uppercase issue keys in titles, descriptions, or branch names establish links. Existing workflow statuses are never automatically changed by merges or pipelines. Links to commits are collected from push webhooks; commits use `iid: 0` because the shared link shape uses a numeric IID, and their stable SHA remains in the resource ID/URL.

Tokens and webhook secrets are write-only and encrypted with AES-256-GCM using `data/.credential-key` (mode 0600). Keep that key with the database when taking a full operational backup. Native exports do not contain credentials. Settings expose only configured flags.

Webhooks require the configured `X-Gitlab-Token` and an allowed project ID. Event IDs deduplicate retries; a payload hash is used when the sender provides no event ID. Supported events are MR, pipeline, and push. A periodic scheduler, automatic webhook registration, OAuth, complete historical synchronization, and automatic transition rules are not implemented in this bundle.

## Verification

`node --import tsx --test tests/server/*.test.ts`

Tests use fresh temporary SQLite directories and a local mock GitLab server. They exercise persistence, stale writes, document revisions/restoration, dependency cycles, atomic schedule changes and safe undo, per-issue schedule history rollback, binary uploads/downloads, filename/MIME/size validation, exact-byte export/import and rollback, export size rejection, precommit/postcommit import recovery on reopen, credential omission/encryption, and authenticated duplicate webhooks.

Additional suites exercise workflow transitions/type restrictions/required fields, completion-category changes and backup compatibility, shared-view persistence and stale edits, and actual WebSocket clients. Collaboration tests cover concurrent and out-of-order updates, durable ACK/restart behavior, schema and size rejection without mutation, checkpoints, restore/import epoch changes, and keeping a ready connection beyond its handshake deadline. Browser tests also traverse the development proxy and verify live editor convergence, offline merging, recovery, and acknowledgment-based save status.

Planning tests cover exact/case/whitespace legacy migration, stale-editor protection, canonical references, atomic membership changes and workflow rules, archive/deletion restrictions, renames/search, and native-backup restore. API-key tests use actual HTTP requests, including a paused JSON upload revoked mid-request, actor/project enforcement, secret omission, expiry, audit failure rollback, and late native-import rollback versus successful revocation.

Calendar/schedule tests exercise nonworking and working exceptions, four-digit date boundaries, FS propagation, blocked terminal/partial/unknown periods, workflow/calendar/issue/graph guards, proposal expiry and pruning, atomic rollback, idempotent apply, and safe undo. Artifact tests cover milestone CAS and linked-ticket deletion, baseline capture conflicts, historical deleted records, and schema5/legacy restore. Browser coverage includes the real calendar/automatic-plan/baseline flows, bounded distant-date rendering, local-timezone date entry, and preserving every draft when one of multiple Settings navigation guards cancels.

Issue-schema tests cover strict typed values and invalid inputs, preserving zero/false, scoped and archived historical values, partial multiselect archive retention, stable IDs and active-definition guards, workflow/view references, CAS and audit rollback, empty-field cleanup versioning, and pure import preparation. End-to-end API tests verify scoped schema reads, typed writes, renamed-label search, stale automatic proposals, current-format archived restore and schema5 calendar/artifact preservation. Browser tests exercise the settings editor, all eight inputs, renamed-value search across list/global search, and draft protection in detail, Gantt and creation dialogs.

Document-block integration tests cover manual/live historical restore with deleted targets, cycle rejection without mutation, embedded API-key project scopes, native schema7/legacy6 round trips, exact IDs and Markdown fold/reference preservation. Collaboration tests exercise atomic old-room migration and strict multi-room import; browser recovery tests verify read-only schema1 pending caches, no outgoing updates, exact downloads and selective cleanup after a saved copy. Diff tests reconstruct both inputs across random edits, duplicate-heavy fallback, Unicode, exact 8MiB bodies and 30,000-node boundaries.
