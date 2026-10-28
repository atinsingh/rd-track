import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  /** 32-byte key (base64) for encrypting TOTP secrets at rest. */
  appEncryptionKey: Buffer;
  /** Ed25519 key that signs policies delivered to agents. */
  policySigningKey: { keyId: string; privateKey: KeyObject; publicKeyB64: string };
  mfaRequiredForAdmins: boolean;
  sessionTtlHours: number;
  cookieSecure: boolean;
  /** Login / MFA attempts per IP per minute. */
  authRateLimitPerMinute: number;
  storage: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    /** Public base URL for presigned URLs when the API reaches storage on a private hostname. */
    publicEndpoint?: string;
  };
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function signingKey(env: Config['env']): Config['policySigningKey'] {
  const pem = process.env.POLICY_SIGNING_KEY_PEM;
  let privateKey: KeyObject;
  if (pem) {
    privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  } else if (env === 'production') {
    throw new Error('POLICY_SIGNING_KEY_PEM is required in production');
  } else {
    // Development/test: an ephemeral key. Agents pin the key returned at enrollment.
    privateKey = generateKeyPairSync('ed25519').privateKey;
  }
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  // The last 32 bytes of an Ed25519 SPKI DER are the raw public key.
  const publicKeyB64 = Buffer.from(raw.subarray(raw.length - 32)).toString('base64');
  return { keyId: process.env.POLICY_SIGNING_KEY_ID ?? 'dev-1', privateKey, publicKeyB64 };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV as Config['env']) ?? 'development';
  const keyB64 =
    process.env.APP_ENCRYPTION_KEY ?? (env === 'production' ? undefined : Buffer.alloc(32, 7).toString('base64'));
  if (!keyB64) throw new Error('APP_ENCRYPTION_KEY is required in production');
  const appEncryptionKey = Buffer.from(keyB64, 'base64');
  if (appEncryptionKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');

  return {
    env,
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: required('DATABASE_URL', env === 'production' ? undefined : 'postgres://rd:rd@localhost:5432/rd_track'),
    appEncryptionKey,
    policySigningKey: signingKey(env),
    mfaRequiredForAdmins: (process.env.MFA_REQUIRED_FOR_ADMINS ?? 'true') !== 'false',
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    cookieSecure: env === 'production',
    authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 10),
    storage: {
      bucket: process.env.S3_BUCKET ?? 'rd-track-dev',
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? (process.env.S3_ENDPOINT ? 'true' : 'false')) === 'true',
      publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
    },
    ...overrides,
  };
}
