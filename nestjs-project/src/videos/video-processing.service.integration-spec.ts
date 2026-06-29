import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { FfmpegService } from './ffmpeg.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { sourceObjectKey, thumbnailObjectKey } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURE_PATH = join(__dirname, '__fixtures__', 'sample.mp4');

/**
 * FFmpeg/ffprobe are system binaries present only in the video-worker image
 * (TD-04 — the API image stays slim). This real-infra spec therefore runs in
 * the worker container; in the API container it is skipped with a warning.
 */
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = hasFfmpeg();
if (!ffmpegAvailable) {
  console.warn(
    '[video-processing.integration] ffmpeg/ffprobe not found — skipping. ' +
      'This spec runs for real in the video-worker container (TD-04).',
  );
}

const describeWithFfmpeg = ffmpegAvailable ? describe : describe.skip;

describeWithFfmpeg(
  'VideoProcessingService (integration — real DB + MinIO + FFmpeg)',
  () => {
    let dataSource: DataSource;
    let service: VideoProcessingService;
    let storageService: StorageService;
    let userRepository: Repository<User>;
    let channelRepository: Repository<Channel>;
    let videoRepository: Repository<Video>;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
          TypeOrmModule.forFeature([Video, Channel]),
          StorageModule,
        ],
        providers: [VideoProcessingService, FfmpegService],
      }).compile();

      service = module.get(VideoProcessingService);
      storageService = module.get(StorageService);
      dataSource = module.get(DataSource);
      userRepository = dataSource.getRepository(User);
      channelRepository = dataSource.getRepository(Channel);
      videoRepository = dataSource.getRepository(Video);
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    beforeEach(async () => {
      await cleanAllTables(dataSource);
    });

    let counter = 0;
    async function seedQueuedVideo(): Promise<Video> {
      const n = ++counter;
      const user = await userRepository.save(
        userRepository.create({
          email: `vid_proc_${n}@example.com`,
          password: 'hashed',
        }),
      );
      const channel = await channelRepository.save(
        channelRepository.create({
          name: `chan${n}`,
          nickname: `procchan${n}`,
          user_id: user.id,
        }),
      );
      const video = await videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          status: VideoStatus.QUEUED,
          content_type: 'video/mp4',
        }),
      );
      video.object_key = sourceObjectKey(video.id);
      return videoRepository.save(video);
    }

    async function uploadToStorage(key: string, body: Buffer): Promise<void> {
      const url = await storageService.getPresignedUploadUrl(
        key,
        'application/octet-stream',
      );
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(body),
      });
      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status}`);
      }
    }

    it('processes a real fixture: duration populated, thumbnail stored, status ready', async () => {
      const video = await seedQueuedVideo();
      const fixture = await readFile(FIXTURE_PATH);
      await uploadToStorage(video.object_key!, fixture);

      await service.process(video.id, video.object_key!, false);

      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.status).toBe(VideoStatus.READY);
      expect(persisted.duration_seconds).toBeGreaterThan(0);
      expect(persisted.thumbnail_key).toBe(thumbnailObjectKey(video.id));
      expect(persisted.processing_error).toBeNull();

      // The thumbnail object really exists in MinIO.
      await expect(
        storageService.objectExists(thumbnailObjectKey(video.id)),
      ).resolves.toBe(true);
    }, 60000);

    it('marks failed with processing_error on a corrupt source (final attempt)', async () => {
      const video = await seedQueuedVideo();
      await uploadToStorage(video.object_key!, Buffer.from('not-a-real-video'));

      await expect(
        service.process(video.id, video.object_key!, true),
      ).rejects.toBeDefined();

      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.status).toBe(VideoStatus.FAILED);
      expect(persisted.processing_error).toBeTruthy();
    }, 60000);

    it('is idempotent against a ready video (no reprocessing)', async () => {
      const video = await seedQueuedVideo();
      const fixture = await readFile(FIXTURE_PATH);
      await uploadToStorage(video.object_key!, fixture);
      await service.process(video.id, video.object_key!, false);

      // Second delivery: must short-circuit, status stays ready.
      await service.process(video.id, video.object_key!, false);
      const persisted = await videoRepository.findOneByOrFail({ id: video.id });
      expect(persisted.status).toBe(VideoStatus.READY);
    }, 60000);
  },
);
