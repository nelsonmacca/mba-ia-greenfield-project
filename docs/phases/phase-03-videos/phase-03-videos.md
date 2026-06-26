---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-25T00:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file video upload (up to 10GB) without impacting API performance, automatic background processing (metadata + thumbnail), unique per-video URLs, and streaming/download delivery — establishing the video ingestion and storage foundation that Phases 04–07 build upon (management, watch page, social interactions, home/search).

**Backend-only scope.** The Next.js frontend (upload UI, player) is deferred to a later frontend phase, consistent with the Phase 02 deferral pattern.

---

## Base Architecture (from decided TDs)

| Concern | Decision | Ref |
|---------|----------|-----|
| Large-file upload (10GB) | Presigned URL, client uploads directly to object storage; API orchestrates only | TD-01 |
| Object storage | MinIO (dev) / S3-compatible via AWS SDK | TD-02 |
| Background queue | BullMQ + Redis (`@nestjs/bullmq`) | TD-03 |
| Worker topology | Separate Compose container, same NestJS codebase in worker mode | TD-04 |
| Unique video URL | UUID (reuses project-wide uuid PK convention) | TD-05 |
| Streaming & download | Presigned GET URLs; storage serves bytes with native HTTP Range | TD-06 |

End-to-end flow:

```
API (create draft) → API (presigned upload URL) → client uploads to MinIO/S3
→ API (confirm upload) → BullMQ job { videoId, objectKey } → Video Worker
→ ffprobe/FFmpeg (metadata + thumbnail) → DB status/metadata update
→ viewer requests playback/download → API issues presigned GET URL → storage streams via Range
```

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Unique per-video identifier; also the storage object-key prefix (TD-05) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (videos belong to a channel created in Phase 02) |
| title | varchar(120) | nullable | Optional at draft; full edit flow is Phase 04 |
| status | enum `video_status` | not null, default `'draft'` | Lifecycle below (TD-03) |
| object_key | varchar | nullable until upload | Storage key of the source video object — `videos/{id}/source` |
| thumbnail_key | varchar | nullable until processed | Storage key of generated thumbnail — `videos/{id}/thumbnail.jpg` (TD-04) |
| duration_seconds | int | nullable until processed | Extracted by ffprobe (TD-04) |
| size_bytes | bigint | nullable until confirmed | Confirmed object size (also enforces the 10GB cap) |
| content_type | varchar | nullable until confirmed | MIME type of the source object |
| processing_error | text | nullable | Last error message when `status = 'failed'` |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one). **Indexes:** `(channel_id)`, `(status)`.

> Visibility (público/unlisted), category, and the full draft→publish flow are **Phase 04** capabilities and are intentionally excluded here. The `status` enum covers only the ingestion/processing lifecycle.

#### Status lifecycle (`video_status` enum)

```
draft       — record pre-registered; presigned upload URL issued, bytes not yet confirmed
uploaded    — object confirmed present in storage (transient; set during confirm)
queued      — processing job published to BullMQ
processing  — worker picked up the job and started ffprobe/FFmpeg
ready        — metadata + thumbnail extracted; video is watchable
failed      — processing failed (after retries); processing_error populated
```

> Maps to the enunciado's "rascunho/uploaded/queued/processing/ready/failed" — `draft` = rascunho, `ready` = the enunciado's "ready". Justified equivalence.

### Events / Messages (Queue)

Queue name: **`video-processing`** (BullMQ over Redis — TD-03).

**Job: `process-video`**

| Field | Type | Notes |
|-------|------|-------|
| `videoId` | string (uuid) | The `Video.id` — worker loads the record by this |
| `objectKey` | string | Storage key of the source object (`videos/{id}/source`) |

