import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';

/**
 * Thin wrapper over the FFmpeg/ffprobe **system binaries** (installed in the
 * worker image — TD-04). `fluent-ffmpeg` bundles no binary; it only shells out.
 * Optional env overrides for the binary paths support non-PATH installs.
 */
@Injectable()
export class FfmpegService {
  constructor() {
    if (process.env.FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
    }
    if (process.env.FFPROBE_PATH) {
      ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
    }
  }

  /**
   * Reads the media duration in seconds (rounded) via ffprobe. Throws if
   * ffprobe fails or the file carries no readable duration (corrupt input).
   */
  async probeDurationSeconds(filePath: string): Promise<number> {
    const metadata = await new Promise<ffmpeg.FfprobeData>(
      (resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          resolve(data);
        });
      },
    );

    const rawDuration =
      metadata.format?.duration ??
      metadata.streams?.find((s) => s.codec_type === 'video')?.duration;
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Could not read a valid duration from the media');
    }
    return Math.round(duration);
  }

  /**
   * Extracts a single thumbnail frame to `outDir/filename`. Resolves once the
   * file is written. Frame taken at ~50% of the video.
   */
  async generateThumbnail(
    filePath: string,
    outDir: string,
    filename: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          count: 1,
          timestamps: ['50%'],
          folder: outDir,
          filename,
          size: '640x?',
        });
    });
  }
}
