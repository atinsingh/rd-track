import type { Config } from '../config';
import { LocalObjectStore, MemoryObjectStore, S3ObjectStore, type ObjectStore } from './object-store';

/** STORAGE=s3 (default) | local (dev: files + API-served signed URLs) | memory (tests). */
export function createObjectStore(config: Config): ObjectStore {
  const kind = process.env.STORAGE ?? 's3';
  if (kind === 'memory') return new MemoryObjectStore();
  if (kind === 'local') {
    if (config.env === 'production') throw new Error('STORAGE=local is for development only');
    return new LocalObjectStore(
      process.env.LOCAL_STORAGE_DIR ?? '.local-storage',
      process.env.PUBLIC_API_URL ?? `http://localhost:${config.port}`,
      config.appEncryptionKey,
    );
  }
  return new S3ObjectStore(config.storage);
}
