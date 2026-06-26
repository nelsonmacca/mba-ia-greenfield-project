---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-06-25T00:00:00-03:00"
  docs/phases/phase-03-videos/phase-03-videos.md: "2026-06-25T00:00:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-25T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-25T00:00:00-03:00"
issues: []
advisories:
  - "context7 doc fetch is PENDING for all new libraries (MCP unavailable in planning session). Must be completed at the start of SI implementation per CLAUDE.md — fill context7_id/fetched_at and verified API notes in library-refs.md before coding."
  - "Testing-guide reference `external-systems.md` describes object storage as a local-filesystem adapter for tests; Phase 03 supersedes this with real MinIO in Compose (TD-02) and the enunciado's 'real infra, no mocking what can run for real' rule. SIs test against real MinIO/Redis/FFmpeg. Not a conflict — the guide predates the TD and notes 'S3 in production'; flagged so reviewers expect real-infra integration tests."
  - "BullMQ job options (attempts/backoff), re-confirm idempotency (SI-03.4), and worker re-delivery idempotency (SI-03.5) are intentionally fixed at implementation, not in the plan. Resolved at SI-03.4: attempts=3 / exponential backoff 5000ms / removeOnComplete=true / removeOnFail=false; re-confirm on queued/processing/ready/failed returns current status with no duplicate job."
  - "PRE-EXISTING LINT DEBT (out of SI-03.4 scope). `npm run lint` exits 1 project-wide: at the committed HEAD *before* SI-03.4 (SI-03.3, with SI-03.4 changes stashed) it reports 208 problems / 168 errors across auth/channels/mail/users specs + e2e (no-unsafe-member-access, unbound-method, require-await, no-unsafe-argument). This was not caught in SI-03.1/03.2/03.3 because those sessions piped `npm run lint` through `tail`, masking eslint's real exit code. It is NOT introduced by SI-03.4: SI-03.4's own new/changed files are lint-clean (eslint exit 0 on them) and `tsc --noEmit` passes. Per user direction, fixing the ~168 baseline errors is deferred to a separate dedicated lint/type-cleanup task and must not be mixed into SI-03.4."
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ All nine capabilities from `project-plan.md` → Fase 03 map to a decided TD (see Capability Coverage in `context.md`) and to at least one SI (see Deliverables ↔ SI mapping in `phase-03-videos.md`). The `status` enum (`draft/uploaded/queued/processing/ready/failed`) matches the enunciado's required lifecycle (`rascunho/uploaded/queued/processing/ready/failed`), with `draft = rascunho` justified.

### Ambiguities

_None blocking._ Remaining choices (FFmpeg wrapper API specifics, job option values, idempotency policy, exact field names) are deferred to implementation **by design** and recorded as advisories — they do not block starting implementation.

### Missing Decisions

_None._ All six base architectural questions are decided. The enunciado's mandatory functional scope (video module, entity linked to channel, 10GB upload, draft pre-registration, object storage, queue, separate worker, FFmpeg metadata+thumbnail, status lifecycle, unique URL, streaming, download) is each covered by a specific SI.

### Dependency Gaps

_None._ Phase 03 depends on Fase 01 (config/DB foundation) and Fase 02 (auth + channels), both completed. The internal SI Dependency Map is acyclic and linearizable (SI-03.1 → 03.2 → 03.3 → 03.4 → 03.5 → 03.6/03.7 → 03.8).

### Inherited Constraint Conflicts

_None._ Decisions reuse inherited conventions: namespaced `registerAs` config (+ new `storage`/`queue` namespaces), Joi env validation, `synchronize: false` + CLI migrations (with the `video_status` enum-cleanup lesson from `bb0010e`), the `{ statusCode, error, message }` error contract (extended with new codes), global `ValidationPipe`, global JWT guard (`@Public()` for watch endpoints), and Docker-Compose-service-name networking (`minio`, `redis`).

### Unresolved Open Questions

_None blocking the base architecture._ Deferred evolutions (tus, RabbitMQ, independent worker subproject, nanoid slug, API-proxied authz, HLS) are recorded in the decisions doc's "Deferred / Future Evolutions" table and are out of scope.

### UI Coverage Gaps

Frontend upload and player surfaces are deferred to a later frontend phase (`next-frontend/`), consistent with the backend-only scope of this phase and the Phase 02 deferral pattern. Not a gap.

### Checklist Conformance (enunciado oficial)

