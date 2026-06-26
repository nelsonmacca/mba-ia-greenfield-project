import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import { Video, VideoStatus } from './entities/video.entity';
import { thumbnailObjectKey } from './videos.service';

const THUMBNAIL_FILENAME = 'thumbnail.jpg';
const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/**
 * Worker-side orchestration for a `process-video` job (TD-04): download the
 * source from storage, extract duration via ffprobe, generate a thumbnail,
 * persist metadata, and transition the video to `ready` (or `failed`).
 *
 * Runs only in the worker container (the processor that calls it is gated to
 * `WORKER_MODE`). Idempotent: an already-`ready` video is skipped, so BullMQ
 * re-delivery never re-processes or duplicates the thumbnail.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  /**
   * Processes one job. On failure, rethrows so BullMQ can retry; only when
   * `isFinalAttempt` is true does it persist `failed` + `processing_error`
   * before rethrowing (so the job is also recorded as failed in the queue).
   */
  async process(
    videoId: string,
    objectKey: string,
    isFinalAttempt: boolean,
  ): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      // Nothing to process and nothing to retry — the record is gone.
      this.logger.warn(`Video ${videoId} not found; skipping job`);
      return;
    }

    if (video.status === VideoStatus.READY) {
      this.logger.log(`Video ${videoId} already ready; skipping (idempotent)`);
      return;
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    let workDir: string | undefined;
    try {
      workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
      const sourcePath = join(workDir, 'source');
      await this.storageService.downloadToFile(objectKey, sourcePath);

      const durationSeconds =
        await this.ffmpegService.probeDurationSeconds(sourcePath);

      await this.ffmpegService.generateThumbnail(
        sourcePath,
        workDir,
        THUMBNAIL_FILENAME,
      );
      const thumbnailKey = thumbnailObjectKey(videoId);
      await this.storageService.uploadFile(
        thumbnailKey,
        join(workDir, THUMBNAIL_FILENAME),
        THUMBNAIL_CONTENT_TYPE,
      );

      video.duration_seconds = durationSeconds;
      video.thumbnail_key = thumbnailKey;
      video.processing_error = null;
      video.status = VideoStatus.READY;
      await this.videoRepository.save(video);
      this.logger.log(
        `Video ${videoId} processed (duration=${durationSeconds}s)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Processing failed for video ${videoId}: ${message}`);
      if (isFinalAttempt) {
        video.status = VideoStatus.FAILED;
        video.processing_error = message;
        await this.videoRepository.save(video);
      }
      // Rethrow so BullMQ records the failure and retries until attempts exhaust.
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}
