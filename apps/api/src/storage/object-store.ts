import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config';

/**
 * Private object storage for screenshots (`screenshots/…`) and exports (`exports/…`).
 * Bytes never pass through the API for uploads/downloads by users or agents:
 * they get short-lived, single-object presigned URLs (SCR-07, SCR-11).
 */
export interface ObjectStore {
  presignPut(key: string, contentType: string, expiresInSec: number): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, expiresInSec: number, downloadName?: string): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly cfg: Config['storage']) {
    const base = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    // Presigned URLs must use the hostname clients can reach.
    this.signer = new S3Client({ ...base, endpoint: cfg.publicEndpoint ?? cfg.endpoint });
  }

  async presignPut(key: string, contentType: string, expiresInSec: number) {
    const cmd = new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, ContentType: contentType });
    const url = await getSignedUrl(this.signer, cmd, { expiresIn: expiresInSec });
    return { url, headers: { 'content-type': contentType } };
  }

  async presignGet(key: string, expiresInSec: number, downloadName?: string) {
    const cmd = new GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined,
    });
    return getSignedUrl(this.signer, cmd, { expiresIn: expiresInSec });
  }

  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer | string, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

/** In-memory store for tests and local runs without MinIO. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async presignPut(key: string, contentType: string, expiresInSec: number) {
    return { url: `memory://put/${encodeURIComponent(key)}?expires=${expiresInSec}`, headers: { 'content-type': contentType } };
  }
  async presignGet(key: string, expiresInSec: number) {
    return `memory://get/${encodeURIComponent(key)}?expires=${expiresInSec}`;
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length } : null;
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  async put(key: string, body: Buffer | string, contentType: string) {
    this.objects.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
