import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { thumbnailObjectKey } from './videos.service';

describe('VideoProcessingService (unit)', () => {
  let service: VideoProcessingService;
  let videoRepository: { findOneBy: jest.Mock; save: jest.Mock };
  let storageService: jest.Mocked<
    Pick<StorageService, 'downloadToFile' | 'uploadFile'>
  >;
  let ffmpegService: jest.Mocked<
    Pick<FfmpegService, 'probeDurationSeconds' | 'generateThumbnail'>
  >;

  const VIDEO_ID = 'video-1';
  const OBJECT_KEY = 'videos/video-1/source';

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: VIDEO_ID,
      status: VideoStatus.QUEUED,
      object_key: OBJECT_KEY,
      duration_seconds: null,
      thumbnail_key: null,
      processing_error: null,
      ...overrides,
    } as Video;
  }

  beforeEach(async () => {
    videoRepository = { findOneBy: jest.fn(), save: jest.fn() };
    storageService = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      uploadFile: jest.fn().mockResolvedValue(undefined),
    };
    ffmpegService = {
      probeDurationSeconds: jest.fn(),
      generateThumbnail: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: FfmpegService, useValue: ffmpegService },
      ],
    }).compile();

    service = module.get(VideoProcessingService);
  });

  it('returns early when the video does not exist (no retry)', async () => {
    videoRepository.findOneBy.mockResolvedValue(null);

    await expect(
      service.process('missing', OBJECT_KEY, true),
    ).resolves.toBeUndefined();
    expect(videoRepository.save).not.toHaveBeenCalled();
    expect(storageService.downloadToFile).not.toHaveBeenCalled();
  });

  it('is idempotent — skips an already-ready video', async () => {
    videoRepository.findOneBy.mockResolvedValue(
      draftVideo({ status: VideoStatus.READY }),
    );

    await service.process(VIDEO_ID, OBJECT_KEY, true);

    expect(storageService.downloadToFile).not.toHaveBeenCalled();
    expect(ffmpegService.probeDurationSeconds).not.toHaveBeenCalled();
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('processes: download → probe → thumbnail → persist ready with metadata', async () => {
    const video = draftVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    videoRepository.save.mockImplementation((v: Video) => Promise.resolve(v));
    ffmpegService.probeDurationSeconds.mockResolvedValue(42);

    await service.process(VIDEO_ID, OBJECT_KEY, false);

    expect(storageService.downloadToFile).toHaveBeenCalledWith(
      OBJECT_KEY,
      expect.stringContaining('source'),
    );
    expect(ffmpegService.generateThumbnail).toHaveBeenCalledTimes(1);
    expect(storageService.uploadFile).toHaveBeenCalledWith(
      thumbnailObjectKey(VIDEO_ID),
      expect.stringContaining('thumbnail.jpg'),
      'image/jpeg',
    );
    expect(video.status).toBe(VideoStatus.READY);
    expect(video.duration_seconds).toBe(42);
    expect(video.thumbnail_key).toBe(thumbnailObjectKey(VIDEO_ID));
    expect(video.processing_error).toBeNull();
    // processing write + ready write
    expect(videoRepository.save).toHaveBeenCalledTimes(2);
  });

  it('sets status to processing before invoking ffmpeg', async () => {
    const video = draftVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    videoRepository.save.mockImplementation((v: Video) => Promise.resolve(v));
    let statusWhenProbed: VideoStatus | undefined;
    ffmpegService.probeDurationSeconds.mockImplementation(() => {
      statusWhenProbed = video.status;
      return Promise.resolve(10);
    });

    await service.process(VIDEO_ID, OBJECT_KEY, false);

    expect(statusWhenProbed).toBe(VideoStatus.PROCESSING);
  });

  it('on final-attempt failure: marks failed with processing_error and rethrows', async () => {
    const video = draftVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    videoRepository.save.mockImplementation((v: Video) => Promise.resolve(v));
    ffmpegService.probeDurationSeconds.mockRejectedValue(
      new Error('corrupt input'),
    );

    await expect(service.process(VIDEO_ID, OBJECT_KEY, true)).rejects.toThrow(
      'corrupt input',
    );
    expect(video.status).toBe(VideoStatus.FAILED);
    expect(video.processing_error).toBe('corrupt input');
  });

  it('on non-final-attempt failure: rethrows without marking failed', async () => {
    const video = draftVideo();
    videoRepository.findOneBy.mockResolvedValue(video);
    videoRepository.save.mockImplementation((v: Video) => Promise.resolve(v));
    ffmpegService.probeDurationSeconds.mockRejectedValue(
      new Error('transient'),
    );

    await expect(service.process(VIDEO_ID, OBJECT_KEY, false)).rejects.toThrow(
      'transient',
    );
    expect(video.status).not.toBe(VideoStatus.FAILED);
    expect(video.processing_error).toBeNull();
  });
});
