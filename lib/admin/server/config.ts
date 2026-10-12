import { UploadContractError } from '@/lib/admin/upload-errors';

type Environment = NodeJS.ProcessEnv;

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
}

export interface AuthentikConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

function required(
  env: Environment,
  integration: string,
  names: readonly string[],
): Record<string, string> {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new UploadContractError(
      503,
      'BACKEND_NOT_CONFIGURED',
      `${integration} is not configured (${missing.join(', ')})`,
    );
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!.trim()]));
}

function httpUrl(value: string, name: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new UploadContractError(
      503,
      'BACKEND_NOT_CONFIGURED',
      `${name} must be a valid HTTP(S) URL`,
    );
  }
}

export function getMinioConfig(env: Environment = process.env): MinioConfig {
  const values = required(env, 'MinIO', [
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
  ]);
  return {
    endpoint: httpUrl(values.MINIO_ENDPOINT, 'MINIO_ENDPOINT'),
    accessKey: values.MINIO_ACCESS_KEY,
    secretKey: values.MINIO_SECRET_KEY,
    region: env.MINIO_REGION?.trim() || 'us-east-1',
  };
}

// Collections are not configured here: they are routed per ingest line by
// qdrantCollectionForSourceKey(). QDRANT_COLLECTION is no longer read.
export function getQdrantConfig(env: Environment = process.env): QdrantConfig {
  const values = required(env, 'Qdrant', ['QDRANT_URL']);
  return {
    url: httpUrl(values.QDRANT_URL, 'QDRANT_URL'),
    apiKey: env.QDRANT_API_KEY?.trim() || undefined,
  };
}

export function tryGetQdrantConfig(
  env: Environment = process.env,
): QdrantConfig | null {
  if (!env.QDRANT_URL?.trim()) return null;
  return getQdrantConfig(env);
}

/**
 * The issuer is kept exactly as configured. Authentik's per-provider issuer
 * ends in a slash (`.../application/o/<slug>/`), and it is compared as an
 * exact string with the discovery document and every ID token's `iss`, so
 * the slash must not be normalised away as httpUrl() does for other URLs.
 * A provider issuer configured without it is refused here, by name, rather
 * than surfacing later as an issuer mismatch at sign-in and revalidation.
 */
function issuerUrl(value: string, name: string): string {
  httpUrl(value, name);
  if (/^\/application\/o\/[^/]+$/.test(new URL(value).pathname)) {
    throw new UploadContractError(
      503,
      'BACKEND_NOT_CONFIGURED',
      `${name} must end with "/" (Authentik provider issuers do)`,
    );
  }
  return value;
}

/**
 * OIDC Discovery 1.0 §4: the issuer without any trailing slash, followed by
 * `/.well-known/openid-configuration`.
 */
export function oidcDiscoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

export function getAuthentikConfig(
  env: Environment = process.env,
): AuthentikConfig {
  const values = required(env, 'Authentik', [
    'AUTH_SECRET',
    'AUTHENTIK_ISSUER',
    'AUTHENTIK_CLIENT_ID',
    'AUTHENTIK_CLIENT_SECRET',
  ]);
  return {
    issuer: issuerUrl(values.AUTHENTIK_ISSUER, 'AUTHENTIK_ISSUER'),
    clientId: values.AUTHENTIK_CLIENT_ID,
    clientSecret: values.AUTHENTIK_CLIENT_SECRET,
  };
}

export function tryGetAuthentikConfig(
  env: Environment = process.env,
): AuthentikConfig | null {
  const configured = [
    env.AUTH_SECRET,
    env.AUTHENTIK_ISSUER,
    env.AUTHENTIK_CLIENT_ID,
    env.AUTHENTIK_CLIENT_SECRET,
  ].some((value) => Boolean(value?.trim()));
  return configured ? getAuthentikConfig(env) : null;
}
