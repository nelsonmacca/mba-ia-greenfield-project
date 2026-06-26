---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-25
scope_description: "Backend foundation for video upload and processing: large-file upload via presigned URLs to object storage, draft pre-registration, background processing queue, FFmpeg worker for metadata extraction and thumbnail generation, unique per-video URLs, streaming playback, and download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video draft pre-registration, presigned upload orchestration, upload confirmation, queue job publishing, video status lifecycle, streaming/download endpoints, and the object-storage integration.
- **Video Worker** — a new container (same NestJS codebase, started in worker mode — see TD-03) that consumes processing jobs, runs FFmpeg/ffprobe, extracts metadata, generates the thumbnail, and updates video status/metadata in PostgreSQL.
- `next-frontend/` — Frontend deferred: upload UI and streaming playback surfaces are addressed in a later phase. No open decision in this document.

> **Scope note:** This document records the **base architectural decisions** for Phase 03 only. It does not define Step Implementations or write any application code. Infrastructure changes (adding Redis/MinIO/worker services to Docker Compose) and dependency installs are explicitly **out of scope for the documentation session** and will be executed in subsequent implementation work.

---

## TD-01: Large-File Upload Strategy (up to 10GB)

**Scope:** Cross-layer (Backend + Storage)

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The platform must accept video files up to 10GB without degrading API availability or memory. The decisive question is whether the file bytes flow **through** the NestJS API or **directly** to object storage. Routing 10GB through the API turns it into a bandwidth/memory bottleneck and couples upload duration to request lifetimes.

**Options:**

### Option A: Presigned URL — direct client → S3/MinIO
- The API authenticates the user, creates a draft video record, and issues a presigned (multipart) URL. The browser uploads bytes **directly** to the object storage; the API never proxies the file. After upload, the client calls a confirmation endpoint, and the API enqueues processing.
- **Pros:** API never handles file bytes — no memory/bandwidth bottleneck, scales to 10GB naturally. Storage handles multipart resumability primitives. Clean separation: API orchestrates, storage stores. Standard S3 pattern, portable between MinIO (dev) and S3 (prod).
- **Cons:** Requires CORS configuration on the bucket. Needs a two-step flow (init draft + issue URL → confirm upload). Validation of the stored object (size/content-type) happens after the fact, on confirmation.

### Option B: Upload via API (streaming/multipart proxy)
- The file passes through the NestJS API, which streams it to storage. Auth and validation happen inline before the bytes land.
- **Pros:** Inline auth and validation. Single endpoint, simpler client flow. Full control over the byte stream.
- **Cons:** API becomes a bandwidth/memory bottleneck for large files. Long-lived requests tie up server resources for the upload duration. Does not scale to 10GB without significant tuning and risk.

### Option C: Resumable upload (tus protocol)
- A resumable upload server (tus) handles chunked, resumable uploads robust to unstable connections.
- **Pros:** Best resilience for huge files over flaky networks. Resumability built in.
- **Cons:** Adds a tus server dependency and protocol complexity. Heavier than needed for the MVP. Another moving part to operate.

**Recommendation:** **Option A (Presigned URL — direct to S3/MinIO)** — For 10GB uploads, keeping the bytes off the API is the decisive factor. The API authenticates, pre-registers the draft, issues a presigned URL, and only after upload confirmation publishes the processing job. CORS on the bucket is a one-time setup cost. The worker reads the object from storage. A simple multipart/presigned flow is sufficient for the MVP; resumable/tus is deferred as a future evolution.

**Decision:** A (Presigned URL — direct client → S3/MinIO)

**Implications for the plan:**
- Flow: **API (draft + presigned URL) → client uploads to storage → API (confirm) → queue → worker → status/metadata**.
- The API only orchestrates; it never receives the file bytes.
- CORS must be configured on MinIO/S3.
- Resumable/tus is explicitly out of scope for the base decision.

---

## TD-02: Object Storage Provider

**Scope:** Backend / Storage

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails need durable object storage. The architecture diagram (C4) and `CLAUDE.md` already point to **S3/MinIO**. The choice is which provider to standardize on for development and how it maps to production.

**Options:**

