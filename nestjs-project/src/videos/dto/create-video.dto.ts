import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateVideoDto {
  /** Original file name of the video being uploaded. */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** MIME type of the source object (client-asserted; re-validated on confirm). */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /** Source object size in bytes (client-asserted; re-validated on confirm). */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
