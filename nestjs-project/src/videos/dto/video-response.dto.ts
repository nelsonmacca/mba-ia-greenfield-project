import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

/**
 * Public read shape for a video (SI-03.6).
 *
 * Only safe-to-expose fields are returned — internal storage keys
 * (`object_key`/`thumbnail_key`) and processing internals are never leaked.
 * `duration_seconds` and `thumbnail_url` are present only once processing has
 * produced them (status `ready`); they are omitted otherwise.
 */
export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ type: String, nullable: true })
  title: string | null;

  @ApiProperty({
    type: Number,
    required: false,
    description: 'Extracted by the worker; present once the video is ready.',
  })
  duration_seconds?: number;

  @ApiProperty({
    type: String,
    required: false,
    description:
      'Short-lived presigned GET URL for the generated thumbnail; present ' +
      'once the video has been processed.',
  })
  thumbnail_url?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: string;
}
