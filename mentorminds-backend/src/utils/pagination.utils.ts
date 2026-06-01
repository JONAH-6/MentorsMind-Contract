/** Maximum allowed cursor string length to prevent oversized payloads. */
const MAX_CURSOR_LENGTH = 500;

/** Base64 token pattern to reject invalid cursor encodings. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** UUID v4 pattern (case-insensitive). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict ISO 8601 UTC date format, matching the encoded cursor output. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  const trimmed = cursor.trim();

  // 1. Length check
  if (trimmed.length > MAX_CURSOR_LENGTH) {
    return null;
  }

  // 2. Validate base64 encoding strictly before decoding.
  if (!BASE64_PATTERN.test(trimmed)) {
    return null;
  }

  // 3. Decode base64
  let json: string;
  try {
    json = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    return null;
  }

  // 4. Parse JSON
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

  // 5. Strict ISO 8601 UTC date validation for created_at
  if (!ISO_DATE_PATTERN.test(obj.created_at)) {
    return null;
  }

  const createdAt = new Date(obj.created_at);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== obj.created_at) {
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
