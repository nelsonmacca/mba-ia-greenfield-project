import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FileTooLargeException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService, sourceObjectKey } from './videos.service';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: { create: jest.Mock; save: jest.Mock };
  let channelRepository: { findOneByOrFail: jest.Mock };
  let storageService: jest.Mocked<
    Pick<StorageService, 'getPresignedUploadUrl'>
  >;

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(),
    };
    channelRepository = { findOneByOrFail: jest.fn() };
    storageService = { getPresignedUploadUrl: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: StorageService, useValue: storageService },
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
      videoRepository.save.mockImplementation(async (v) => ({
        id: 'video-7',
        ...v,
      }));
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
      videoRepository.save.mockImplementation(async (v) => ({
        id: 'video-7',
        ...v,
      }));
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
});
