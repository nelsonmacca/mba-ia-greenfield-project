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
  - "BullMQ job options (attempts/backoff), re-confirm idempotency (SI-03.4), and worker re-delivery idempotency (SI-03.5) are intentionally fixed at implementation, not in the plan."
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

- **SI-03.2 (Video entity + migration) implemented.** The `Video` entity (linked to `Channel` via `channel_id` FK, `onDelete: CASCADE`), the `video_status` enum (`draft/uploaded/queued/processing/ready/failed`, default `draft`), `(channel_id)` + `(status)` indexes, and the CLI-generated `CreateVideos` migration are in place and verified against a fresh DB. The `migrations.integration-spec.ts` advisory pattern (drop the enum type explicitly — the `bb0010e` lesson) was extended to `video_status`. A Postgres deadlock surfaced when `videos` joined the parallel `DROP TABLE ... CASCADE` cleanup; resolved by making the drops sequential. No new libraries (TypeORM-only; UUID PK per TD-05). Full suite (162 tests) + `tsc --noEmit` green.
