# phase-03-videos — Progress

**Status:** planned (SIs detailed; implementation not started)
**SIs:** 0/8 implemented — all 8 fully specified in `phase-03-videos.md`

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
- **Status:** not started
- **Tests:** video.entity.integration-spec, migrations.integration-spec (updated for `video_status` enum cleanup)

### SI-03.3 — Storage Module & Presigned Upload (draft creation)
- **Status:** not started
- **Tests:** storage.service.spec (unit), storage.service.integration-spec (real MinIO), videos.service.spec/integration, videos.e2e

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

- Complete context7 doc fetch and fill `library-refs.md` (`context7_id`, `fetched_at`, verified API notes).
- Confirm FFmpeg install path in the worker Dockerfile and `fluent-ffmpeg` binary resolution.
- Decide exact BullMQ job options (`attempts`/`backoff` values) and queue test-isolation strategy.
- Finalize re-confirm idempotency behavior (SI-03.4) and worker re-delivery idempotency (SI-03.5).
