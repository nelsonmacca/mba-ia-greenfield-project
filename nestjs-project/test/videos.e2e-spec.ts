import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MailService } from '../src/mail/mail.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../src/videos/video-processing.constants';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface DraftBody {
  id: string;
  status: string;
  object_key: string;
  upload_url: string;
}

interface ErrorBody {
  error: string;
}

interface LoginBody {
  access_token: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60000);

  afterAll(async () => {
    // This suite enqueues real jobs onto the shared `video-processing` queue,
    // which the video-worker consumes asynchronously (writing to the shared
    // test DB). Tear the queue down deterministically before touching the DB
    // or closing the app, otherwise in-flight/retried work and a leaked BullMQ
    // Redis connection outlive this suite and break the next suite's FK-ordered
    // table cleanup (e.g. auth.e2e).
    await queue.pause();
    // Removes waiting, delayed (retry backoff) and active jobs.
    await queue.obliterate({ force: true });
    // obliterate() does not release the connection — close it explicitly so it
    // does not dangle into the next suite (app.close() alone is not enough).
    await queue.close();
    // Leave the shared DB empty so no orphan videos/channels rows survive into
    // the next suite's cleanup.
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const mailService = app.get(MailService);
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        token = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return (res.body as LoginBody).access_token;
  }

  const validBody = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
  };

  describe('POST /videos', () => {
    it('returns 201 with id, upload_url, object_key and draft status', async () => {
      const accessToken = await registerConfirmAndLogin('uploader@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);

      const body = res.body as DraftBody;
      expect(body.id).toBeDefined();
      expect(body.status).toBe('draft');
      expect(body.object_key).toBe(`videos/${body.id}/source`);
      expect(typeof body.upload_url).toBe('string');
      expect(body.upload_url).toContain('http');
    });

    it('returns 400 with FILE_TOO_LARGE when size exceeds the cap', async () => {
      const accessToken = await registerConfirmAndLogin('toobig@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, size_bytes: 10 * 1024 * 1024 * 1024 + 1 })
        .expect(400);

      expect((res.body as ErrorBody).error).toBe('FILE_TOO_LARGE');
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('returns 400 with VALIDATION_ERROR on missing content_type', async () => {
      const accessToken = await registerConfirmAndLogin('novalid@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ filename: 'clip.mp4', size_bytes: 1024 })
        .expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 with VALIDATION_ERROR on unknown extra field', async () => {
      const accessToken = await registerConfirmAndLogin('extra@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, admin: true })
        .expect(400);

      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/confirm', () => {
    async function draftAndUpload(accessToken: string): Promise<string> {
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);
      const draft = draftRes.body as DraftBody;
      await fetch(draft.upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        body: 'fake-video-bytes',
      });
      return draft.id;
    }

    it('returns 200 with status queued and enqueues a job', async () => {
      const accessToken = await registerConfirmAndLogin('confirm@example.com');
      const id = await draftAndUpload(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/confirm`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toEqual({ id, status: 'queued' });
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({
        videoId: id,
        objectKey: `videos/${id}/source`,
      });
    }, 30000);

    it('returns 409 UPLOAD_NOT_CONFIRMED when the object was not uploaded', async () => {
      const accessToken = await registerConfirmAndLogin('noobj@example.com');
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);
      const draftId = (draftRes.body as DraftBody).id;

      const res = await request(app.getHttpServer())
        .post(`/videos/${draftId}/confirm`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);

      expect((res.body as ErrorBody).error).toBe('UPLOAD_NOT_CONFIRMED');
    });

    it('returns 403 FORBIDDEN_VIDEO_ACCESS for a non-owner', async () => {
      const owner = await registerConfirmAndLogin('owner@example.com');
      const id = await draftAndUpload(owner);
      const stranger = await registerConfirmAndLogin('stranger@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/confirm`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(403);

      expect((res.body as ErrorBody).error).toBe('FORBIDDEN_VIDEO_ACCESS');
    }, 30000);

    it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
      const accessToken = await registerConfirmAndLogin('nf@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 400 on a malformed (non-uuid) id', async () => {
      const accessToken = await registerConfirmAndLogin('baduuid@example.com');

      await request(app.getHttpServer())
        .post('/videos/not-a-uuid/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/confirm')
        .expect(401);
    });
  });

  describe('GET /videos/:id', () => {
    interface VideoBody {
      id: string;
      status: string;
      title: string | null;
      created_at: string;
      duration_seconds?: number;
      thumbnail_url?: string;
    }

    it('returns the draft status without auth, omitting duration/thumbnail and storage keys', async () => {
      const accessToken = await registerConfirmAndLogin('reader@example.com');
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);
      const id = (draftRes.body as DraftBody).id;

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}`)
        .expect(200);

      const body = res.body as VideoBody;
      expect(body.id).toBe(id);
      expect(body.status).toBe('draft');
      expect(body.created_at).toBeDefined();
      expect(body).not.toHaveProperty('duration_seconds');
      expect(body).not.toHaveProperty('thumbnail_url');
      expect(body).not.toHaveProperty('object_key');
      expect(body).not.toHaveProperty('thumbnail_key');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .expect(404);

      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 400 on a malformed (non-uuid) id', async () => {
      await request(app.getHttpServer()).get('/videos/not-a-uuid').expect(400);
    });
  });

  describe('playback & download', () => {
    interface UrlBody {
      url: string;
    }

    /** Drafts + uploads a real source object, then marks the video `ready`. */
    async function createReadyVideo(
      email: string,
    ): Promise<{ id: string; accessToken: string }> {
      const accessToken = await registerConfirmAndLogin(email);
      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);
      const draft = draftRes.body as DraftBody;
      await fetch(draft.upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        body: 'fake-video-bytes',
      });
      await dataSource
        .getRepository(Video)
        .update({ id: draft.id }, { status: VideoStatus.READY });
      return { id: draft.id, accessToken };
    }

    describe('GET /videos/:id/playback', () => {
      it('returns a presigned URL (no auth) that serves bytes with HTTP Range → 206', async () => {
        const { id } = await createReadyVideo('playback@example.com');

        const res = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .expect(200);

        const { url } = res.body as UrlBody;
        expect(typeof url).toBe('string');
        expect(url).toContain('http');

        const ranged = await fetch(url, { headers: { Range: 'bytes=0-3' } });
        expect(ranged.status).toBe(206);
      }, 30000);

      it('returns 409 VIDEO_NOT_READY before the video is ready', async () => {
        const accessToken = await registerConfirmAndLogin(
          'notready@example.com',
        );
        const draftRes = await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${accessToken}`)
          .send(validBody)
          .expect(201);
        const id = (draftRes.body as DraftBody).id;

        const res = await request(app.getHttpServer())
          .get(`/videos/${id}/playback`)
          .expect(409);

        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      });

      it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
        const res = await request(app.getHttpServer())
          .get('/videos/00000000-0000-0000-0000-000000000000/playback')
          .expect(404);

        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      });
    });

    describe('GET /videos/:id/download', () => {
      it('returns a presigned download URL for an authenticated user', async () => {
        const { id, accessToken } = await createReadyVideo(
          'download@example.com',
        );

        const res = await request(app.getHttpServer())
          .get(`/videos/${id}/download`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        const { url } = res.body as UrlBody;
        expect(typeof url).toBe('string');
        expect(url).toContain('http');
      }, 30000);

      it('returns 401 without an Authorization header', async () => {
        await request(app.getHttpServer())
          .get('/videos/00000000-0000-0000-0000-000000000000/download')
          .expect(401);
      });

      it('returns 409 VIDEO_NOT_READY before the video is ready', async () => {
        const accessToken = await registerConfirmAndLogin(
          'dlnotready@example.com',
        );
        const draftRes = await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${accessToken}`)
          .send(validBody)
          .expect(201);
        const id = (draftRes.body as DraftBody).id;

        const res = await request(app.getHttpServer())
          .get(`/videos/${id}/download`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(409);

        expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      });
    });
  });
});
