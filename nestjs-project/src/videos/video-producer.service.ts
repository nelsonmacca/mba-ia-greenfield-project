import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

/**
 * Publishes `process-video` jobs to BullMQ (TD-03). The job carries only
 * `videoId` + `objectKey` — never the file bytes. The worker consumer lands in
 * SI-03.5.
 */
@Injectable()
export class VideoProducerService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  async enqueueProcessing(videoId: string, objectKey: string): Promise<void> {
    await this.queue.add(PROCESS_VIDEO_JOB, { videoId, objectKey });
  }
}