### Option A: MinIO (S3-compatible) for dev, S3 in prod
- Run MinIO as a Docker Compose service for local development; use the AWS S3 SDK (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) which speaks the same API to both MinIO and AWS S3.
- **Pros:** Matches the architecture diagram. Single SDK and codebase for dev (MinIO) and prod (S3). Fully local, offline-capable development. Presigned URLs (TD-01) supported natively. No vendor lock-in at the code level.
- **Cons:** Adds a MinIO container to Compose. Presigned URL + CORS setup needed for browser-direct uploads.

### Option B: AWS S3 only (cloud, even in dev)
- Use real AWS S3 buckets for both dev and prod.
- **Pros:** Single real environment, no MinIO container.
- **Cons:** Requires internet access and AWS credentials for local dev. Cost and account management. Breaks the project's fully-local Docker development model.

**Recommendation:** **Option A (MinIO for dev, S3 in prod)** — Aligns with the C4 diagram and the project's container-first, fully-local development principle. The AWS S3 SDK abstracts both targets, so application code is identical. MinIO presigned URLs satisfy TD-01.

**Decision:** A (MinIO for dev / S3-compatible via AWS SDK)

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-03: Background Processing Queue (Message Queue — was "TBD")

**Scope:** Cross-layer (Backend + Worker)

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload

**Context:** The README lists the Message Queue as **"TBD"**. Phase 03 needs an asynchronous queue with retry, backoff, job state, and clean separation between the API (producer) and the worker (consumer), so that heavy FFmpeg work never runs in the API process.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- BullMQ over Redis. The API publishes jobs via `@nestjs/bullmq`; the worker consumes them. Redis added to Docker Compose as dedicated queue infrastructure.
- **Pros:** De-facto standard in the NestJS ecosystem with first-class `@nestjs/bullmq` integration. Retry, backoff, job states, events, and dashboards available out of the box. Clean producer/consumer split. Mature and well-documented.
- **Cons:** Adds Redis to the stack. In-memory broker semantics (durability tuning needed for critical jobs).

### Option B: RabbitMQ (AMQP)
- A robust AMQP broker decoupling API ↔ worker, with native `@nestjs/microservices` transport.
- **Pros:** Strong decoupling and routing. Mature AMQP semantics.
- **Cons:** Heavier operational footprint than Redis. More setup than needed for the MVP's single processing pipeline.

### Option C: PostgreSQL as queue (pg-boss)
- Use the existing PostgreSQL as the queue (pg-boss), avoiding new infrastructure.
- **Pros:** Zero new infrastructure — reuses Postgres.
- **Cons:** Lower throughput/resources than BullMQ. Mixes transactional persistence with heavy video-processing workload on the same datastore.

