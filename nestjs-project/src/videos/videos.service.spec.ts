import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  FileTooLargeException,
  ForbiddenVideoAccessException,
  UploadNotConfirmedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProducerService } from './video-producer.service';
import { VideosService, sourceObjectKey } from './videos.service';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
  };
  let channelRepository: { findOneByOrFail: jest.Mock; findOneBy: jest.Mock };
  let storageService: jest.Mocked<
    Pick<
      StorageService,
      | 'getPresignedUploadUrl'
      | 'getPresignedDownloadUrl'
      | 'objectExists'
      | 'headObject'
    >
  >;
  let videoProducer: jest.Mocked<
    Pick<VideoProducerService, 'enqueueProcessing'>
  >;

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((data: Partial<Video>): Video => data as Video),
      save: jest.fn(),
      findOneBy: jest.fn(),
    };
    channelRepository = {
      findOneByOrFail: jest.fn(),
      findOneBy: jest.fn(),
    };
    storageService = {
      getPresignedUploadUrl: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
      objectExists: jest.fn(),
      headObject: jest.fn(),
    };
    videoProducer = { enqueueProcessing: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProducerService, useValue: videoProducer },
        {
          provide: storageConfig.KEY,
          useValue: { maxUploadBytes: MAX_UPLOAD_BYTES },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    const dto = {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
    };

    it('rejects a file larger than the configured maximum', async () => {
      await expect(
        service.createDraft('user-1', {
          ...dto,
          size_bytes: MAX_UPLOAD_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(channelRepository.findOneByOrFail).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('creates a draft for the user channel and returns the presigned upload URL', async () => {
      channelRepository.findOneByOrFail.mockResolvedValue({
        id: 'channel-9',
      } as Channel);
      videoRepository.save.mockImplementation((v: Video) =>
        Promise.resolve({ ...v, id: 'video-7' }),
      );
      storageService.getPresignedUploadUrl.mockResolvedValue(
        'https://signed/upload',
      );

      const result = await service.createDraft('user-1', dto);

      expect(channelRepository.findOneByOrFail).toHaveBeenCalledWith({
        user_id: 'user-1',
      });
      expect(result).toEqual({
        id: 'video-7',
        upload_url: 'https://signed/upload',
        object_key: sourceObjectKey('video-7'),
        status: VideoStatus.DRAFT,
      });
      expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith(
        sourceObjectKey('video-7'),
        'video/mp4',
      );
    });

    it('persists the draft with channel_id, draft status, content_type and size as string', async () => {
      channelRepository.findOneByOrFail.mockResolvedValue({
        id: 'channel-9',
      } as Channel);
      videoRepository.save.mockImplementation((v: Video) =>
        Promise.resolve({ ...v, id: 'video-7' }),
      );
      storageService.getPresignedUploadUrl.mockResolvedValue('url');

      await service.createDraft('user-1', dto);

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-9',
          status: VideoStatus.DRAFT,
          content_type: 'video/mp4',
          size_bytes: '1024',
        }),
      );
    });
  });

  describe('confirmUpload', () => {
    function draftVideo(overrides: Partial<Video> = {}): Video {
      return {
        id: 'video-7',
        channel_id: 'channel-9',
        status: VideoStatus.DRAFT,
        object_key: 'videos/video-7/source',
        content_type: 'video/mp4',
        size_bytes: '1024',
        ...overrides,
      } as Video;
    }

    it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.confirmUpload('user-1', 'missing'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws FORBIDDEN_VIDEO_ACCESS when the video is not in the user channel', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      channelRepository.findOneBy.mockResolvedValue({
        id: 'other-channel',
      } as Channel);

      await expect(
        service.confirmUpload('user-1', 'video-7'),
      ).rejects.toBeInstanceOf(ForbiddenVideoAccessException);
      expect(videoProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('throws UPLOAD_NOT_CONFIRMED when the object is absent', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      channelRepository.findOneBy.mockResolvedValue({
        id: 'channel-9',
      } as Channel);
      storageService.objectExists.mockResolvedValue(false);

      await expect(
        service.confirmUpload('user-1', 'video-7'),
      ).rejects.toBeInstanceOf(UploadNotConfirmedException);
      expect(videoProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('throws FILE_TOO_LARGE when the real object exceeds the cap', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      channelRepository.findOneBy.mockResolvedValue({
        id: 'channel-9',
      } as Channel);
      storageService.objectExists.mockResolvedValue(true);
      storageService.headObject.mockResolvedValue({
        size_bytes: MAX_UPLOAD_BYTES + 1,
        content_type: 'video/mp4',
      });

      await expect(
        service.confirmUpload('user-1', 'video-7'),
      ).rejects.toBeInstanceOf(FileTooLargeException);
      expect(videoProducer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('confirms, persists real metadata, transitions to queued and enqueues exactly one job', async () => {
      const video = draftVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      channelRepository.findOneBy.mockResolvedValue({
        id: 'channel-9',
      } as Channel);
      storageService.objectExists.mockResolvedValue(true);
      storageService.headObject.mockResolvedValue({
        size_bytes: 4096,
        content_type: 'video/webm',
      });
      videoRepository.save.mockImplementation((v: Video) => Promise.resolve(v));

      const result = await service.confirmUpload('user-1', 'video-7');

      expect(result).toEqual({ id: 'video-7', status: VideoStatus.QUEUED });
      expect(video.size_bytes).toBe('4096');
      expect(video.content_type).toBe('video/webm');
      expect(videoProducer.enqueueProcessing).toHaveBeenCalledTimes(1);
      expect(videoProducer.enqueueProcessing).toHaveBeenCalledWith(
        'video-7',
        'videos/video-7/source',
      );
      // uploaded write then queued write
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
    });

    it('enqueues while still uploaded so the job is published before the queued write', async () => {
      const video = draftVideo();
      videoRepository.findOneBy.mockResolvedValue(video);
      channelRepository.findOneBy.mockResolvedValue({
        id: 'channel-9',
      } as Channel);
      storageService.objectExists.mockResolvedValue(true);
      storageService.headObject.mockResolvedValue({
        size_bytes: 4096,
        content_type: 'video/mp4',
      });
      let statusWhenEnqueued: VideoStatus | undefined;
      videoProducer.enqueueProcessing.mockImplementation(() => {
        statusWhenEnqueued = video.status;
        return Promise.resolve();
      });
      videoRepository.save.mockImplementation((v: Video) => Promise.resolve(v));

      await service.confirmUpload('user-1', 'video-7');

      expect(statusWhenEnqueued).toBe(VideoStatus.UPLOADED);
    });

    it.each([
      VideoStatus.QUEUED,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ])(
      'is idempotent for %s — returns current status without enqueuing',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue(draftVideo({ status }));
        channelRepository.findOneBy.mockResolvedValue({
          id: 'channel-9',
        } as Channel);

        const result = await service.confirmUpload('user-1', 'video-7');

        expect(result).toEqual({ id: 'video-7', status });
        expect(videoProducer.enqueueProcessing).not.toHaveBeenCalled();
        expect(storageService.objectExists).not.toHaveBeenCalled();
      },
    );
  });

  describe('getById', () => {
    const createdAt = new Date('2026-06-29T12:00:00.000Z');

    function storedVideo(overrides: Partial<Video> = {}): Video {
      return {
        id: 'video-7',
        channel_id: 'channel-9',
        title: 'My clip',
        status: VideoStatus.DRAFT,
        object_key: 'videos/video-7/source',
        thumbnail_key: null,
        duration_seconds: null,
        size_bytes: '1024',
        content_type: 'video/mp4',
        processing_error: null,
        created_at: createdAt,
        updated_at: createdAt,
        ...overrides,
      } as Video;
    }

    it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.getById('missing')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('omits duration and thumbnail for a draft, never leaking storage keys', async () => {
      videoRepository.findOneBy.mockResolvedValue(storedVideo());

      const result = await service.getById('video-7');

      expect(result).toEqual({
        id: 'video-7',
        status: VideoStatus.DRAFT,
        title: 'My clip',
        created_at: createdAt.toISOString(),
      });
      expect(result).not.toHaveProperty('object_key');
      expect(result).not.toHaveProperty('thumbnail_url');
      expect(result).not.toHaveProperty('duration_seconds');
      expect(storageService.getPresignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('includes duration and a presigned thumbnail URL for a ready video', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        storedVideo({
          status: VideoStatus.READY,
          duration_seconds: 42,
          thumbnail_key: 'videos/video-7/thumbnail.jpg',
        }),
      );
      storageService.getPresignedDownloadUrl.mockResolvedValue(
        'https://signed/thumb',
      );

      const result = await service.getById('video-7');

      expect(result).toEqual({
        id: 'video-7',
        status: VideoStatus.READY,
        title: 'My clip',
        duration_seconds: 42,
        thumbnail_url: 'https://signed/thumb',
        created_at: createdAt.toISOString(),
      });
      expect(storageService.getPresignedDownloadUrl).toHaveBeenCalledWith(
        'videos/video-7/thumbnail.jpg',
      );
    });
  });
});
