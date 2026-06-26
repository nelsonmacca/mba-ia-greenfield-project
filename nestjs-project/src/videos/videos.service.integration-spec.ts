import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { FileTooLargeException } from '../common/exceptions/domain.exception';
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
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + MinIO)', () => {
  let dataSource: DataSource;
  let service: VideosService;
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
      providers: [VideosService],
    }).compile();

    service = module.get(VideosService);
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
});