**Recommendation:** **Option A (BullMQ + Redis)** — Mature, simple, and idiomatic for NestJS via `@nestjs/bullmq`. Provides retry/backoff and job lifecycle states needed for resilient video processing, with a clean producer/consumer boundary. Redis is added as dedicated queue infrastructure. RabbitMQ remains a future alternative for more complex AMQP scenarios; Postgres-as-queue is rejected to avoid coupling transactional persistence to heavy processing.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq`, `bullmq`, Redis (Docker Compose service)

**Implications for the plan:**
- The API publishes a job after upload confirmation; the job carries **`videoId` and the storage `objectKey`/path — never the file itself**.
- The worker updates video status across the lifecycle: `uploaded` / `queued` / `processing` / `processed` / `failed`.
- Use retry/backoff for transient failures.

---

## TD-04: Video Worker Topology (FFmpeg)

**Scope:** Architecture / Backend

**Capability:** Processamento automático do vídeo; Geração automática de thumbnail a partir de um frame do vídeo

**Context:** FFmpeg-based processing (metadata extraction, thumbnail generation) is CPU/memory intensive and long-running. Running it inside the API process risks timeouts, resource contention, and availability impact. The C4 diagram already depicts a dedicated **Video Worker** container. The question is how to structure that worker for this phase.

**Options:**

### Option A: Separate worker container, same NestJS codebase
- A new Docker Compose service running the **same** NestJS codebase started in **worker mode** — it consumes the BullMQ queue and does not expose an HTTP server. Shares entities, config, and storage clients with the API.
- **Pros:** Aligns with the C4 diagram (dedicated Video Worker container). Decouples encoding CPU/memory from the API. Reuses entities/config/DataSource — no code duplication. Independent scaling and restart from the API.
- **Cons:** A second container to operate. Needs a separate bootstrap/entrypoint that starts the queue consumer without the HTTP listener.

### Option B: Worker process inside the API
- Processing runs in the same container as the API (same process or a child).
- **Pros:** Simplest now — no new container.
- **Cons:** Couples encoding bandwidth/CPU to the API. Risks timeouts and availability impact. Diverges from the C4 diagram.

### Option C: Independent worker subproject
- A new standalone subproject (e.g., `video-worker/`) with its own `package.json` and Dockerfile.
- **Pros:** Maximum isolation.
- **Cons:** Duplicates setup and configuration. Heavier than needed for this phase.

**Recommendation:** **Option A (separate worker container, same NestJS codebase)** — FFmpeg must run outside the API's HTTP process to avoid coupling and availability impact, but a fully independent subproject is unnecessary for this phase. The worker is another Docker Compose container running the same NestJS code in worker mode (queue consumer, no HTTP server). It reads the object from MinIO/S3, runs ffprobe/FFmpeg, extracts metadata and thumbnail, and updates status/metadata in PostgreSQL. An independent worker subproject remains a future evolution if the domain grows.

**Decision:** A (Separate worker container, same NestJS codebase, worker mode)

**Libraries:** FFmpeg/ffprobe (system binaries in the worker image), an FFmpeg invocation wrapper (e.g., `fluent-ffmpeg`) to be confirmed at implementation against installed versions.

**Implications for the plan:**
- The API owns auth, endpoints, video records, and job publishing.
- The Video Worker is a separate Compose container consuming BullMQ/Redis jobs.
- The worker downloads/reads the object from MinIO/S3, runs ffprobe/FFmpeg, extracts metadata + thumbnail, and updates status/metadata in PostgreSQL.
- The job carries only `videoId` and `objectKey`/path, never the file.

---

## TD-05: Unique Per-Video URL / Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, collision-free public identifier used in its URL and as the storage object key prefix. The choice affects URL readability, enumeration resistance, and storage key layout.

**Options:**

### Option A: UUID (v4) as the video ID and URL slug
- The video's primary key is a generated UUID; the public URL uses that UUID. Storage object key namespaced by it (e.g., `videos/{uuid}/source.mp4`).
- **Pros:** Globally unique with zero coordination — no collisions by construction. Already the project's PK convention (users, channels, tokens all use uuid). Non-enumerable. Trivial to derive the storage key from the ID.
- **Cons:** Not human-friendly (long, opaque). No embedded ordering.

### Option B: Short ID (nanoid / base62, e.g., 11 chars — "YouTube-style")
- Generate a short random ID (nanoid) for the public URL, separate from the internal PK.
- **Pros:** Short, shareable URLs resembling mainstream video platforms. Non-enumerable.
- **Cons:** Adds a dependency and a second identifier to manage alongside the uuid PK. Requires collision handling (retry on the rare duplicate). More moving parts than UUID for the MVP.

**Recommendation:** **Option A (UUID)** — The project already standardizes on uuid primary keys across all entities. Reusing the uuid as the unique per-video identifier and storage key prefix guarantees collision-free URLs with zero extra dependencies and a uniform convention. A shorter "YouTube-style" slug (nanoid) can be layered on in a later phase if URL aesthetics justify it, without changing the storage layout.

**Decision:** A (UUID as the unique per-video identifier)

**Libraries:** — (TypeORM generated uuid, existing convention)

---

## TD-06: Video Streaming & Download Delivery

**Scope:** Cross-layer (Backend + Storage)

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Anonymous users must be able to stream videos without downloading the whole file, and authenticated users must be able to download. The decision is whether bytes are served by the API or by object storage, and how HTTP range requests (seeking/partial playback) are honored.

**Options:**

### Option A: Presigned GET URLs from storage (storage serves bytes; range honored by S3/MinIO)
- The API issues a presigned GET URL (short-lived) for the video object; the client (or `<video>` element) fetches directly from MinIO/S3, which natively supports HTTP Range requests for streaming/seeking. Download is the same URL with a download disposition.
- **Pros:** Symmetric with the upload decision (TD-01) — bytes never pass through the API. Native Range support from storage enables true streaming/seek without API involvement. Scales for large files and many viewers. Short-lived URLs provide basic access control.
- **Cons:** Presigned GET URLs are time-limited and (without extra signing) shareable within their TTL. Fine-grained per-request authorization is coarser than an API proxy.

### Option B: API proxy with Range support
- The API streams bytes from storage to the client, implementing HTTP Range itself.
- **Pros:** Full per-request authorization control. Hides storage entirely.
- **Cons:** Re-introduces the API as a bandwidth bottleneck — the exact problem TD-01 avoids for uploads, now on the read path. Does not scale for large videos / many concurrent viewers.

**Recommendation:** **Option A (Presigned GET URLs from storage)** — Keeping read bytes off the API mirrors the upload decision and lets MinIO/S3 handle HTTP Range natively, which is what enables streaming/seek without downloading the full file. Short-lived presigned URLs provide adequate access control for the MVP (public videos are watchable freely per the product overview). Download uses the same mechanism with a download content-disposition. An API-proxied, finer-grained authorization path can be revisited if private/unlisted-video access control in later phases requires it.

**Decision:** A (Presigned GET URLs; storage serves bytes with native Range support)

**Libraries:** `@aws-sdk/s3-request-presigner` (shared with TD-01/TD-02)

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Large-File Upload Strategy (10GB) | Presigned URL direct to S3/MinIO | A (Presigned URL direct to S3/MinIO) |
| TD-02 | Object Storage Provider | MinIO (dev) / S3 via AWS SDK | A (MinIO dev / S3-compatible) |
| TD-03 | Background Processing Queue | BullMQ + Redis | A (BullMQ + Redis) |
| TD-04 | Video Worker Topology (FFmpeg) | Separate container, same NestJS code | A (Separate worker container, worker mode) |
| TD-05 | Unique Per-Video URL / Identifier | UUID | A (UUID) |
| TD-06 | Video Streaming & Download Delivery | Presigned GET URLs from storage | A (Presigned GET URLs, native Range) |

## End-to-End Flow (base architecture)

```
1. Client → API:        POST  create draft video (auth)        → API persists Video (status: draft/uploaded-pending)
2. API → Client:        presigned multipart upload URL          (TD-01, TD-02)
3. Client → Storage:    uploads file bytes directly to MinIO/S3 (CORS required; bytes never touch API)
4. Client → API:        POST  confirm upload (videoId)          → API validates object, status: uploaded → queued
5. API → Queue:         publish job { videoId, objectKey }      (TD-03; never the file itself)
6. Worker ← Queue:      consume job                              (TD-04, separate container)
7. Worker → Storage:    read object; run ffprobe/FFmpeg          → extract metadata + generate thumbnail
8. Worker → Storage:    upload thumbnail object
9. Worker → DB:         update status (processing → processed/failed) + duration/metadata
10. Viewer → API:       request playback/download URL            → API issues presigned GET URL (TD-06)
11. Viewer → Storage:   streams via HTTP Range / downloads        (bytes never touch API)
```

## Deferred / Future Evolutions (recorded, not decided now)

| Topic | Deferred choice | Rationale |
|-------|-----------------|-----------|
| Resumable upload (tus) | Future | MVP uses simple multipart/presigned (TD-01) |
| RabbitMQ (AMQP) | Future alternative | BullMQ + Redis sufficient for MVP (TD-03) |
| Independent worker subproject (`video-worker/`) | Future | Same-codebase worker container sufficient now (TD-04) |
| Short "YouTube-style" slug (nanoid) | Future | UUID sufficient and collision-free (TD-05) |
| API-proxied delivery with fine-grained authz | Future | Presigned GET adequate for public-video MVP (TD-06) |
| Adaptive bitrate / HLS transcoding | Out of scope this phase | Phase 03 extracts metadata + thumbnail; transcoding not in plan scope |
