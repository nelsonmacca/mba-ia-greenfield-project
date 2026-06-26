import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingService } from './video-processing.service';

/**
 * BullMQ consumer for the `video-processing` queue (TD-03/TD-04). Registered as
 * a provider **only in worker mode** (see VideosModule), so the API process
 * never consumes jobs. Delegates all orchestration to VideoProcessingService.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, objectKey } = job.data;
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
    await this.processingService.process(videoId, objectKey, isFinalAttempt);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoJobData>, err: Error): void {
    this.logger.error(
      `Job ${job.id ?? '?'} failed (attempt ${job.attemptsMade}): ${err.message}`,
    );
  }
}
