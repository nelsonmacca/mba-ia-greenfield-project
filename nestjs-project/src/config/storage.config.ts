import { registerAs } from '@nestjs/config';

// 10 GB — the maximum source video size accepted at upload (TD-01).
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

export default registerAs('storage', () => ({
  // MinIO/S3 endpoint. In Docker this is the Compose service name, never localhost.
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  // Required for MinIO: use path-style (endpoint/bucket/key) addressing.
  forcePathStyle:
    (process.env.STORAGE_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true',
  // Presigned-URL TTLs (seconds).
  uploadUrlTtl: parseInt(process.env.STORAGE_UPLOAD_URL_TTL || '900', 10),
  downloadUrlTtl: parseInt(process.env.STORAGE_DOWNLOAD_URL_TTL || '3600', 10),
  // Hard cap on the source object size (bytes).
  maxUploadBytes: parseInt(
    process.env.STORAGE_MAX_UPLOAD_BYTES || `${DEFAULT_MAX_UPLOAD_BYTES}`,
    10,
  ),
}));
