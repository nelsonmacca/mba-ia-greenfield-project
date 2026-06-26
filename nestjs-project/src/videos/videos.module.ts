import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProducerService } from './video-producer.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProducerService],
  exports: [TypeOrmModule],
})
export class VideosModule {}