| Checklist item | Covered by |
|----------------|------------|
| Research/decisions before implementation | `technical-decisions-phase-03-videos.md` (TD-01..06) |
| Planning docs: context/validation/phase/progress/library-refs | all present in `docs/phases/phase-03-videos/` + `library-refs.md` |
| validation.md clean before implementing | this file — `status: clean`, `issue_count: 0` |
| SIs + Technical Specifications + Dependency Map + Deliverables + Events/Messages | `phase-03-videos.md` (SI-03.1..03.8, Tech Specs, Events/Messages, Dep Map, Deliverables) |
| Implementation SI-by-SI, updating progress.md | workflow defined; `progress.md` tracks per-SI status |
| Update CLAUDE.md/docs with real videos section at the end | SI-03.8 |
| Infra (storage+queue+worker) via Docker Compose with backend | SI-03.1 |
| Tests exercise real Compose infra, no over-mocking | SI-03.3/03.4/03.5/03.7 (real MinIO/Redis/FFmpeg) |
| DoD: npm test / test:e2e / tsc / lint | SI-03.8 + per-SI Expected validations |
| 10GB not routed through API | TD-01 / SI-03.3 (presigned PUT) |

## Resolved Issues

- **SI-03.4 (Upload confirmation + job publishing) implemented.** `QueueModule` registers BullMQ over the provisioned Redis (`forRootAsync` from `queueConfig`) and the `video-processing` queue (`attempts:3`, exponential backoff, `removeOnComplete`, `removeOnFail:false`). `VideoProducerService.enqueueProcessing` publishes `process-video { videoId, objectKey }` — payload only, never bytes (TD-03). `POST /videos/:id/confirm` (authenticated, owner-only) validates the video exists (404 `VIDEO_NOT_FOUND`), belongs to the user's channel (403 `FORBIDDEN_VIDEO_ACCESS`), and that the object is present in MinIO via `objectExists`/`headObject` (409 `UPLOAD_NOT_CONFIRMED`); it re-reads and re-validates `size_bytes`/`content_type` from `HeadObject` (≤10GB), transitions `draft → uploaded → queued`, and enqueues exactly one job. Re-confirm is idempotent (no duplicate job). Tests use **real Redis** and assert the enqueued job via `queue.getJobs`; isolation via `queue.obliterate` per test. 31 unit/integration + 11 e2e green; `tsc` clean; SI-03.4 files lint-clean. The `@nestjs/bullmq` + `bullmq` libs were installed at pinned versions with explicit authorization; context7 BullMQ docs re-verified at implementation. The worker consumer, FFmpeg, thumbnail, and streaming/download remain out of scope (SI-03.5+). A pre-existing project-wide lint failure was discovered during validation and recorded as an advisory (deferred to a separate task per user direction).
- **SI-03.3 (Storage module + presigned upload / draft creation) implemented.** `StorageModule`/`StorageService` wrap a configured `S3Client` (MinIO endpoint, `forcePathStyle`, credentials from `storageConfig`) and expose `getPresignedUploadUrl` (PUT), `getPresignedDownloadUrl` (GET), `headObject`, and `objectExists`. `POST /videos` (authenticated) pre-registers a `draft` `Video` for the user's channel, derives `object_key = videos/{id}/source` (TD-05), issues a presigned PUT URL (TD-01), and returns `{ id, upload_url, object_key, status }`. The file never passes through the API. `FileTooLargeException` (`FILE_TOO_LARGE` / 400) added; `size_bytes`/`content_type` are client-asserted now and re-validated on confirm (SI-03.4). The `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` libraries (absent until now) were installed at the pinned versions with explicit authorization. context7 docs for the AWS SDK were re-verified at implementation against the installed version (presigned PUT/GET + HeadObject APIs match `library-refs.md`). Tests: 26 unit/integration (including a real-MinIO PUT→GET round-trip and a real-DB+MinIO draft path) + 5 e2e, all green; `tsc --noEmit` and `lint` exit 0; all 3 migrations apply on a fresh DB.
- **SI-03.2 (Video entity + migration) implemented.** The `Video` entity (linked to `Channel` via `channel_id` FK, `onDelete: CASCADE`), the `video_status` enum (`draft/uploaded/queued/processing/ready/failed`, default `draft`), `(channel_id)` + `(status)` indexes, and the CLI-generated `CreateVideos` migration are in place and verified against a fresh DB. The `migrations.integration-spec.ts` advisory pattern (drop the enum type explicitly — the `bb0010e` lesson) was extended to `video_status`. A Postgres deadlock surfaced when `videos` joined the parallel `DROP TABLE ... CASCADE` cleanup; resolved by making the drops sequential. No new libraries (TypeORM-only; UUID PK per TD-05). Full suite (162 tests) + `tsc --noEmit` green.
