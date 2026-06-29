import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Exercises the real MinIO service from Compose (TD-02): a presigned PUT
 * round-trips bytes back through a presigned GET, and HeadObject/objectExists
 * reflect the real object state.
 */
describe('StorageService (integration — real MinIO)', () => {
  let service: StorageService;
  let client: S3Client;
  const keys: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
    client = module.get(S3_CLIENT);
  });

  afterAll(async () => {
    const bucket = process.env.STORAGE_BUCKET ?? 'streamtube-videos';
    for (const key of keys) {
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        .catch(() => undefined);
    }
    client.destroy();
  });

  function newKey(): string {
    const key = `videos/${randomUUID()}/source`;
    keys.push(key);
    return key;
  }

  it('uploads bytes via a presigned PUT and reads them back via a presigned GET', async () => {
    const key = newKey();
    const body = 'streamtube-presigned-roundtrip';
    const contentType = 'text/plain';

    const uploadUrl = await service.getPresignedUploadUrl(key, contentType);
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });
    expect(putRes.ok).toBe(true);

    const downloadUrl = await service.getPresignedDownloadUrl(key);
    const getRes = await fetch(downloadUrl);
    expect(getRes.ok).toBe(true);
    expect(await getRes.text()).toBe(body);
  }, 30000);

  it('reports object metadata and existence after upload', async () => {
    const key = newKey();
    const body = 'hello';
    const contentType = 'application/octet-stream';

    await expect(service.objectExists(key)).resolves.toBe(false);

    const uploadUrl = await service.getPresignedUploadUrl(key, contentType);
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });

    await expect(service.objectExists(key)).resolves.toBe(true);
    const meta = await service.headObject(key);
    expect(meta.size_bytes).toBe(Buffer.byteLength(body));
    expect(meta.content_type).toBe(contentType);
  }, 30000);
});
