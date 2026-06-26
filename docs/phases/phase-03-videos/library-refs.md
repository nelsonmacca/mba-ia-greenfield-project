---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1075.0"
    context7_id: "PENDING — context7 MCP unavailable in planning session"
    fetched_at: null
  "@aws-sdk/s3-request-presigner":
    version: "^3.1075.0"
    context7_id: "PENDING — context7 MCP unavailable in planning session"
    fetched_at: null
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "PENDING — context7 MCP unavailable in planning session"
    fetched_at: null
  bullmq:
    version: "^5.79.1"
    context7_id: "PENDING — context7 MCP unavailable in planning session"
    fetched_at: null
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "PENDING — context7 MCP unavailable in planning session"
    fetched_at: null
  "@types/fluent-ffmpeg":
    version: "^2.1.28"
    context7_id: "PENDING — context7 MCP unavailable in planning session"
    fetched_at: null
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-25T00:00:00-03:00"
---

# phase-03-videos — Library References

Libraries newly introduced by Phase 03's decided TDs. Versions below were probed from the npm registry inside the `nestjs-api` container on 2026-06-25 (latest published at planning time); pin with `^` to allow patch/minor updates at install.

> **Context7 status — action required before implementation.** The project's `CLAUDE.md` mandates a **context7** documentation lookup before implementing any feature that involves a library. The context7 MCP server was **not available** in this planning session, so the distilled API notes below are intentionally **not yet written** and `context7_id` / `fetched_at` are marked `PENDING`. **At the start of SI implementation, fetch each library's docs via context7, fill in `context7_id` and `fetched_at`, and replace each "API notes" stub with verified, version-matched guidance.** Do not implement against the notes below until this is done — they record only the intended usage surface, not verified documentation.

## @aws-sdk/client-s3 (TD-01, TD-02, TD-06)

**Intended use:** S3/MinIO client. Configured with a custom `endpoint` (MinIO Compose service URL), `forcePathStyle: true` (required for MinIO), `region`, and credentials. Used for `CreateMultipartUploadCommand` / object existence checks (`HeadObjectCommand`) and bucket operations.

**API notes (verify via context7 before coding):** `S3Client` construction options for MinIO (`endpoint`, `forcePathStyle`, `credentials`), command objects for object head/put/get, and the multipart upload command surface.

## @aws-sdk/s3-request-presigner (TD-01, TD-06)

**Intended use:** `getSignedUrl(client, command, { expiresIn })` to issue presigned PUT (upload) and GET (playback/download) URLs. CORS on the bucket is required for browser-direct PUT.

**API notes (verify via context7 before coding):** `getSignedUrl` signature, supported commands, `expiresIn` semantics, and presigned-URL constraints for multipart vs single PUT.

## @nestjs/bullmq + bullmq (TD-03)

**Intended use:** `BullModule.forRoot({ connection: { host, port } })` (Redis via Compose service name) + `BullModule.registerQueue({ name: 'video-processing' })`. Producer injects the queue (`@InjectQueue`) and calls `queue.add(...)`; the worker container uses a `@Processor('video-processing')` consumer with retry/backoff (`attempts`, `backoff`).

**API notes (verify via context7 before coding):** `@nestjs/bullmq` module registration, `@InjectQueue`/`@Processor`/`WorkerHost`, job options (`attempts`, `backoff`, `removeOnComplete`), and how to run a NestJS app in worker-only mode (no HTTP listener).

## fluent-ffmpeg + @types/fluent-ffmpeg (TD-04)

**Intended use:** Wrapper over the FFmpeg/ffprobe **system binaries** (installed in the worker image — not an npm-bundled binary). `ffprobe` for duration/metadata; FFmpeg `screenshots`/`thumbnail` for a single-frame thumbnail.

**API notes (verify via context7 before coding):** `ffprobe(path, cb)` metadata shape (duration, streams), `.screenshots({ count, folder, filename, size })`, error/event handling, and pointing fluent-ffmpeg at the system `ffmpeg`/`ffprobe` paths. Confirm whether the system binaries must be installed via the worker Dockerfile (yes — `ffmpeg` apt package) rather than an npm package.

---

## Notes

- All hosts (MinIO, Redis) are referenced by **Docker Compose service name**, never `localhost` (global `CLAUDE.md` rule).
- FFmpeg/ffprobe are **system binaries** in the worker image, installed via the worker Dockerfile — `fluent-ffmpeg` is only the JS wrapper. This is an infra dependency, not just an npm install.
- Versions are a planning snapshot; re-confirm at install time and re-fetch context7 docs if a major version has shipped since.
