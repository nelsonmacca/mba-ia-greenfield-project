---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1075.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T00:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1075.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T00:00:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-06-26T00:00:00-03:00"
  bullmq:
    version: "^5.79.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-26T00:00:00-03:00"
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T00:00:00-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.1.28"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T00:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-25T00:00:00-03:00"
---

# phase-03-videos — Library References

Libraries newly introduced by Phase 03's decided TDs. Versions below were probed from the npm registry inside the `nestjs-api` container on 2026-06-25 (latest published at planning time); pin with `^` to allow patch/minor updates at install.

> **Context7 status — fetched 2026-06-26.** The project's `CLAUDE.md` mandates a **context7** documentation lookup before implementing any feature that involves a library. Docs for every library below were fetched via the context7 MCP at the start of SI-03.1; `context7_id` and `fetched_at` are now filled in and each "API notes" section reflects **verified** documentation. Re-fetch if a library's major version changes before later SIs.

## @aws-sdk/client-s3 (TD-01, TD-02, TD-06)

**Intended use:** S3/MinIO client. Configured with a custom `endpoint` (MinIO Compose service URL), `forcePathStyle: true` (required for MinIO), `region`, and credentials. Used for `CreateMultipartUploadCommand` / object existence checks (`HeadObjectCommand`) and bucket operations.

**API notes (context7-verified, `/aws/aws-sdk-js-v3`, 2026-06-26):**

- For MinIO, construct `new S3Client({ endpoint, forcePathStyle: true, region, credentials: { accessKeyId, secretAccessKey } })`. `forcePathStyle: true` is required so requests use path-style (`endpoint/bucket/key`) instead of virtual-hosted-style (`bucket.endpoint`), which MinIO needs.
- Commands are separate objects from `@aws-sdk/client-s3`: `PutObjectCommand`, `GetObjectCommand`, `HeadObjectCommand`, `DeleteObjectCommand`, `CreateMultipartUploadCommand`. Either `client.send(command)` or the aggregated `S3` convenience methods (`client.deleteObject({...})`, `client.paginateListObjectsV2({...})`).
- `S3Client` (modular) vs `S3` (aggregated client) — both accept the same config object.

## @aws-sdk/s3-request-presigner (TD-01, TD-06)

**Intended use:** `getSignedUrl(client, command, { expiresIn })` to issue presigned PUT (upload) and GET (playback/download) URLs. CORS on the bucket is required for browser-direct PUT.

**API notes (context7-verified, `/aws/aws-sdk-js-v3`, 2026-06-26):**

- `import { getSignedUrl } from "@aws-sdk/s3-request-presigner";` then `const url = await getSignedUrl(client, command, { expiresIn })`. `getSignedUrl` is async (returns a Promise).
- `expiresIn` is **seconds**, default **900** (15 min) when omitted.
- Works with any command instance: `new PutObjectCommand({ Bucket, Key, Body })` for upload, `new GetObjectCommand({ Bucket, Key })` for playback/download.
- To enforce non-`x-amz-*` headers (e.g. `content-type`) in the signature, pass `signableHeaders: new Set(["content-type"])` in the options — the client must then send a matching header on PUT.

## @nestjs/bullmq + bullmq (TD-03)

**Intended use:** `BullModule.forRoot({ connection: { host, port } })` (Redis via Compose service name) + `BullModule.registerQueue({ name: 'video-processing' })`. Producer injects the queue (`@InjectQueue`) and calls `queue.add(...)`; the worker container uses a `@Processor('video-processing')` consumer with retry/backoff (`attempts`, `backoff`).

**API notes (context7-verified — `@nestjs/bullmq` via `/nestjs/bull`, `bullmq` via `/taskforcesh/bullmq`, 2026-06-26):**

- Global connection: `BullModule.forRoot({ connection: { host, port } })` (sets `global: true`). Async/config-driven variant `BullModule.forRootAsync({ useFactory: () => ({ connection: { host, port } }) })` — use this to inject host/port from `ConfigService`.
- Queue registration: `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts, backoff } })` (or `registerQueueAsync` with `useFactory`). `defaultJobOptions` extends bullmq `QueueOptions`.
- Job options (bullmq `DefaultJobOptions`): `attempts` (default 1), `backoff` as `{ type: 'exponential' | 'fixed', delay /* ms */, jitter? }` (or a plain number = fixed delay ms), `delay`, `removeOnComplete`, `removeOnFail`.
- Producer: inject the queue with `@InjectQueue('video-processing')` and call `queue.add(name, data, jobOpts)`.
- Consumer (worker): class decorated `@Processor('video-processing')` **extending `WorkerHost`** with an abstract `async process(job: Job): Promise<any>`; worker events via `@OnWorkerEvent('completed' | 'failed' | ...)`. Note: `@nestjs/bullmq` uses the `@Processor` class + `WorkerHost` pattern, **not** `@nestjs/bull`'s `@Process` method decorator.
- Worker concurrency/options are passed as the second `@Processor(name, { concurrency })` arg or via `registerQueueAsync` `processors`/worker options.
- Worker-only mode (no HTTP listener) is achieved at the app bootstrap level (`NestFactory.createApplicationContext` instead of `.create(...).listen()`); BullMQ itself does not require an HTTP server.

## fluent-ffmpeg + @types/fluent-ffmpeg (TD-04)

**Intended use:** Wrapper over the FFmpeg/ffprobe **system binaries** (installed in the worker image — not an npm-bundled binary). `ffprobe` for duration/metadata; FFmpeg `screenshots`/`thumbnail` for a single-frame thumbnail.

**API notes (context7-verified, `/fluent-ffmpeg/node-fluent-ffmpeg`, 2026-06-26):**

- Point at system binaries via `ffmpeg.setFfmpegPath(path)` and `ffmpeg.setFfprobePath(path)` (also `setFlvtoolPath`). Use when binaries are not on `PATH` / env vars are not set.
- Metadata: `ffmpeg(path).ffprobe(cb)` / `ffmpeg.ffprobe(path, cb)` returns the `ffprobe -of json -show_streams -show_format` shape — top-level `format` (with `duration` in seconds-as-string, `size`, `bit_rate`, `tags`) and `streams[]` (each with `codec_type` `'video'`/`'audio'`, `width`, `height`, `duration`, `codec_name`, …). Read duration from `format.duration` (string seconds) or the video stream's `duration`.
- Thumbnail: `ffmpeg(input).screenshots({ count, folder, filename, size, timestamps })` (aliases: `thumbnail`, `screenshot`). For a single frame use `count: 1` or `timestamps: ['50%']`. `filename` supports tokens (`%s` offset, `%b` basename, `%i` index, `%r` resolution, …); `size` like `'320x240'`. Emits a `'filenames'` event with the generated names; listen on `'end'`/`'error'`.
- The `ffmpeg`/`ffprobe` **system binaries** must be installed in the worker image (Dockerfile `apt-get install ffmpeg`) — `fluent-ffmpeg` is only the JS wrapper and bundles no binary.

---

## Notes

- All hosts (MinIO, Redis) are referenced by **Docker Compose service name**, never `localhost` (global `CLAUDE.md` rule).
- FFmpeg/ffprobe are **system binaries** in the worker image, installed via the worker Dockerfile — `fluent-ffmpeg` is only the JS wrapper. This is an infra dependency, not just an npm install.
- Versions are a planning snapshot; re-confirm at install time and re-fetch context7 docs if a major version has shipped since.
