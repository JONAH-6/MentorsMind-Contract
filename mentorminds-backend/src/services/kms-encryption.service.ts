/**
 * KmsEncryptionService
 *
 * Encryption backend for custodial wallet secrets.
 *
 * When AWS_KMS_KEY_ID is set, all encrypt/decrypt operations go through
 * AWS KMS — the plaintext secret never touches application memory beyond
 * the immediate call. When the env var is absent (local dev / CI), a
 * symmetric AES-256-GCM cipher keyed from WALLET_ENCRYPTION_KEY is used
 * as a fallback.
 *
 * Security review sign-off required before enabling custodial mode in
 * production. See docs/CUSTODIAL_WALLET_DESIGN.md.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const KMS_KEY_ID = process.env.AWS_KMS_KEY_ID;
const LOCAL_KEY_HEX = process.env.WALLET_ENCRYPTION_KEY ?? '';

// ---------------------------------------------------------------------------
// AWS KMS path (production)
// ---------------------------------------------------------------------------

async function kmsEncrypt(plaintext: string): Promise<string> {
  // Dynamic import so the package is optional in environments without AWS SDK.
  const { KMSClient, EncryptCommand } = await import('@aws-sdk/client-kms');
  const client = new KMSClient({});
  const { CiphertextBlob } = await client.send(
    new EncryptCommand({
      KeyId: KMS_KEY_ID!,
      Plaintext: Buffer.from(plaintext, 'utf8'),
    })
  );
  if (!CiphertextBlob) throw new Error('KMS encrypt returned no ciphertext');
  return Buffer.from(CiphertextBlob).toString('base64');
}

async function kmsDecrypt(ciphertextBase64: string): Promise<string> {
  const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms');
  const client = new KMSClient({});
  const { Plaintext } = await client.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertextBase64, 'base64'),
    })
  );
  if (!Plaintext) throw new Error('KMS decrypt returned no plaintext');
  return Buffer.from(Plaintext).toString('utf8');
}

// ---------------------------------------------------------------------------
// Local AES-256-GCM fallback (dev / CI only)
// ---------------------------------------------------------------------------

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function localEncrypt(plaintext: string): string {
  if (LOCAL_KEY_HEX.length !== 64) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY must be a 64-char hex string (32 bytes). ' +
      'Set AWS_KMS_KEY_ID for production use.'
    );
  }
  const key = Buffer.from(LOCAL_KEY_HEX, 'hex');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv || tag || ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function localDecrypt(encoded: string): string {
  if (LOCAL_KEY_HEX.length !== 64) {
    throw new Error('WALLET_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).');
  }
  const key = Buffer.from(LOCAL_KEY_HEX, 'hex');
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function encryptSecret(plaintext: string): Promise<string> {
  return KMS_KEY_ID ? kmsEncrypt(plaintext) : localEncrypt(plaintext);
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  return KMS_KEY_ID ? kmsDecrypt(ciphertext) : localDecrypt(ciphertext);
}

/**
 * Re-encrypt a secret under the current key.
 * Call this during key rotation: decrypt with the old key, re-encrypt with
 * the new key, then persist the new ciphertext.
 */
export async function reEncryptSecret(
  oldCiphertext: string,
  decryptFn: (c: string) => Promise<string> = decryptSecret,
  encryptFn: (p: string) => Promise<string> = encryptSecret
): Promise<string> {
  const plaintext = await decryptFn(oldCiphertext);
  return encryptFn(plaintext);
}
