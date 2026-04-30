import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface KeyVersion {
  version: string;
  key: Buffer;
}

export interface Keyset {
  currentVersion: string;
  keys: Record<string, Buffer>;
}

interface CachedKeyset {
  keyset: Keyset;
  cachedAt: number;
}

let cache: CachedKeyset | null = null;

/**
 * Loads the keyset from the environment (or AWS Secrets Manager in production).
 * Parses PII_ENCRYPTION_KEYS as JSON: { "v1": "<hex>", "v2": "<hex>", ... }
 * and PII_ENCRYPTION_CURRENT_VERSION as the active version string.
 */
function loadKeysetFromEnv(): Keyset {
  const raw = process.env.PII_ENCRYPTION_KEYS;
  if (!raw) throw new Error('PII_ENCRYPTION_KEYS is not set');

  const currentVersion = process.env.PII_ENCRYPTION_CURRENT_VERSION;
  if (!currentVersion) throw new Error('PII_ENCRYPTION_CURRENT_VERSION is not set');

  const parsed: Record<string, string> = JSON.parse(raw);
  const keys: Record<string, Buffer> = {};
  for (const [ver, hex] of Object.entries(parsed)) {
    keys[ver] = Buffer.from(hex, 'hex');
  }

  if (!keys[currentVersion]) {
    throw new Error(`Current version "${currentVersion}" not found in PII_ENCRYPTION_KEYS`);
  }

  return { currentVersion, keys };
}

/**
 * Returns the keyset, refreshing from source if the cache is older than 5 minutes.
 * Pass forceRefresh=true to bypass the TTL (e.g. after a key rotation).
 */
export async function getKeyset(forceRefresh = false): Promise<Keyset> {
  const now = Date.now();
  if (!forceRefresh && cache && now - cache.cachedAt < CACHE_TTL_MS) {
    return cache.keyset;
  }

  const keyset = loadKeysetFromEnv();
  cache = { keyset, cachedAt: now };
  return keyset;
}

/** Clears the in-memory keyset cache, forcing the next call to reload. */
export function clearCache(): void {
  cache = null;
}

/**
 * Logs the current key version at startup so operators can confirm
 * which key is active without exposing the key material itself.
 */
export async function logKeysetVersion(): Promise<void> {
  const keyset = await getKeyset();
  console.info('[EncryptionUtil] Encryption keyset loaded', { version: keyset.currentVersion });
}

/**
 * Encrypts a plaintext string using the current key version.
 * Returns a compact string: "<version>:<ivHex>:<authTagHex>:<ciphertextHex>"
 */
export async function encrypt(plaintext: string): Promise<string> {
  const keyset = await getKeyset();
  return encryptWithKeyset(plaintext, keyset);
}

/**
 * Encrypts using a pre-fetched keyset — avoids repeated getKeyset() calls
 * when encrypting multiple fields in a single request.
 */
export function encryptWithKeyset(plaintext: string, keyset: Keyset): string {
  const key = keyset.keys[keyset.currentVersion];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${keyset.currentVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value produced by `encrypt`.
 * Automatically selects the correct key version from the keyset,
 * so old ciphertexts remain readable after a key rotation.
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const parts = ciphertext.split(':');
  if (parts.length !== 4) throw new Error('Invalid ciphertext format');
  const [version, ivHex, authTagHex, dataHex] = parts;

  const keyset = await getKeyset();
  const key = keyset.keys[version];
  if (!key) throw new Error(`Unknown key version: ${version}`);

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(authTag);
  return decipher.update(data) + decipher.final('utf8');
}
