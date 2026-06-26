import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateVideoDto } from './dto/create-video.dto';
import type { ConfirmUploadResult, CreateDraftResult } from './videos.service';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and get a presigned upload URL',
    description:
      "Pre-registers a draft video for the authenticated user's channel and " +
      'returns a presigned PUT URL. The client uploads the file bytes directly ' +
      'to object storage — the file never passes through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and presigned upload URL issued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        upload_url: { type: 'string' },
        object_key: { type: 'string' },
        status: { type: 'string', example: 'draft' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or file exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Confirm an upload and queue processing',
    description:
      'Confirms the client finished uploading the source object, validates ' +
      'ownership and object presence, transitions the video to queued, and ' +
      'publishes the processing job. Idempotent for already-queued videos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload confirmed and processing job published',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'queued' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'The video does not belong to the authenticated user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'No uploaded object found for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async confirm(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConfirmUploadResult> {
    return this.videosService.confirmUpload(user.sub, id);
  }
}
