import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shape for the playback/download endpoints (SI-03.7).
 *
 * Carries a short-lived presigned GET URL pointing directly at object storage
 * (TD-06). The client/`<video>` element fetches bytes from storage — which
 * honours HTTP Range for streaming/seeking — so the API never proxies bytes.
 */
export class VideoUrlResponseDto {
  @ApiProperty({
    type: String,
    description:
      'Short-lived presigned GET URL for the video source object in storage.',
  })
  url: string;
}
