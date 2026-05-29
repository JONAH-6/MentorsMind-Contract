import { decodeCursor, encodeCursor } from '../src/utils/pagination.utils';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_DATE = '2024-01-01T00:00:00.000Z';

function encode(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

describe('decodeCursor', () => {
  it('returns decoded cursor for valid input', () => {
    const cursor = encode({ id: VALID_UUID, created_at: VALID_DATE });
    const result = decodeCursor(cursor);
    expect(result).toEqual({ id: VALID_UUID, created_at: VALID_DATE });
  });

  it('returns null when cursor exceeds 500 characters', () => {
    const long = 'a'.repeat(501);
    expect(decodeCursor(long)).toBeNull();
  });

  it('returns null for non-base64 input', () => {
    expect(decodeCursor('not valid base64!!!')).toBeNull();
  });

  it('returns null when id is not a valid UUID', () => {
    const cursor = encode({ id: "'; DROP TABLE bookings; --", created_at: VALID_DATE });
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('returns null when created_at is not a valid date', () => {
    const cursor = encode({ id: VALID_UUID, created_at: 'not-a-date' });
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('returns null when id field is missing', () => {
    const cursor = encode({ created_at: VALID_DATE });
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('returns null when created_at field is missing', () => {
    const cursor = encode({ id: VALID_UUID });
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    const cursor = Buffer.from('"just a string"').toString('base64');
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('roundtrips with encodeCursor', () => {
    const encoded = encodeCursor(VALID_UUID, VALID_DATE);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ id: VALID_UUID, created_at: VALID_DATE });
  });
});
