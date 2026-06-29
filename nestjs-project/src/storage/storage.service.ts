import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT } from './storage.constants';

/** Metadata returned by a successful HeadObject (the subset the app uses). */
export interface ObjectMetadata {
  size_bytes: number;
  content_type: string | null;
}

/** Options for a presigned download (GET) URL. */
export interface PresignedDownloadOptions {
  /** Overrides the response `Content-Disposition` header (e.g. attachment). */
  contentDisposition?: string;
  /** TTL in seconds; defaults to the configured download TTL. */
  expiresIn?: number;
}

/**
 * Thin abstraction over the S3-compatible storage (MinIO dev / S3 prod — TD-02).
 *
 * The API never streams file bytes (TD-01/TD-06): it only issues presigned URLs
 * that the client uses to talk to storage directly, and inspects object
 * metadata via HeadObject.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT)
    private readonly client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Presigned PUT URL for a direct client→storage upload. The client must send
   * the same `Content-Type` it asserted here so the signature matches.
   */
  async getPresignedUploadUrl(
    key: string,
    contentType: string,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, {
      expiresIn: this.config.uploadUrlTtl,
      signableHeaders: new Set(['content-type']),
    });
  }

  /** Presigned GET URL for streaming/download; storage honours HTTP Range. */
  async getPresignedDownloadUrl(
    key: string,
    options: PresignedDownloadOptions = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ...(options.contentDisposition && {
        ResponseContentDisposition: options.contentDisposition,
      }),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresIn ?? this.config.downloadUrlTtl,
    });
  }

  /** Reads object metadata; throws if the object does not exist. */
  async headObject(key: string): Promise<ObjectMetadata> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return {
      size_bytes: response.ContentLength ?? 0,
      content_type: response.ContentType ?? null,
    };
  }

  /** Returns true when the object is present in the bucket. */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.headObject(key);
      return true;
    } catch (err) {
      if (this.isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Streams an object's bytes to a local file (worker-side; the API never does
   * this — TD-01/TD-06). Used by the video worker to read the source for
   * FFmpeg/ffprobe without loading the whole object into memory.
   */
  async downloadToFile(key: string, destPath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    const body = response.Body as Readable | undefined;
    if (!body) {
      throw new Error(`Empty body for object ${key}`);
    }
    await pipeline(body, createWriteStream(destPath));
  }

  /** Uploads a local file to the given key (worker-side; e.g. the thumbnail). */
  async uploadFile(
    key: string,
    srcPath: string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(srcPath),
        ContentType: contentType,
        // S3/MinIO need a known length for stream bodies; read once for the cap.
        ContentLength: (await readFile(srcPath)).byteLength,
      }),
    );
  }

  private isNotFound(err: unknown): boolean {
    const e = err as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
  }
}