- **Payload contains only `videoId` + `objectKey` — never the file bytes** (TD-03/TD-04).
- **Producer:** the API, in the confirm-upload flow (SI-03.4), after transitioning `uploaded → queued`.
- **Consumer:** the Video Worker container (SI-03.5), `@Processor('video-processing')`.
- **Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: <ms> }`, `removeOnComplete: true`, `removeOnFail: false` (keep failures for inspection). Exact values fixed at implementation.
- **State mapping:** job picked up → `Video.status = processing`; job completed → `ready` (+ duration/thumbnail); job failed after final attempt → `failed` (+ `processing_error`).
- **Idempotency:** the worker must tolerate re-delivery (re-running ffprobe/thumbnail for an already-`ready` video is safe / short-circuited) since BullMQ retries can re-run a job.

### Storage Layout (MinIO/S3 — TD-02)

- Bucket: `streamtube-videos` (dev default; configurable).
- Source object: `videos/{videoId}/source`.
- Thumbnail object: `videos/{videoId}/thumbnail.jpg`.
- Presigned PUT for upload (TD-01), presigned GET for playback/download (TD-06). CORS configured for browser-direct PUT/GET.

### API Contracts

> Final field names/status codes settled per SI; all errors use the Phase 02 envelope `{ statusCode, error, message }` (TD-07 inherited).

| Method & Route | Auth | Purpose |
|----------------|------|---------|
| `POST /videos` | ✓ | Create draft + return presigned upload URL (SI-03.3) |
| `POST /videos/:id/confirm` | ✓ (owner) | Confirm upload, enqueue processing job (SI-03.4) |
| `GET /videos/:id` | public | Video status + metadata (SI-03.6) |
| `GET /videos/:id/playback` | public | Presigned GET streaming URL (SI-03.7) |
| `GET /videos/:id/download` | ✓ | Presigned GET download URL (SI-03.7) |

New domain error codes (extending the Phase 02 catalog): `VIDEO_NOT_FOUND` (404), `UPLOAD_NOT_CONFIRMED` (409), `FILE_TOO_LARGE` (400/413), `VIDEO_NOT_READY` (409, playback before `ready`), `FORBIDDEN_VIDEO_ACCESS` (403, non-owner confirm/download).

---

## Step Implementations

> Format mirrors `phase-02-auth.md`. Each SI lists Objective, Planned files, Technical actions, Acceptance criteria, Expected validations, Dependencies, Risks/observations, and Out of scope. No code is written in this planning session — these are the implementation contracts.

### SI-03.1 — Infrastructure & Configuration (MinIO, Redis, Video Worker, config namespaces)

**Objective:** Stand up the Phase 03 infrastructure (object storage, queue broker, worker container) in Docker Compose and the corresponding typed config namespaces + Joi validation, so later SIs have real infra to build and test against.

**Planned files:**
- `nestjs-project/compose.yaml` — add `minio`, `redis`, and `video-worker` services (+ `createbuckets` init for MinIO bucket/CORS, or documented manual step).
- `nestjs-project/Dockerfile.worker` (or reuse `Dockerfile.dev` with a worker command) — image with **FFmpeg/ffprobe system binaries** installed.
- `nestjs-project/src/config/storage.config.ts` — `registerAs('storage', ...)` (endpoint, region, bucket, access key, secret, `forcePathStyle`, presign TTLs, max upload size = 10GB).
- `nestjs-project/src/config/queue.config.ts` — `registerAs('queue', ...)` (Redis host/port).
- `nestjs-project/src/config/env.validation.ts` — extend Joi schema with storage + queue vars.
- `nestjs-project/.env.example` — new variables with Compose-compatible defaults.
- `nestjs-project/src/main.worker.ts` (or a bootstrap flag) — worker entrypoint that creates the Nest application context **without** the HTTP listener.

**Technical actions:**
- Add `minio` service (image `minio/minio`, console + API ports, `MINIO_ROOT_USER/PASSWORD`, volume); add a one-shot `createbuckets` service (`minio/mc`) to create `streamtube-videos` and set the bucket CORS/policy, or document a manual `mc` step.
- Add `redis` service (image `redis:7`), healthcheck (`redis-cli ping`).
- Add `video-worker` service: same build context, command runs the worker entrypoint; `depends_on` db (healthy), redis (healthy), minio; shares `.env`.
- Install FFmpeg in the worker image (`apt-get install -y ffmpeg`).
- Create `storage.config.ts` and `queue.config.ts` following the inherited `registerAs` pattern; inject via `ConfigType<typeof xxxConfig>`.
- Extend the Joi schema (storage endpoint/bucket/keys required; Redis host default `redis`, port default `6379`); update `.env.example`.
- Add worker bootstrap (`NestFactory.createApplicationContext(AppModule)` or `create` with `app.init()` and no `listen`) — guarded by an env flag or a separate entry file.
- Use **Compose service names** for all hosts (`minio`, `redis`) — never `localhost`.

**Acceptance criteria:**
- `docker compose up -d` starts `nestjs-api`, `db`, `mailpit`, `minio`, `redis`, and `video-worker` — all reach a running/healthy state.
- `docker compose exec db pg_isready -U streamtube` → accepting connections; `redis` responds to `redis-cli ping` with `PONG`; MinIO console reachable and the `streamtube-videos` bucket exists.
- App boots with the new env vars; omitting a required storage var causes a Joi bootstrap error.
- The `video-worker` container starts in worker mode and does **not** bind an HTTP port.
- `ffmpeg -version` and `ffprobe -version` succeed inside the worker container.

**Expected validations:** `npx tsc --noEmit` (config namespaces type-check); app bootstrap smoke (existing `GET /` E2E still 200); manual `docker compose ps` / healthcheck verification. No new unit tests for compose itself.

**Dependencies:** none (first SI).

**Risks/observations:** MinIO requires `forcePathStyle: true` and CORS for browser-direct uploads. Worker image grows with FFmpeg — keep it on the worker build only. Worker-mode bootstrap must not start the HTTP server (would double-bind / waste resources). Redis/MinIO credentials kept out of VCS via `.env`.

**Out of scope:** any application logic; the Video entity; SDK client wiring (SI-03.2/03.3).

---

### SI-03.2 — Video Entity & Migration

**Objective:** Define the `Video` entity (linked to `Channel`) with the status lifecycle and generate its migration, plus a migration-runner integration test.

**Planned files:**
- `nestjs-project/src/videos/entities/video.entity.ts` — `@Entity('videos')` per the data model above.
- `nestjs-project/src/videos/entities/video.entity.integration-spec.ts` — constraints/defaults/relation.
- `nestjs-project/src/database/migrations/<ts>-CreateVideos.ts` — generated via CLI.
- `nestjs-project/src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, exports `TypeOrmModule`.
- Update `nestjs-project/src/database/migrations.integration-spec.ts` — include `videos` in managed tables and the `video_status` enum in cleanup (mirrors the existing enum-drop pattern fixed in `bb0010e`).

