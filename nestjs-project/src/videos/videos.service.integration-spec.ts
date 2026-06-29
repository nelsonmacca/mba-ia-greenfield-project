import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import {
  FileTooLargeException,
  ForbiddenVideoAccessException,
  UploadNotConfirmedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProducerService } from './video-producer.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + MinIO + Redis)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let storageService: StorageService;
  let queue: Queue<ProcessVideoJobData>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, Channel]),
        StorageModule,
        QueueModule,
      ],
      providers: [VideosService, VideoProducerService],
    }).compile();

    service = module.get(VideosService);
    storageService = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function seedUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_svc_${n}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan${n}`,
        nickname: `chan${n}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  const dto = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 2048,
  };

  it('persists a draft row linked to the user channel with object_key set', async () => {
    const { user, channel } = await seedUserWithChannel();

    const result = await service.createDraft(user.id, dto);

    expect(result.status).toBe(VideoStatus.DRAFT);
    expect(result.object_key).toBe(`videos/${result.id}/source`);
    expect(result.upload_url).toContain('http');

    const persisted = await videoRepository.findOneByOrFail({ id: result.id });
    expect(persisted.channel_id).toBe(channel.id);
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.object_key).toBe(result.object_key);
    expect(persisted.content_type).toBe('video/mp4');
    expect(persisted.size_bytes).toBe('2048');
    expect(persisted.thumbnail_key).toBeNull();
    expect(persisted.duration_seconds).toBeNull();
  });

  it('issues a presigned upload URL that accepts the upload against real MinIO', async () => {
    const { user } = await seedUserWithChannel();

    const result = await service.createDraft(user.id, dto);

    const putRes = await fetch(result.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: 'fake-video-bytes',
    });
    expect(putRes.ok).toBe(true);

    await expect(storageService.objectExists(result.object_key)).resolves.toBe(
      true,
    );
  }, 30000);

  it('rejects an oversized file before persisting anything', async () => {
    const { user } = await seedUserWithChannel();

    await expect(
      service.createDraft(user.id, {
        ...dto,
        size_bytes: 10 * 1024 * 1024 * 1024 + 1,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeException);

    await expect(videoRepository.count()).resolves.toBe(0);
  });

  describe('confirmUpload', () => {
    async function draftAndUpload(
      userId: string,
      body = 'fake-video-bytes',
    ): Promise<{ id: string; objectKey: string }> {
      const draft = await service.createDraft(userId, dto);
      await fetch(draft.upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        body,
      });
      return { id: draft.id, objectKey: draft.object_key };
    }

    it('transitions to queued and enqueues exactly one process-video job in Redis', async () => {
      const { user } = await seedUserWithChannel();
      const { id, objectKey } = await draftAndUpload(user.id);

      const result = await service.confirmUpload(user.id, id);

      expect(result).toEqual({ id, status: VideoStatus.QUEUED });

      const persisted = await videoRepository.findOneByOrFail({ id });
      expect(persisted.status).toBe(VideoStatus.QUEUED);
      expect(persisted.size_bytes).toBe(
        String(Buffer.byteLength('fake-video-bytes')),
      );

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
      expect(jobs[0].data).toEqual({ videoId: id, objectKey });
    }, 30000);

    it('is idempotent — re-confirming does not enqueue a second job', async () => {
      const { user } = await seedUserWithChannel();
      const { id } = await draftAndUpload(user.id);

      await service.confirmUpload(user.id, id);
      const second = await service.confirmUpload(user.id, id);

      expect(second.status).toBe(VideoStatus.QUEUED);
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
    }, 30000);

    it('throws UPLOAD_NOT_CONFIRMED when no object was uploaded', async () => {
      const { user } = await seedUserWithChannel();
      const draft = await service.createDraft(user.id, dto);

      await expect(
        service.confirmUpload(user.id, draft.id),
      ).rejects.toBeInstanceOf(UploadNotConfirmedException);

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(0);
    });

    it('throws FORBIDDEN_VIDEO_ACCESS for a non-owner', async () => {
      const owner = await seedUserWithChannel();
      const stranger = await seedUserWithChannel();
      const { id } = await draftAndUpload(owner.user.id);

      await expect(
        service.confirmUpload(stranger.user.id, id),
      ).rejects.toBeInstanceOf(ForbiddenVideoAccessException);
    }, 30000);

    it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
      const { user } = await seedUserWithChannel();

      await expect(
        service.confirmUpload(user.id, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
