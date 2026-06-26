import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { FileTooLargeException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Channel } from '../channels/entities/channel.entity';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';

/** Result of pre-registering a draft + issuing its presigned upload URL. */
export interface CreateDraftResult {
  id: string;
  upload_url: string;
  object_key: string;
  status: VideoStatus;
}

/** Builds the storage key for a video's source object (TD-05). */
export function sourceObjectKey(videoId: string): string {
  return `videos/${videoId}/source`;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Pre-registers a draft video for the authenticated user's channel and
   * returns a presigned PUT URL for the client to upload bytes directly to
   * storage (TD-01). The file never passes through the API.
   */
  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    if (dto.size_bytes > this.config.maxUploadBytes) {
      throw new FileTooLargeException(this.config.maxUploadBytes);
    }

    const channel = await this.channelRepository.findOneByOrFail({
      user_id: userId,
    });

    const video = this.videoRepository.create({
      channel_id: channel.id,
      status: VideoStatus.DRAFT,
      content_type: dto.content_type,
      size_bytes: String(dto.size_bytes),
    });
    const saved = await this.videoRepository.save(video);

    const objectKey = sourceObjectKey(saved.id);
    saved.object_key = objectKey;
    await this.videoRepository.save(saved);

    const uploadUrl = await this.storageService.getPresignedUploadUrl(
      objectKey,
      dto.content_type,
    );

    return {
      id: saved.id,
      upload_url: uploadUrl,
      object_key: objectKey,
      status: saved.status,
    };
  }
}