**Technical actions:**
- Model columns/enum/indexes per the data model; `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`.
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos`; review the SQL (enum creation, FK, indexes). Ensure idempotent `IF EXISTS`/`IF NOT EXISTS` guards where the CLI allows.
- Add the `video_status` enum drop to the migrations test `beforeAll` cleanup (the enum survives table drops — same class of bug as `verification_tokens_type_enum`).

**Acceptance criteria:**
- `npm run migration:run` creates the `videos` table with the FK to `channels`, the `video_status` enum, and `(channel_id)`/`(status)` indexes.
- Inserting a video with a non-existent `channel_id` fails the FK constraint; a new video defaults to `status = 'draft'`.
- The migration runner test applies and reverts cleanly, leaving the shared DB fully migrated for subsequent suites (no leftover enum/tables).

**Expected validations:** `video.entity.integration-spec.ts` (real DB), `migrations.integration-spec.ts` (updated), `npx tsc --noEmit`. Run with `--runInBand`.

**Dependencies:** SI-03.1 (DB already exists from Phase 01, but config/worker scaffolding lands first).

**Risks/observations:** Postgres enum types are not dropped by `DROP TABLE` — the migrations test cleanup must drop `video_status` explicitly (lesson from `bb0010e`). Keep the entity free of Phase 04 fields (visibility/category) to avoid scope creep.

**Out of scope:** storage/queue wiring; any service/controller.

---

### SI-03.3 — Storage Module & Presigned Upload (draft creation)

**Objective:** Implement the S3/MinIO storage abstraction and the `POST /videos` endpoint that pre-registers a draft and returns a presigned upload URL — without routing bytes through the API.

**Planned files:**
- `nestjs-project/src/storage/storage.module.ts` — provides the `S3Client` and `StorageService`.
- `nestjs-project/src/storage/storage.service.ts` — `getPresignedUploadUrl(key, contentType)`, `getPresignedDownloadUrl(key, opts)`, `headObject(key)`, `objectExists(key)`.
- `nestjs-project/src/storage/storage.service.spec.ts` — unit (key/URL construction, mocked S3 client).
- `nestjs-project/src/storage/storage.service.integration-spec.ts` — **real MinIO** presigned PUT→GET round-trip.
- `nestjs-project/src/videos/videos.service.ts` — `createDraft(channelId, dto)`.
- `nestjs-project/src/videos/videos.controller.ts` — `POST /videos`.
- `nestjs-project/src/videos/dto/create-video.dto.ts` — `filename`, `content_type`, `size_bytes`.
- `nestjs-project/src/videos/videos.service.spec.ts` + draft path in `videos.service.integration-spec.ts`.
- `test/videos.e2e-spec.ts` — `POST /videos` contract.

**Technical actions:**
- Configure `S3Client` from `storageConfig` (endpoint, `forcePathStyle: true`, region, credentials).
- `createDraft`: validate `size_bytes ≤ 10GB` (throw `FILE_TOO_LARGE` otherwise), create `Video` (status `draft`, `object_key = videos/{id}/source`, `content_type`, `size_bytes`), issue presigned PUT URL via `s3-request-presigner`.
- Controller returns `{ id, upload_url, object_key, status }`; endpoint authenticated; `channel_id` derived from the authenticated user's channel.

**Acceptance criteria:**
- `POST /videos` (authenticated) returns 201 with a draft `id`, a working presigned upload URL, and `status: 'draft'`; a row is persisted.
- A `size_bytes` over 10GB returns `FILE_TOO_LARGE`.
- Unauthenticated request returns 401.
- The integration test uploads bytes to the presigned URL against real MinIO and reads them back via a presigned GET.

**Expected validations:** `storage.service.spec.ts` (unit), `storage.service.integration-spec.ts` (real MinIO), `videos.service.spec.ts`, `videos.service.integration-spec.ts`, `videos.e2e-spec.ts`, `npx tsc --noEmit`, `npm run lint`.

**Dependencies:** SI-03.1 (MinIO + storage config), SI-03.2 (Video entity).

**Risks/observations:** Presigned PUT + browser uploads need bucket CORS (set in SI-03.1). MinIO path-style is mandatory. Do not stream file bytes through the API (the whole point of TD-01). Content-type/size are client-asserted at draft time and **re-validated** at confirm (SI-03.4) against the real object.

**Out of scope:** upload confirmation and job publishing (SI-03.4); processing (SI-03.5).

---

### SI-03.4 — Upload Confirmation & Job Publishing

**Objective:** Implement `POST /videos/:id/confirm` — validate the uploaded object, transition status, and publish the `process-video` job to BullMQ.

**Planned files:**
- `nestjs-project/src/queue/queue.module.ts` — `BullModule.forRoot(...)` + `registerQueue({ name: 'video-processing' })`.
- `nestjs-project/src/videos/video-producer.service.ts` — injects the queue, `enqueueProcessing(videoId, objectKey)`.
- `nestjs-project/src/videos/video-producer.service.spec.ts` — unit (job payload, mocked queue).
- `nestjs-project/src/videos/videos.service.ts` — `confirmUpload(channelId, videoId)`.
- `nestjs-project/src/videos/videos.controller.ts` — add `POST /videos/:id/confirm`.
- Integration: `videos.service.integration-spec.ts` — confirm path enqueues a real job (assert via `queue.getJobs`).
- `test/videos.e2e-spec.ts` — confirm contract + ownership.

**Technical actions:**
- `confirmUpload`: load video (404 `VIDEO_NOT_FOUND`); enforce ownership (403 `FORBIDDEN_VIDEO_ACCESS`); `headObject(object_key)` — if missing, 409 `UPLOAD_NOT_CONFIRMED`; persist confirmed `size_bytes`/`content_type` from `HeadObject`; re-validate ≤10GB; transition `draft → uploaded → queued`; publish `process-video { videoId, objectKey }` with `attempts`/`backoff`.
- Controller returns `{ id, status: 'queued' }`.

**Acceptance criteria:**
- Confirm on a video with an uploaded object transitions to `queued` and enqueues exactly one `process-video` job carrying `{ videoId, objectKey }`.
- Confirm without the object present returns `UPLOAD_NOT_CONFIRMED`; confirm by a non-owner returns `FORBIDDEN_VIDEO_ACCESS`; unknown id returns `VIDEO_NOT_FOUND`.
- Re-confirming an already-queued video is rejected/idempotent (no duplicate job) — exact behavior fixed at implementation.

**Expected validations:** `video-producer.service.spec.ts` (unit), `videos.service.integration-spec.ts` (real Redis/queue assertion), `videos.e2e-spec.ts`, `npx tsc --noEmit`, `npm run lint` (`--runInBand`).

**Dependencies:** SI-03.3 (draft + storage), SI-03.1 (Redis/queue config).

**Risks/observations:** Job must carry only `videoId` + `objectKey` (TD-03). Enqueue should be consistent with the status write (avoid enqueuing then failing the DB update, or vice-versa) — consider ordering/compensation. Test isolation: clean the queue between tests (dedicated test queue or `queue.obliterate`/drain in `beforeEach`).

**Out of scope:** the worker consumer (SI-03.5); playback (SI-03.7).

---

### SI-03.5 — Video Worker (BullMQ consumer + FFmpeg/ffprobe)

**Objective:** Implement the worker-side processor that consumes `process-video` jobs, runs ffprobe/FFmpeg, and updates status — running in the separate worker container.

**Planned files:**
- `nestjs-project/src/videos/video-processor.ts` — `@Processor('video-processing')` consumer (WorkerHost).
- `nestjs-project/src/videos/video-processing.service.ts` — orchestration: download/stream object, ffprobe, thumbnail, persist.
- `nestjs-project/src/videos/ffmpeg.service.ts` — thin wrapper over `fluent-ffmpeg` (`probe(path)`, `generateThumbnail(path, outPath)`).
- Unit: `video-processing.service.spec.ts` (mock ffmpeg + storage + repo — assert orchestration and status transitions).
- Integration: `video-processing.service.integration-spec.ts` — real MinIO + real FFmpeg on a small fixture video; assert duration + thumbnail object created + status `ready`.
- Wire the processor into the worker bootstrap (`AppModule` / worker module) from SI-03.1.

**Technical actions:**
- On job receipt: load video, set `status = processing`; obtain the source object from MinIO (download to a temp file or stream); run `ffprobe` for duration/metadata; run FFmpeg to extract a single-frame thumbnail; upload the thumbnail to `videos/{id}/thumbnail.jpg`; persist `duration_seconds`, `thumbnail_key`, `status = ready`.
- On failure (after retries): set `status = failed`, populate `processing_error`.
- Make the processor idempotent (skip/short-circuit if already `ready`).
- Clean up temp files in a `finally`.

**Acceptance criteria:**
- A confirmed upload of a real fixture video is processed end-to-end: `duration_seconds` populated, a thumbnail object exists in storage, `status = ready`.
- A corrupt/invalid input leads to `status = failed` with `processing_error` after the configured retries.
- The worker runs in its **own container** (no HTTP), consuming from Redis.

**Expected validations:** `video-processing.service.spec.ts` (unit), `video-processing.service.integration-spec.ts` (real MinIO + FFmpeg + DB), `npx tsc --noEmit`, `npm run lint`. Integration uses a tiny committed fixture (a few KB) to keep CI fast.

**Dependencies:** SI-03.4 (jobs are published), SI-03.1 (worker container + FFmpeg), SI-03.2 (entity), SI-03.3 (storage service).

**Risks/observations:** FFmpeg/ffprobe are **system binaries** in the worker image — `fluent-ffmpeg` is only the wrapper. Large files: prefer streaming or bounded temp storage; do not load 10GB into memory. Temp-file cleanup is mandatory. Thumbnail frame selection (e.g., at ~1s or 10% in) fixed at implementation. Retry idempotency must avoid duplicate thumbnails.

**Out of scope:** playback/download URLs (SI-03.7); adaptive bitrate/transcoding (deferred).

---

### SI-03.6 — Video Status & Metadata Read Endpoint

**Objective:** Expose `GET /videos/:id` returning status + metadata (duration, thumbnail URL when ready), reflecting worker progress.

**Planned files:**
- `nestjs-project/src/videos/videos.service.ts` — `getById(id)`.
- `nestjs-project/src/videos/videos.controller.ts` — `GET /videos/:id` (public).
- `nestjs-project/src/videos/dto/video-response.dto.ts` — response shape.
- `test/videos.e2e-spec.ts` — read contract across statuses.

**Technical actions:**
- Return `{ id, status, title, duration_seconds?, thumbnail_url?, created_at }`; `thumbnail_url` is a presigned GET URL (TD-06) only when `thumbnail_key` is set.
- Public endpoint (`@Public()`), per the product rule that anonymous users can watch.

**Acceptance criteria:**
- `GET /videos/:id` returns the current status; a `ready` video includes `duration_seconds` and a working `thumbnail_url`; a `draft`/`processing` video omits them.
- Unknown id returns `VIDEO_NOT_FOUND` (404).

**Expected validations:** `videos.e2e-spec.ts`, `npx tsc --noEmit`, `npm run lint`.

**Dependencies:** SI-03.5 (metadata populated), SI-03.7 (presigned GET helper — can be developed together or shared via StorageService).

**Risks/observations:** Do not leak internal storage keys in the response — expose presigned URLs only. Presigned `thumbnail_url` TTL is short; clients refetch as needed.

**Out of scope:** listing/pagination and channel video panel (Phase 04).

---

### SI-03.7 — Playback & Download (presigned GET, streaming)

**Objective:** Implement `GET /videos/:id/playback` (public streaming URL) and `GET /videos/:id/download` (authenticated download URL) via presigned GET; storage serves bytes with native HTTP Range.

**Planned files:**
- `nestjs-project/src/videos/videos.service.ts` — `getPlaybackUrl(id)`, `getDownloadUrl(id, user)`.
- `nestjs-project/src/videos/videos.controller.ts` — the two routes.
- `test/videos.e2e-spec.ts` — playback/download contracts + Range behavior against MinIO.

**Technical actions:**
- `getPlaybackUrl`: require `status = ready` (else `VIDEO_NOT_READY` 409); issue a short-lived presigned GET for the source object; return `{ url }`.
- `getDownloadUrl`: authenticated; issue a presigned GET with a download content-disposition; return `{ url }`.
- Rely on MinIO/S3 native HTTP Range support — the client/`<video>` element streams/seeks directly; the API never proxies bytes.

**Acceptance criteria:**
- `GET /videos/:id/playback` on a `ready` video returns a presigned URL that, when fetched with a `Range` header, returns `206 Partial Content` from storage.
- Playback before `ready` returns `VIDEO_NOT_READY`.
- `GET /videos/:id/download` requires auth and returns a presigned URL with a download disposition.

**Expected validations:** `videos.e2e-spec.ts` (issue URL via API, then fetch from MinIO with a Range header asserting 206), `npx tsc --noEmit`, `npm run lint`.

**Dependencies:** SI-03.3 (StorageService presigned GET), SI-03.5 (`ready` videos exist).

**Risks/observations:** Presigned URLs are time-limited and shareable within their TTL — acceptable for the public-video MVP (TD-06). Range/206 handling is delegated to storage; the test asserts storage honors Range, not the API. Finer-grained authz for unlisted/private videos is a Phase 04+ concern (deferred).

**Out of scope:** signed-cookie/CDN delivery; per-view authorization beyond owner-download.

---

### SI-03.8 — Final Validation, Docs & Usage Section

**Objective:** Run the full Definition of Done, ensure docs match the implemented code, and add the real "Vídeos" section to the project docs (`README.md` / `nestjs-project/CLAUDE.md`).

**Planned files:**
- `nestjs-project/CLAUDE.md` — add a Videos/Storage/Queue/Worker section (commands, env vars, how to run the worker, how processing works).
- `README.md` — add Phase 03 endpoints + "Como rodar" updates (MinIO/Redis/worker services).
- `docs/phases/phase-03-videos/progress.md` — final SI statuses + observations.
- Confirm bucket CORS documented (SI-03.1) and finalize `.env.example`.

**Technical actions:**
- Run `docker compose exec nestjs-api npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint` — all green.
- Update docs to reflect the actual entity/endpoints/flow; remove any "indicative/planned" caveats that no longer apply.
- Verify Git Flow (feature branch, no direct main commits).

**Acceptance criteria:**
- All four DoD checks pass (unit+integration, e2e, tsc, lint).
- Compose brings up storage + queue + worker alongside the API; processing works end-to-end on a real upload.
- Docs are consistent with the code (no stale "TBD"/"planned" claims for delivered capabilities).

**Expected validations:** the full DoD suite; manual end-to-end smoke (upload → confirm → processed → playback 206).

**Dependencies:** SI-03.1..SI-03.7.

**Risks/observations:** Keep the README "Message Queue (TBD)" line updated to "BullMQ + Redis". Ensure the worker run instructions are accurate. Do not leave documentation inconsistent with code (DoD rule).

**Out of scope:** frontend usage docs (deferred frontend phase).

---

## Dependency Map

```
SI-03.1 (infra/config — no deps)
└── SI-03.2 (Video entity + migration)
    └── SI-03.3 (storage module + presigned upload / draft)
        ├── SI-03.4 (confirm + enqueue job)
        │   └── SI-03.5 (worker: BullMQ + FFmpeg/ffprobe)
        │       └── SI-03.6 (status/metadata read)   ─┐ (share presigned-GET helper)
        └── SI-03.7 (playback/download presigned GET) ─┘
