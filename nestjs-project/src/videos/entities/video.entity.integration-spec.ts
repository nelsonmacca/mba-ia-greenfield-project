import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
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
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  it('should auto-generate id, created_at, updated_at and default status to draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({ channel_id: channel.id }),
    );

    expect(saved.id).toBeDefined();
    expect(saved.created_at).toBeInstanceOf(Date);
    expect(saved.updated_at).toBeInstanceOf(Date);
    expect(saved.status).toBe(VideoStatus.DRAFT);
  });

  it('should leave optional metadata columns null on a draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({ channel_id: channel.id }),
    );

    expect(saved.title).toBeNull();
    expect(saved.object_key).toBeNull();
    expect(saved.thumbnail_key).toBeNull();
    expect(saved.duration_seconds).toBeNull();
    expect(saved.size_bytes).toBeNull();
    expect(saved.content_type).toBeNull();
    expect(saved.processing_error).toBeNull();
  });

  it('should reject a non-existent channel_id (FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject an invalid status enum value', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          status: 'bogus' as VideoStatus,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce title max length of 120 characters', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'a'.repeat(121),
        }),
      ),
    ).rejects.toThrow();
  });

  it('should cascade-delete videos when the owning channel is deleted', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({ channel_id: channel.id }),
    );

    await channelRepository.delete({ id: channel.id });

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found).toBeNull();
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({ channel_id: channel.id }),
    );

    const found = await videoRepository.findOne({
      where: { id: video.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
    expect(found?.channel.nickname).toBe(channel.nickname);
  });

  it('should persist a fully-processed video with all metadata', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My Video',
        status: VideoStatus.READY,
        object_key: `videos/abc/source`,
        thumbnail_key: `videos/abc/thumbnail.jpg`,
        duration_seconds: 120,
        size_bytes: '1048576',
        content_type: 'video/mp4',
      }),
    );

    const found = await videoRepository.findOneBy({ id: saved.id });
    expect(found?.status).toBe(VideoStatus.READY);
    expect(found?.duration_seconds).toBe(120);
    // bigint maps to string in TypeORM to preserve precision
    expect(found?.size_bytes).toBe('1048576');
  });
});
