import { Pool } from "pg";
import { CacheService } from "./cache.service";
import { encryptSecret, decryptSecret, reEncryptSecret } from "./kms-encryption.service";

/**
 * CUSTODIAL WALLET DESIGN — Security Review Required
 *
 * This service supports two wallet modes:
 *
 * 1. CUSTODIAL (default): The platform generates a Stellar keypair and stores
 *    the encrypted secret key in the `wallets.encrypted_secret_key` column.
 *    Encryption uses AWS KMS (production) or AES-256-GCM (dev fallback).
 *    Risk: if the DB + KMS are both compromised, user funds are at risk.
 *    Mitigation: KMS key policy, audit logging, key rotation (see rotateAllKeys).
 *
 * 2. NON-CUSTODIAL: The user provides their own public key. No secret is stored.
 *    The platform cannot sign on behalf of the user.
 *
 * The `encrypted_secret_key` column is NEVER returned in API responses.
 * All SELECT queries explicitly list columns and omit `encrypted_secret_key`.
 *
 * Security sign-off: required before enabling custodial mode in production.
 * See docs/CUSTODIAL_WALLET_DESIGN.md.
 */

export interface WalletRecord {
  id: string;
  userId: string;
  stellarPublicKey: string;
  /** true = platform holds the encrypted secret; false = user-owned key */
  custodial: boolean;
  createdAt: Date;
  updatedAt: Date;
  // encrypted_secret_key is intentionally absent — never exposed via this type
}

// Columns safe to return in API responses (no encrypted_secret_key)
const SAFE_COLUMNS = `
  id,
  user_id          AS "userId",
  stellar_public_key AS "stellarPublicKey",
  custodial,
  created_at       AS "createdAt",
  updated_at       AS "updatedAt"
`.trim();

const CACHE_TTL_MS = 45_000; // 45 seconds

function stellarKeyCache(publicKey: string): string {
  return `mm:wallet:by-stellar-key:${publicKey}`;
}

function userIdCacheKey(userId: string): string {
  return `mm:wallet:by-user-id:${userId}`;
}

export class WalletModel {
  constructor(
    private readonly pool: Pool,
    private readonly cache: CacheService
  ) {}

  async findByStellarPublicKey(publicKey: string): Promise<WalletRecord | null> {
    const cacheKey = stellarKeyCache(publicKey);
    const cached = this.cache.get<WalletRecord | null>(cacheKey);
    if (cached !== null) return cached;

    const result = await this.pool.query<WalletRecord>(
      `SELECT ${SAFE_COLUMNS} FROM wallets WHERE stellar_public_key = $1 LIMIT 1`,
      [publicKey]
    );

    const wallet = result.rows[0] ?? null;
    this.cache.set(cacheKey, wallet, CACHE_TTL_MS);
    return wallet;
  }

  async findByUserId(userId: string): Promise<WalletRecord | null> {
    const cacheKey = userIdCacheKey(userId);
    const cached = this.cache.get<WalletRecord | null>(cacheKey);
    if (cached !== null) return cached;

    const result = await this.pool.query<WalletRecord>(
      `SELECT ${SAFE_COLUMNS} FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    const wallet = result.rows[0] ?? null;
    this.cache.set(cacheKey, wallet, CACHE_TTL_MS);
    return wallet;
  }

  /**
   * Create a custodial wallet: platform generates the keypair and stores the
   * encrypted secret. The plaintext secret is never persisted.
   */
  async createCustodial(
    userId: string,
    publicKey: string,
    plaintextSecret: string
  ): Promise<WalletRecord> {
    const encryptedSecret = await encryptSecret(plaintextSecret);
    const result = await this.pool.query<WalletRecord>(
      `INSERT INTO wallets (user_id, stellar_public_key, encrypted_secret_key, custodial, created_at, updated_at)
       VALUES ($1, $2, $3, TRUE, NOW(), NOW())
       RETURNING ${SAFE_COLUMNS}`,
      [userId, publicKey, encryptedSecret]
    );
    this.cache.del(userIdCacheKey(userId));
    return result.rows[0];
  }

  /**
   * Create a non-custodial wallet: user provides their own public key.
   * No secret is stored — the platform cannot sign on behalf of the user.
   */
  async createNonCustodial(
    userId: string,
    publicKey: string
  ): Promise<WalletRecord> {
    const result = await this.pool.query<WalletRecord>(
      `INSERT INTO wallets (user_id, stellar_public_key, custodial, created_at, updated_at)
       VALUES ($1, $2, FALSE, NOW(), NOW())
       RETURNING ${SAFE_COLUMNS}`,
      [userId, publicKey]
    );
    this.cache.del(userIdCacheKey(userId));
    return result.rows[0];
  }

  /**
   * Retrieve the decrypted secret for a custodial wallet.
   * Only call this when signing a transaction on behalf of the user.
   * Never log or return the result to API callers.
   */
  async getDecryptedSecret(userId: string): Promise<string> {
    const result = await this.pool.query<{ encrypted_secret_key: string; custodial: boolean }>(
      `SELECT encrypted_secret_key, custodial FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Wallet not found for user ${userId}`);
    if (!row.custodial) throw new Error(`Wallet for user ${userId} is non-custodial — no secret stored`);
    if (!row.encrypted_secret_key) throw new Error(`No encrypted secret for user ${userId}`);
    return decryptSecret(row.encrypted_secret_key);
  }

  /**
   * Key rotation: re-encrypt all custodial secrets under the current KMS key.
   * Run this after rotating AWS_KMS_KEY_ID or WALLET_ENCRYPTION_KEY.
   * Processes wallets in batches to avoid memory pressure.
   */
  async rotateAllKeys(batchSize = 100): Promise<{ rotated: number; failed: number }> {
    let offset = 0;
    let rotated = 0;
    let failed = 0;

    while (true) {
      const { rows } = await this.pool.query<{ id: string; encrypted_secret_key: string }>(
        `SELECT id, encrypted_secret_key FROM wallets
         WHERE custodial = TRUE AND encrypted_secret_key IS NOT NULL
         ORDER BY id LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );

      if (rows.length === 0) break;

      for (const row of rows) {
        try {
          const newCiphertext = await reEncryptSecret(row.encrypted_secret_key);
          await this.pool.query(
            `UPDATE wallets SET encrypted_secret_key = $1, updated_at = NOW() WHERE id = $2`,
            [newCiphertext, row.id]
          );
          rotated++;
        } catch (err) {
          console.error(`[WalletModel] Key rotation failed for wallet ${row.id}:`, err);
          failed++;
        }
      }

      offset += batchSize;
    }

    console.log(`[WalletModel] Key rotation complete: ${rotated} rotated, ${failed} failed`);
    return { rotated, failed };
  }

  /**
   * Update a wallet's stellar_public_key and invalidate related cache entries.
   */
  async updateStellarPublicKey(
    walletId: string,
    newPublicKey: string
  ): Promise<WalletRecord | null> {
    const result = await this.pool.query<WalletRecord>(
      `UPDATE wallets SET stellar_public_key = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING ${SAFE_COLUMNS}`,
      [newPublicKey, walletId]
    );

    const updated = result.rows[0] ?? null;
    if (updated) {
      this.cache.del(stellarKeyCache(newPublicKey));
      this.cache.del(userIdCacheKey(updated.userId));
    }

    return updated;
  }
}
