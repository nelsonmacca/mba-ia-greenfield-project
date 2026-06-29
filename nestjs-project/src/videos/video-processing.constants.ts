/** BullMQ queue that carries video-processing jobs (TD-03). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

/** Job name published on upload confirmation; consumed by the worker (SI-03.5). */
export const PROCESS_VIDEO_JOB = 'process-video' as const;

/**
 * Job payload — only the video id and its source object key, never the file
 * bytes (TD-03). The worker loads the record and reads the object by these.
 */
export interface ProcessVideoJobData {
  videoId: string;
  objectKey: string;
}
