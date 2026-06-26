import { Test } from '@nestjs/testing';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

const TEST_CONFIG = {
  bucket: 'test-bucket',
  uploadUrlTtl: 900,
  downloadUrlTtl: 3600,
  maxUploadBytes: 100,
};

describe('StorageService (unit)', () => {
  let service: StorageService;
  let client: jest.Mocked<Pick<S3Client, 'send'>>;

  beforeEach(async () => {
    client = { send: jest.fn() };
    mockGetSignedUrl.mockReset();
    mockGetSignedUrl.mockResolvedValue('https://signed.example/url');

    const module = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: S3_CLIENT, useValue: client },
        { provide: storageConfig.KEY, useValue: TEST_CONFIG },
      ],
    }).compile();

    service = module.get(StorageService);
  });

  describe('getPresignedUploadUrl', () => {
    it('signs a PutObjectCommand for the configured bucket and given key/content-type', async () => {
      const url = await service.getPresignedUploadUrl(
        'videos/abc/source',
        'video/mp4',
      );

      expect(url).toBe('https://signed.example/url');
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [, command, options] = mockGetSignedUrl.mock.calls[0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect((command as PutObjectCommand).input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'videos/abc/source',
        ContentType: 'video/mp4',
      });
      expect(options?.expiresIn).toBe(900);
    });

    it('makes content-type a signable header so the upload must echo it', async () => {
      await service.getPresignedUploadUrl('k', 'video/mp4');
      const [, , options] = mockGetSignedUrl.mock.calls[0];
      expect(options?.signableHeaders).toEqual(new Set(['content-type']));
    });
  });

  describe('getPresignedDownloadUrl', () => {
    it('signs a GetObjectCommand with the default download TTL', async () => {
      await service.getPresignedDownloadUrl('videos/abc/source');

      const [, command, options] = mockGetSignedUrl.mock.calls[0];
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect((command as GetObjectCommand).input).toMatchObject({
        Bucket: 'test-bucket',
        Key: 'videos/abc/source',
      });
      expect(options?.expiresIn).toBe(3600);
    });

    it('applies a content-disposition override and custom expiry when provided', async () => {
      await service.getPresignedDownloadUrl('k', {
        contentDisposition: 'attachment; filename="v.mp4"',
        expiresIn: 60,
      });

      const [, command, options] = mockGetSignedUrl.mock.calls[0];
      expect((command as GetObjectCommand).input).toMatchObject({
        ResponseContentDisposition: 'attachment; filename="v.mp4"',
      });
      expect(options?.expiresIn).toBe(60);
    });
  });

  describe('headObject', () => {
    it('maps HeadObject output to size_bytes/content_type', async () => {
      client.send.mockResolvedValue({
        ContentLength: 42,
        ContentType: 'video/mp4',
      } as never);

      const meta = await service.headObject('k');

      expect(meta).toEqual({ size_bytes: 42, content_type: 'video/mp4' });
      const command = client.send.mock.calls[0][0];
      expect(command).toBeInstanceOf(HeadObjectCommand);
    });
  });

  describe('objectExists', () => {
    it('returns true when the object is present', async () => {
      client.send.mockResolvedValue({ ContentLength: 1 } as never);
      await expect(service.objectExists('k')).resolves.toBe(true);
    });

    it('returns false on a NotFound error', async () => {
      client.send.mockRejectedValue(
        Object.assign(new Error('not found'), { name: 'NotFound' }) as never,
      );
      await expect(service.objectExists('k')).resolves.toBe(false);
    });

    it('returns false on a 404 $metadata status', async () => {
      client.send.mockRejectedValue(
        Object.assign(new Error('nope'), {
          $metadata: { httpStatusCode: 404 },
        }) as never,
      );
      await expect(service.objectExists('k')).resolves.toBe(false);
    });

    it('rethrows non-not-found errors', async () => {
      client.send.mockRejectedValue(
        Object.assign(new Error('boom'), {
          $metadata: { httpStatusCode: 500 },
        }) as never,
      );
      await expect(service.objectExists('k')).rejects.toThrow('boom');
    });
  });
});
