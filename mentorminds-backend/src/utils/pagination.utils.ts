/** Maximum allowed cursor string length to prevent oversized payloads. */
const MAX_CURSOR_LENGTH = 500;

/** UUID v4 pattern (case-insensitive). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DecodedCursor {
  id: string;
  created_at: string;
}

/**
 * Safely decodes and validates a pagination cursor.
 *
 * Validation steps (all must pass):
 *  1. Length ≤ 500 characters — prevents oversized payloads.
 *  2. Valid base64 — rejects obviously malformed input.
 *  3. Valid JSON with `id` and `created_at` fields present.
 *  4. `id` matches UUID v4 format — blocks SQL injection via id field.
 *  5. `created_at` is a parseable ISO date — blocks injection via date field.
 *
 * Callers must always pass `id` and `created_at` as parameterized query
 * values, never interpolated directly into SQL strings.
 *
 * @returns Decoded cursor object, or `null` if validation fails.
 */
export function decodeCursor(cursor: string): DecodedCursor | null {
  // 1. Length check
  if (cursor.length > MAX_CURSOR_LENGTH) {
    return null;
  }

  // 2. Decode base64
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }

  // 3. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.id !== 'string' || typeof obj.created_at !== 'string') {
    return null;
  }

  // 4. UUID validation for id
  if (!UUID_PATTERN.test(obj.id)) {
    return null;
  }

  // 5. ISO date validation for created_at
  if (isNaN(Date.parse(obj.created_at))) {
    return null;
  }

  return { id: obj.id, created_at: obj.created_at };
}

/**
 * Encodes a cursor from id and created_at values.
 */
export function encodeCursor(id: string, created_at: string): string {
  return Buffer.from(JSON.stringify({ id, created_at })).toString('base64');
}
