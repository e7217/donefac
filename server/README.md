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
- `GET|PATCH /api/projects/:projectId/workflow`
- `GET /api/views?projectId=...`, `POST /api/views`, `PATCH|DELETE /api/views/:id`
- `GET /api/comments?resourceType=issue|document&resourceId=...`, `POST /api/comments`
- `GET|POST /api/attachments?resourceType=issue|document&resourceId=...` (POST also needs `filename` query; raw `application/octet-stream`)
- `GET /api/attachments/:id/content`, `DELETE /api/attachments/:id`
- `POST /api/resource-links`, `DELETE /api/resource-links/:id`
- `POST /api/dependencies`, `DELETE /api/dependencies/:id`
- `POST /api/schedule/preview`, `POST /api/schedule/apply`, `POST /api/schedule/undo`
- `GET /api/search?q=...`, `GET /api/export`, `POST /api/import {data: ...}`
- `GET|PATCH /api/integrations/gitlab`, `POST /api/integrations/gitlab/sync`, `POST /api/integrations/gitlab/webhook`

Creates and patches return the resource directly. Revisions and comments return arrays. Errors return `{error, details?}`. The workspace snapshot follows `shared/types.ts` exactly.

## Schedule behavior

Dates may be partial or absent. A start after an end is rejected. Dependencies are FS relationships inside one project and form a directed acyclic graph. Predecessor/successor relationships are distinct from parent/child grouping.

Bulk moves first return a preview and warnings. Working days exclude weekends only; there is no holiday calendar yet. Schedules are manual: dependency conflicts are reported, not silently propagated. Apply updates all selected issues atomically. Undo checks every applied version, refuses if anything changed afterward, and creates new versions instead of rewinding version numbers. Undo is persisted but does not survive native export/import.

## Project workflows and saved views

Each project starts with six states and all directed transitions allowed. A workflow may rename, reorder, recolor, add, or remove unused states; it must retain a valid initial state. State categories determine completion and overview totals independently of the state ID. Allowed edges may restrict issue types and require existing fields. Additional rules apply required fields by type and destination state. Existing issues are preserved when stricter rules are introduced; their next edit must satisfy the rules. Schedule changes use the same validation. Custom field definitions and custom issue types are not implemented yet.

Workflow PATCH requires `expectedVersion`, `initialStatusId`, `statuses`, `transitions`, and `fieldRules`. Removing an in-use state is rejected. Saved views persist a unique project name, list/board layout, and query/status/assignee/type filters. They are shared team resources; PATCH and DELETE require an expected version. A removed state in a saved filter stays explicit instead of expanding silently to all states.

## Collaborative documents

Documents retain manual editing until explicitly enabled with the document's current `expectedVersion`. Enabling seeds the Yjs document once from its rich content. Subsequent clients bind only after the server handshake. `shared/collaboration.ts` defines the JSON WebSocket protocol and `shared/editor-schema.ts` defines the common rich document schema.

Clients send a schema version, epoch, and optional Yjs state vector in `hello`. Incoming updates are applied to a candidate Yjs document and validated before commit. The server commits Yjs state, the derived content/plain text, document version, and request receipt together, then acknowledges and broadcasts. Repeated request IDs are idempotent; reusing an ID with different bytes is rejected. A save indicator must use the durable acknowledgment, not socket delivery alone. Updates are limited to 1MiB, rich content to 8MiB, and accumulated Yjs state to 16MiB.

Reconnection merges edits only within the same epoch. REST body replacement, revision restore, and native import rotate epochs and reset open clients. Clients preserve pending old edits for explicit recovery instead of replaying them over restored content. Metadata-only edits keep the epoch. Checkpoints add recoverable document revisions without replacing the live body; revision restore uses the usual version check. Presence identifies live connections; there is no cursor/selection awareness yet.

## Native data export/import

Exports use `schemaVersion: 3`, containing workspace resources, workflows, saved views, comments, document revisions, `collabStates: {documentId, epoch, schemaVersion, state: base64}[]`, `attachments: Attachment[]`, and `attachmentContents: {id, data: base64}[]`. File IDs and exact binary contents are preserved. The parser accepts 64MiB JSON requests; complete compact exports are capped at 64MiB minus 1KiB to leave room for the `{data: ...}` import envelope. Too-large exports fail with HTTP 413, and unreadable or checksum-invalid files fail the entire export with HTTP 503. Bytes are never silently omitted. Larger workspaces require an operational database-and-files backup.

Import accepts legacy schema1 exports without attachments and schema2 exports with attachments; both use default workflows and no live document state or saved views. Schema2/3 verify file names, IDs, target resources, authors, sizes, MIME signatures, and SHA-256 before replacing data. Schema3 also validates workflow references, views, and agreement between CRDT state and rich content. Metadata replacement uses a SQLite transaction; binary files are staged in a separate directory and swapped only after relational validation. A private recovery journal and a generation marker committed in the same SQLite transaction distinguish precommit and postcommit interruption. On restart, an uncommitted import restores previous files; a committed import keeps the new files and removes previous ones. Synchronous SQLite commits and filesystem synchronization protect the generation boundary. Failed validation leaves existing metadata and files intact.

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
