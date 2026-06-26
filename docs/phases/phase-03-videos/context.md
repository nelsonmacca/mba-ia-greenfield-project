---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-04-08T14:58:57-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-25T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T13:36:17-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade (público/unlisted), fluxo rascunho→publicação completo, painel de gerenciamento e página pública do canal (Fase 04); página de visualização do vídeo (Fase 05); interações sociais (Fase 06); transcodificação adaptativa/HLS; upload resumível (tus).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API produtora + Video Worker como container em modo worker compartilhando a mesma base de código — ver TD-04).

**Deferred subprojects:** `next-frontend/` — telas de upload e player de streaming ficam diferidas para uma fase futura de frontend.

**Sequencing notes:** Depends on Fase 01 — Configuração Base e Fase 02 — Cadastro, Login e Gerenciamento de Conta (vídeos pertencem a um canal; upload exige usuário autenticado).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Cross-layer | Large-File Upload Strategy (10GB) | decided | A (Presigned URL direct to S3/MinIO) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend/Storage | Object Storage Provider | decided | A (MinIO dev / S3-compatible) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Cross-layer | Background Processing Queue | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Architecture | Video Worker Topology (FFmpeg) | decided | A (Separate worker container, same codebase) | FFmpeg/ffprobe, fluent-ffmpeg (TBC at impl) |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Per-Video URL / Identifier | decided | A (UUID) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Video Streaming & Download Delivery | decided | A (Presigned GET URLs, native Range) | @aws-sdk/s3-request-presigner |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-01, phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-01 (fluxo init draft + presigned URL), phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (Presigned URL — direct to S3/MinIO) — For 10GB uploads, keeping the bytes off the API is decisive. The API authenticates, pre-registers the draft, issues a presigned URL, and only after upload confirmation publishes the processing job. CORS on the bucket is a one-time cost. The worker reads the object from storage. Simple multipart/presigned suffices for the MVP; resumable/tus is deferred.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-02

**Recommendation:** Option A (MinIO for dev, S3 in prod) — Aligns with the C4 diagram and the project's fully-local Docker development principle. The AWS S3 SDK abstracts both targets, so application code is identical. MinIO presigned URLs satisfy TD-01.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-03

**Recommendation:** Option A (BullMQ + Redis) — Mature and idiomatic for NestJS via `@nestjs/bullmq`. Provides retry/backoff and job lifecycle states for resilient processing with a clean producer/consumer boundary. Redis added as dedicated queue infrastructure. The job carries only `videoId` + `objectKey`, never the file.

**Libraries:** `@nestjs/bullmq`, `bullmq`

### phase-03-videos/TD-04

**Recommendation:** Option A (separate worker container, same NestJS codebase) — FFmpeg must run outside the API's HTTP process, but a fully independent subproject is unnecessary for this phase. The worker is another Compose container running the same code in worker mode (queue consumer, no HTTP). It reads from MinIO/S3, runs ffprobe/FFmpeg, extracts metadata + thumbnail, and updates status/metadata in PostgreSQL.

**Libraries:** FFmpeg/ffprobe (system binaries), `fluent-ffmpeg` (to be confirmed at implementation)

### phase-03-videos/TD-05

**Recommendation:** Option A (UUID) — The project already standardizes on uuid PKs across all entities. Reusing the uuid as the unique per-video identifier and storage key prefix guarantees collision-free URLs with zero extra dependencies. A shorter slug (nanoid) can be layered on later.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option A (Presigned GET URLs from storage) — Keeping read bytes off the API mirrors the upload decision and lets MinIO/S3 handle HTTP Range natively, enabling streaming/seek without full download. Short-lived presigned URLs are adequate for the public-video MVP; download uses the same mechanism with a download content-disposition.

**Libraries:** `@aws-sdk/s3-request-presigner`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_ → Phase 03 adds `storage.config.ts` and `queue.config.ts` namespaces following this pattern.
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`. _(from phase 01)_ → Phase 03 extends the schema with storage (MinIO/S3 endpoint, bucket, credentials) and queue (Redis host/port) variables.
- Config injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `synchronize: false`; schema changes only via TypeORM migrations generated by the CLI; migrations must be idempotent with `IF EXISTS`/`IF NOT EXISTS` guards. _(from phase 01 / typeorm-migrations rule)_ → Phase 03 adds a `CreateVideos` migration.
- Standardized error response `{ statusCode, error, message }` via the domain exception filter; new domain exceptions extend `DomainException`. _(from phase 02 / TD-07)_
- Global `ValidationPipe` with `whitelist`/`forbidNonWhitelisted`/`transform`; DTOs validated via class-validator. _(from phase 02 / TD-06)_
- JWT auth guard is global; endpoints are protected by default with `@Public()` opt-out; upload/confirm/download-management endpoints require authentication. _(from phase 02 / TD-02)_
- All services/containers communicate via Docker Compose service names, never `localhost`. _(from global CLAUDE.md)_ → Redis and MinIO hosts use Compose service names.
- Test suffixes `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts`; integration/e2e run with `--runInBand`. _(from nestjs-project CLAUDE.md)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities relevant to Phase 03 (the Phase 02 deferred frontend screens belong to the frontend track)._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Telas de upload e player de streaming | deferred | `next-frontend/` video UI is addressed in a later frontend phase. | phase-03-videos/TD-01, phase-03-videos/TD-06 |
| Upload resumível (tus) | deferred | MVP uses simple multipart/presigned. | phase-03-videos/TD-01 |
| Transcodificação adaptativa / HLS | out of scope | Phase 03 extracts metadata + thumbnail only; transcoding not in plan scope. | phase-03-videos/TD-04 |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces the `Video` entity, video DTOs, a storage service (presigned URL issuance), a queue producer (API) and consumer (worker), and FFmpeg processing logic. Expected coverage by the pyramid:

- **Unit (`*.spec.ts`):** storage service URL/key construction (mocked S3 client), queue producer job payload construction (mocked queue), video status state transitions, worker processing orchestration (mocked FFmpeg/storage/repo).
- **Integration (`*.integration-spec.ts`):** `Video` entity persistence and constraints against the real DB; the `CreateVideos` migration via the migration runner; storage service against a real MinIO (presigned URL round-trip) where feasible.
- **E2E (`*.e2e-spec.ts`):** create-draft → confirm-upload → status endpoints over HTTP; auth enforcement on upload/management endpoints; presigned playback/download URL issuance.

Specific layer coverage per Step Implementation will be recorded in `progress.md` during implementation (not in this documentation session).
