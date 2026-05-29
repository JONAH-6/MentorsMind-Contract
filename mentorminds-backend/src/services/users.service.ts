import { pool } from '../config/database';
import * as EncryptionUtil from '../utils/encryption.utils';

export interface UserPrivate {
  id: string;
  email: string;
  phone_number: string | null;
  address: string | null;
  date_of_birth: string | null;
  national_id: string | null;
  created_at: Date;
}

/**
 * Maps a raw DB row to UserPrivate, safely decrypting PII fields.
 * If any encrypted field is corrupted, it is returned as null rather than
 * crashing the request — preventing a single bad row from locking a user out.
 */
function mapPrivateRow(row: Record<string, unknown>): UserPrivate {
  return {
    id: row.id as string,
    email: row.email as string,
    phone_number: EncryptionUtil.decryptSafe(row.phone_number_encrypted as string | null),
    address: EncryptionUtil.decryptSafe(row.address_encrypted as string | null),
    date_of_birth: EncryptionUtil.decryptSafe(row.date_of_birth_encrypted as string | null),
    national_id: EncryptionUtil.decryptSafe(row.national_id_encrypted as string | null),
    created_at: row.created_at as Date,
  };
}

export interface UserUpdatePayload {
  phoneNumber?: string;
  address?: string;
  dateOfBirth?: string;
  nationalId?: string;
}

export class UsersService {
  async findById(id: string): Promise<UserPrivate | null> {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id = $1 LIMIT 1',
      [id]
    );
    if (rows.length === 0) return null;
    return mapPrivateRow(rows[0]);
  }

  async update(id: string, payload: UserUpdatePayload): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    // Fetch keyset once — avoids N sequential secret-resolution calls for N PII fields
    const keyset = await EncryptionUtil.getKeyset();

    if (payload.phoneNumber !== undefined) {
      fields.push(`phone_number_encrypted = $${idx++}`);
      values.push(EncryptionUtil.encryptWithKeyset(payload.phoneNumber, keyset));
    }
    if (payload.address !== undefined) {
      fields.push(`address_encrypted = $${idx++}`);
      values.push(EncryptionUtil.encryptWithKeyset(payload.address, keyset));
    }
    if (payload.dateOfBirth !== undefined) {
      fields.push(`date_of_birth_encrypted = $${idx++}`);
      values.push(EncryptionUtil.encryptWithKeyset(payload.dateOfBirth, keyset));
    }
    if (payload.nationalId !== undefined) {
      fields.push(`national_id_encrypted = $${idx++}`);
      values.push(EncryptionUtil.encryptWithKeyset(payload.nationalId, keyset));
    }

    if (fields.length === 0) return;

    values.push(id);
    await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  }
}

export const usersService = new UsersService();
