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

> **Documentation session note:** This document captures the **objective, base architecture, data model, and API contracts** derived from the decided Technical Decisions (`docs/decisions/technical-decisions-phase-03-videos.md`). Detailed **Step Implementations (SIs)** and any application code, Docker Compose changes, or dependency installs are **intentionally not produced in this session** — they are the subject of subsequent implementation work. The "Step Implementations" section below is a high-level outline only, to be expanded into full SIs before coding.

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

End-to-end flow (see decisions doc for the full numbered sequence):

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

> Indicative schema derived from the phase capabilities and decided TDs. Exact columns, types, and indexes are finalized when the entity and its migration are authored during implementation (no entity/migration is created in this session).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Unique per-video identifier; also the storage object-key prefix (TD-05) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (videos belong to a channel; Phase 02 created the channel) |
| title | varchar | nullable initially | Set/edited in Phase 04; draft may start without a final title |
| status | enum | not null | Lifecycle: `draft` / `uploaded` / `queued` / `processing` / `processed` / `failed` (TD-03) |
| object_key | varchar | nullable until upload | Storage key of the source video object (e.g., `videos/{id}/source`) |
| thumbnail_key | varchar | nullable until processed | Storage key of the generated thumbnail (TD-04) |
| duration_seconds | int | nullable until processed | Extracted by ffprobe (TD-04) |
| size_bytes | bigint | nullable until confirmed | Confirmed object size |
| content_type | varchar | nullable until confirmed | MIME type of the source object |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one).
**Indexes:** `(channel_id)`, `(status)` — for worker/status queries.

> **Note:** Visibility (público/unlisted), category, and the full draft→publish flow are **Phase 04** capabilities and are intentionally excluded from this entity for now. The `status` enum here covers only the ingestion/processing lifecycle.

---

### API Contracts (indicative)

> Contracts below express the intended shape implied by the decided flow. Final DTOs, status codes, and field names are settled during implementation against the project's REST conventions.

#### POST /videos (create draft + request upload URL) — authenticated
- **Auth:** Bearer access token (the authenticated user's channel owns the video).
- **Request body:** `filename`, `content_type`, `size_bytes` (for validation against the 10GB limit).
- **Response 201:** `{ id, upload_url, object_key, status: 'draft' }` — `upload_url` is the presigned (multipart) URL (TD-01).
- **Errors:** 400 validation (e.g., size over limit / unsupported type), 401 unauthenticated.

#### POST /videos/:id/confirm (confirm upload) — authenticated
- **Auth:** Bearer access token; caller must own the video's channel.
- **Effect:** API validates the stored object (existence/size/content-type), transitions `uploaded → queued`, and publishes a BullMQ job `{ videoId, objectKey }` (TD-03).
- **Response 200/204:** `{ id, status: 'queued' }`.
- **Errors:** 401, 403 (not owner), 404 (video not found), 409 (object missing / already confirmed).

#### GET /videos/:id (video status & metadata)
- **Response 200:** `{ id, status, duration_seconds?, thumbnail_url?, ... }` — reflects worker progress.
- **Notes:** `thumbnail_url` and playback URL are presigned GET URLs when available (TD-06).

#### GET /videos/:id/playback (streaming URL)
- **Response 200:** `{ url }` — short-lived presigned GET URL; the client/`<video>` element streams directly from storage with native HTTP Range (TD-06).

#### GET /videos/:id/download (download URL) — authenticated
- **Response 200:** `{ url }` — presigned GET URL with a download content-disposition (TD-06).

> Authorization matrix, error catalog additions (e.g., `VIDEO_NOT_FOUND`, `UPLOAD_NOT_CONFIRMED`, `FILE_TOO_LARGE`), and validation rules are finalized in the implementation SIs, extending the Phase 02 error contract (`{ statusCode, error, message }`).

---

## Step Implementations (high-level outline — to be expanded before coding)

> These are **placeholders** describing the intended decomposition, not implementable SIs. Each must be expanded with Technical actions, Tests, Dependencies, and Acceptance criteria (Phase 02 format) prior to implementation.

- **SI-03.1 — Infrastructure & config:** add MinIO and Redis services to Docker Compose; add the Video Worker container (worker mode, same image, FFmpeg/ffprobe installed); create `storage.config.ts` and `queue.config.ts` namespaces; extend the Joi env schema. _(TD-02, TD-03, TD-04)_
- **SI-03.2 — Video entity & migration:** create the `Video` entity and a generated `CreateVideos` migration; add a migration-runner integration test. _(TD-05)_
- **SI-03.3 — Storage module:** S3/MinIO client wrapper; presigned PUT (upload) and GET (playback/download) URL issuance; object validation. _(TD-01, TD-02, TD-06)_
- **SI-03.4 — Draft creation & presigned upload endpoint:** `POST /videos` — pre-register draft, issue presigned upload URL. _(TD-01, TD-05)_
- **SI-03.5 — Upload confirmation & job publishing:** `POST /videos/:id/confirm` — validate object, transition status, publish BullMQ job. _(TD-01, TD-03)_
- **SI-03.6 — Video Worker (processing):** queue consumer in the worker container; ffprobe metadata extraction; FFmpeg thumbnail generation; status/metadata updates with retry/backoff. _(TD-03, TD-04)_
- **SI-03.7 — Playback & download endpoints:** `GET /videos/:id/playback` and `/download` — presigned GET URLs. _(TD-06)_
- **SI-03.8 — CORS & cleanup:** bucket CORS configuration for browser-direct upload; DoD checks (tsc, lint, full suite). _(TD-01)_

---

## Dependency Map (outline)

```
SI-03.1 (infra/config — no deps)
└── SI-03.2 (entity/migration)
    └── SI-03.3 (storage module)
        ├── SI-03.4 (draft + presigned upload)
        │   └── SI-03.5 (confirm + publish job)
        │       └── SI-03.6 (worker processing)
        └── SI-03.7 (playback/download URLs)
SI-03.8 (CORS/cleanup — after SI-03.4)
```

---

## Deliverables

- [ ] Object storage integration (MinIO dev / S3-compatible) for video and thumbnail objects _(TD-02)_
- [ ] Presigned-URL upload flow supporting files up to 10GB without routing bytes through the API _(TD-01)_
- [ ] `Video` entity + `CreateVideos` migration with the ingestion/processing `status` lifecycle _(TD-05)_
- [ ] Draft pre-registration on upload initiation _(TD-01, TD-05)_
- [ ] BullMQ + Redis queue; API publishes `{ videoId, objectKey }` jobs on upload confirmation _(TD-03)_
- [ ] Video Worker container (same codebase, worker mode) consuming jobs, running ffprobe/FFmpeg _(TD-04)_
- [ ] Automatic metadata extraction (duration) and thumbnail generation _(TD-04)_
- [ ] Unique per-video URL via UUID, collision-free _(TD-05)_
- [ ] Streaming playback via presigned GET URLs with native HTTP Range _(TD-06)_
- [ ] Authenticated download via presigned GET URLs _(TD-06)_
- [ ] CORS configured on the bucket for browser-direct uploads _(TD-01)_
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
