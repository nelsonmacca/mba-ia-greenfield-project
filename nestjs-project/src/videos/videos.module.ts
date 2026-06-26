import { Module, type Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { FfmpegService } from './ffmpeg.service';
import { Video } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video-processor';
import { VideoProducerService } from './video-producer.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * The BullMQ consumer (`VideoProcessor`) is registered **only in worker mode**
 * (TD-04): in the API process it must not consume jobs. The orchestration and
 * FFmpeg services are always provided (also used directly by integration tests).
 */
export function workerOnlyProviders(
  workerMode: string | undefined,
): Provider[] {
  return workerMode === 'true' ? [VideoProcessor] : [];
}

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [
    VideosService,
    VideoProducerService,
    VideoProcessingService,
    FfmpegService,
    ...workerOnlyProviders(process.env.WORKER_MODE),
  ],
  exports: [TypeOrmModule],
})
export class VideosModule {}
