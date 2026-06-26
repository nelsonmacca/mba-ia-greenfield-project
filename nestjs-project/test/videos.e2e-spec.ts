import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
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
    return res.body.access_token;
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

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('draft');
      expect(res.body.object_key).toBe(`videos/${res.body.id}/source`);
      expect(typeof res.body.upload_url).toBe('string');
      expect(res.body.upload_url).toContain('http');
    });

    it('returns 400 with FILE_TOO_LARGE when size exceeds the cap', async () => {
      const accessToken = await registerConfirmAndLogin('toobig@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, size_bytes: 10 * 1024 * 1024 * 1024 + 1 })
        .expect(400);

      expect(res.body.error).toBe('FILE_TOO_LARGE');
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

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 with VALIDATION_ERROR on unknown extra field', async () => {
      const accessToken = await registerConfirmAndLogin('extra@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, admin: true })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });
});