SI-03.8 (final validation + docs — after SI-03.1..03.7)
```

Linearized order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 / SI-03.7 (parallelizable) → SI-03.8.

---

## Deliverables

- [ ] Object storage integration (MinIO dev / S3-compatible) for video and thumbnail objects _(TD-02 / SI-03.1, 03.3)_
- [ ] Presigned-URL upload flow supporting files up to 10GB without routing bytes through the API _(TD-01 / SI-03.3)_
- [ ] `Video` entity + `CreateVideos` migration with the ingestion/processing `status` lifecycle _(TD-05 / SI-03.2)_
- [ ] Draft pre-registration on upload initiation _(TD-01, TD-05 / SI-03.3)_
- [ ] BullMQ + Redis queue; API publishes `process-video { videoId, objectKey }` on confirm _(TD-03 / SI-03.1, 03.4)_
- [ ] Video Worker container (same codebase, worker mode) consuming jobs, running ffprobe/FFmpeg _(TD-04 / SI-03.1, 03.5)_
- [ ] Automatic metadata extraction (duration) and thumbnail generation _(TD-04 / SI-03.5)_
- [ ] Unique per-video URL via UUID, collision-free _(TD-05 / SI-03.2)_
- [ ] Streaming playback via presigned GET URLs with native HTTP Range _(TD-06 / SI-03.7)_
- [ ] Authenticated download via presigned GET URLs _(TD-06 / SI-03.7)_
- [ ] CORS configured on the bucket for browser-direct uploads _(TD-01 / SI-03.1)_
- [ ] Infra (storage + queue + worker) brought up via Docker Compose with the backend _(checklist §3 / SI-03.1)_
- [ ] Tests exercise real Compose infra where possible (real MinIO, Redis, FFmpeg) _(checklist §3 / SI-03.3, 03.4, 03.5, 03.7)_
- [ ] Real "Vídeos" section added to project docs, consistent with code _(checklist §1 / SI-03.8)_
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
