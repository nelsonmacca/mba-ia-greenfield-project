import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../videos/video-processing.constants';

/** Default retry/backoff for video-processing jobs (TD-03). */
const VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  // Keep failed jobs for inspection (worker failure handling lands in SI-03.5).
  removeOnFail: false,
};

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: VIDEO_JOB_OPTIONS,
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
