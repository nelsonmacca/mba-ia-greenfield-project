# phase-03-videos — Progress

**Status:** in progress
**SIs:** 3/8 implemented — all 8 fully specified in `phase-03-videos.md`

> Documentation-only sessions so far: (1) technical decisions + initial plan (commit `d300a90`); (2) expansion of the SI outline into complete SIs with Technical Specifications, Events/Messages, Dependency Map, and Deliverables. **No application code, Docker Compose changes, or dependency installs have been made.**

## Decisions

- Technical decisions recorded in `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01..TD-06, all `decided`).
- New libraries pinned in `library-refs.md` (versions probed from npm 2026-06-25); **context7 doc fetch is PENDING** and must be completed at the start of implementation (CLAUDE.md mandate; MCP was unavailable in the planning session).
- Base flow: API (draft + presigned URL) → client → MinIO/S3 → API (confirm) → BullMQ/Redis (`process-video { videoId, objectKey }`) → Video Worker (FFmpeg) → status/metadata in PostgreSQL → presigned GET for streaming/download.

## Step Implementations (specified — not started)

### SI-03.1 — Infrastructure & Configuration (MinIO, Redis, Video Worker, config namespaces)
- **Status:** not started
- **Tests:** infra/bootstrap smoke; no new unit tests for compose itself

### SI-03.2 — Video Entity & Migration
- **Status:** done (commit pending)
- **Tests:** `video.entity.integration-spec.ts` (8 cases: id/timestamp/default-status, null metadata, FK rejection, invalid-enum rejection, title max-length, channel cascade-delete, relation load, full-metadata persistence), `videos.module.spec.ts` (DI compilation), `migrations.integration-spec.ts` (updated: `videos` in managed tables, `video_status` enum cleanup, 3 migrations, revert removes `videos`)
- **Files created:** `src/videos/entities/video.entity.ts` (`Video` + `VideoStatus` enum), `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`), `src/database/migrations/1782446117064-CreateVideos.ts` (CLI-generated), plus the two test files above
- **Files updated:** `src/app.module.ts` (register `VideosModule`), `src/test/create-test-data-source.ts` (`cleanAllTables` deletes `videos` first), `src/database/migrations.integration-spec.ts`
- **Notes:** `size_bytes` is `bigint`, which TypeORM maps to a JS `string` to preserve precision — entity field typed `string | null`. FK to `channels` uses `onDelete: 'CASCADE'`. Migration cleanup in the test was switched from parallel (`Promise.all`) to **sequential** `DROP TABLE ... CASCADE` to avoid a Postgres deadlock once `videos` (FK → channels → users) joined the managed-table set.
- **Validations:** full `npm test --runInBand` (25 suites / 162 tests) green; `npx tsc --noEmit` exits 0; fresh `docker compose down -v && up -d --build` + `migration:run` applies all 3 migrations cleanly.

### SI-03.3 — Storage Module & Presigned Upload (draft creation)
- **Status:** done (commit pending)
- **Tests:** `storage.service.spec.ts` (unit — presigned PUT/GET command + options construction with mocked `getSignedUrl`, HeadObject mapping, `objectExists` NotFound/404/rethrow branches), `storage.service.integration-spec.ts` (real MinIO — presigned PUT→GET byte round-trip, metadata/existence after upload), `videos.service.spec.ts` (unit — file-too-large rejection, draft creation result, persisted fields), `videos.service.integration-spec.ts` (real DB + MinIO — draft row linked to channel, presigned URL accepts a real upload, oversized rejected before persisting), `videos.e2e-spec.ts` (201 contract, FILE_TOO_LARGE 400, 401 unauth, VALIDATION_ERROR). Targeted run: 26 unit/integration tests + 5 e2e green.
- **Files created:** `src/storage/storage.constants.ts` (`S3_CLIENT` token), `src/storage/storage.service.ts` (`getPresignedUploadUrl`, `getPresignedDownloadUrl`, `headObject`, `objectExists`), `src/storage/storage.module.ts` (`S3Client` factory from `storageConfig`, exports `StorageService`), `src/videos/dto/create-video.dto.ts` (`filename`, `content_type`, `size_bytes`), `src/videos/videos.service.ts` (`createDraft` + `sourceObjectKey`), `src/videos/videos.controller.ts` (`POST /videos`), plus the five test files above.
- **Files updated:** `src/common/exceptions/domain.exception.ts` (added `FileTooLargeException`, code `FILE_TOO_LARGE` / 400), `src/videos/videos.module.ts` (import `StorageModule` + `Channel` in `forFeature`, register controller/service), `src/videos/videos.module.spec.ts` (compilation now needs global `ConfigModule` with `storageConfig` for the `S3Client` factory).
- **Dependencies installed (authorized):** `@aws-sdk/client-s3@^3.1075.0`, `@aws-sdk/s3-request-presigner@^3.1075.0` (versions match `library-refs.md`). `npm audit fix` deliberately not run.
- **Notes:** Object key is `videos/{id}/source` (TD-05). The API never touches file bytes — it issues a presigned PUT and persists initial metadata only (TD-01). `content_type`/`size_bytes` are client-asserted at draft time and will be re-validated against the real object on confirm (SI-03.4). `FILE_TOO_LARGE` mapped to 400 (client-asserted bad request). `createDraft` resolves the channel via `findOneByOrFail({ user_id })` — every authenticated user has a channel (Phase 02). Presigned upload signs `content-type` as a signable header, so the client must echo it on PUT.
- **Validations:** SI-03.3 targeted suites green (26 + 5 e2e); `npx tsc --noEmit` exits 0; `npm run lint` exits 0; `migration:run` applies all 3 migrations on a fresh DB. Full-suite run recorded at task close.

### SI-03.4 — Upload Confirmation & Job Publishing
- **Status:** not started
- **Tests:** video-producer.service.spec (unit), videos.service.integration (real Redis), videos.e2e

### SI-03.5 — Video Worker (BullMQ consumer + FFmpeg/ffprobe)
- **Status:** not started
- **Tests:** video-processing.service.spec (unit), video-processing.service.integration-spec (real MinIO + FFmpeg + DB, tiny fixture)

### SI-03.6 — Video Status & Metadata Read Endpoint
- **Status:** not started
- **Tests:** videos.e2e (status across lifecycle)

### SI-03.7 — Playback & Download (presigned GET, streaming)
- **Status:** not started
- **Tests:** videos.e2e (issue presigned URL via API, fetch from MinIO with Range → 206)

### SI-03.8 — Final Validation, Docs & Usage Section
- **Status:** not started
- **Tests:** full DoD suite (unit+integration, e2e, tsc, lint) + end-to-end smoke

## Open items carried into implementation

- ~~Complete context7 doc fetch and fill `library-refs.md` (`context7_id`, `fetched_at`, verified API notes).~~ Done at SI-03.3 for the AWS SDK (re-verified against installed `@aws-sdk@^3.1075.0`). BullMQ/fluent-ffmpeg docs to be re-confirmed when SI-03.4/03.5 install those libs.
- Confirm FFmpeg install path in the worker Dockerfile and `fluent-ffmpeg` binary resolution.
- Decide exact BullMQ job options (`attempts`/`backoff` values) and queue test-isolation strategy.
- Finalize re-confirm idempotency behavior (SI-03.4) and worker re-delivery idempotency (SI-03.5).
