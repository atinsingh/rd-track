import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
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

/**
 * Development-only store: files on disk, presigned URLs served by the API itself at
 * `/v1/_storage/<key>?method&exp&sig` (HMAC-SHA256). Lets the real agent upload
 * without S3/MinIO. Never enable in production.
 */
export class LocalObjectStore implements ObjectStore {
  constructor(
    private readonly dir: string,
    private readonly baseUrl: string,
    private readonly secret: Buffer,
  ) {}

  private path(key: string) {
    const p = normalize(join(this.dir, key));
    if (!p.startsWith(normalize(this.dir))) throw new Error('invalid key');
    return p;
  }

  sign(method: string, key: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${method}\n${key}\n${exp}`).digest('hex');
  }

  verify(method: string, key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(method, key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private url(method: string, key: string, expiresInSec: number) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    return `${this.baseUrl}/v1/_storage/${encodeURIComponent(key)}?method=${method}&exp=${exp}&sig=${this.sign(method, key, exp)}`;
  }

  async presignPut(key: string, contentType: string, expiresInSec: number) {
    return { url: this.url('PUT', key, expiresInSec), headers: { 'content-type': contentType } };
  }
  async presignGet(key: string, expiresInSec: number) {
    return this.url('GET', key, expiresInSec);
  }
  async head(key: string) {
    try {
      return { size: (await stat(this.path(key))).size };
    } catch {
      return null;
    }
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
  async put(key: string, body: Buffer | string, _contentType?: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}
