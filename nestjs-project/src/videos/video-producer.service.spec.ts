import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProducerService } from './video-producer.service';

describe('VideoProducerService (unit)', () => {
  let service: VideoProducerService;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideoProducerService,
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(VideoProducerService);
  });

  it('publishes a process-video job carrying only videoId and objectKey', async () => {
    await service.enqueueProcessing('video-1', 'videos/video-1/source');

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(PROCESS_VIDEO_JOB, {
      videoId: 'video-1',
      objectKey: 'videos/video-1/source',
    });
  });
});
