import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideoProcessor } from './video-processor';
import { VideosModule, workerOnlyProviders } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('compiles with its entities, Storage/Queue modules, controller and producer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);

  describe('workerOnlyProviders (WORKER_MODE gate — TD-04)', () => {
    it('registers the BullMQ consumer only when WORKER_MODE=true', () => {
      expect(workerOnlyProviders('true')).toContain(VideoProcessor);
    });

    it('does not register the consumer in API mode', () => {
      expect(workerOnlyProviders(undefined)).toEqual([]);
      expect(workerOnlyProviders('false')).toEqual([]);
    });
  });
});
