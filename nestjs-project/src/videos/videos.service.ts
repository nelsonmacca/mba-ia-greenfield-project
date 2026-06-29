import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  FileTooLargeException,
  ForbiddenVideoAccessException,
  UploadNotConfirmedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Channel } from '../channels/entities/channel.entity';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import { VideoProducerService } from './video-producer.service';
import { Video, VideoStatus } from './entities/video.entity';

/** Result of pre-registering a draft + issuing its presigned upload URL. */
export interface CreateDraftResult {
  id: string;
  upload_url: string;
  object_key: string;
  status: VideoStatus;
}

/** Result of confirming an upload. */
export interface ConfirmUploadResult {
  id: string;
  status: VideoStatus;
}

/** Statuses for which a confirm is idempotent — the job was already published. */
const ALREADY_PROCESSED_STATUSES: ReadonlySet<VideoStatus> = new Set([
  VideoStatus.QUEUED,
  VideoStatus.PROCESSING,
  VideoStatus.READY,
  VideoStatus.FAILED,
]);

/** Builds the storage key for a video's source object (TD-05). */
export function sourceObjectKey(videoId: string): string {
  return `videos/${videoId}/source`;
}

/** Builds the storage key for a video's generated thumbnail (TD-04). */
export function thumbnailObjectKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly videoProducer: VideoProducerService,
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

  /**
   * Confirms that the client finished uploading the source object: validates
   * ownership and object presence, persists the real size/content-type from
   * storage, transitions `draft → uploaded → queued`, and publishes the
   * `process-video` job (TD-03). The file never passes through the API.
   *
   * Idempotent: re-confirming a video that is already `queued`/`processing`/
   * `ready`/`failed` returns its current status without enqueuing a second job.
   */
  async confirmUpload(
    userId: string,
    videoId: string,
  ): Promise<ConfirmUploadResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelRepository.findOneBy({
      user_id: userId,
    });
    if (!channel || channel.id !== video.channel_id) {
      throw new ForbiddenVideoAccessException();
    }

    if (ALREADY_PROCESSED_STATUSES.has(video.status)) {
      return { id: video.id, status: video.status };
    }

    const objectKey = video.object_key;
    if (!objectKey || !(await this.storageService.objectExists(objectKey))) {
      throw new UploadNotConfirmedException();
    }

    const metadata = await this.storageService.headObject(objectKey);
    if (metadata.size_bytes > this.config.maxUploadBytes) {
      throw new FileTooLargeException(this.config.maxUploadBytes);
    }

    video.size_bytes = String(metadata.size_bytes);
    if (metadata.content_type) {
      video.content_type = metadata.content_type;
    }
    video.status = VideoStatus.UPLOADED;
    await this.videoRepository.save(video);

    // Enqueue while still `uploaded` so a publish failure leaves the video
    // re-confirmable rather than stuck in `queued` with no job.
    await this.videoProducer.enqueueProcessing(video.id, objectKey);

    video.status = VideoStatus.QUEUED;
    await this.videoRepository.save(video);

    return { id: video.id, status: video.status };
  }

  /**
   * Public read of a video's status and metadata (SI-03.6). Returns only
   * safe-to-expose fields — internal storage keys are never leaked. When a
   * thumbnail has been generated, a short-lived presigned GET URL is issued
   * (TD-06); `duration_seconds`/`thumbnail_url` are omitted until present.
   */
  async getById(videoId: string): Promise<VideoResponseDto> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const response: VideoResponseDto = {
      id: video.id,
      status: video.status,
      title: video.title,
      created_at: video.created_at.toISOString(),
    };

    if (video.duration_seconds !== null) {
      response.duration_seconds = video.duration_seconds;
    }

    if (video.thumbnail_key) {
      response.thumbnail_url =
        await this.storageService.getPresignedDownloadUrl(video.thumbnail_key);
    }

    return response;
  }
}
