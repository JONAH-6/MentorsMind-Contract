# SorobanEscrowService - Escrow ID Fix Implementation

## Problem Statement

The original implementation passed `bookingId` directly as the first contract argument (escrow ID) in the `create_escrow` contract invocation. This created a **1:1 coupling** between bookings and escrows at the contract level, causing the following issues:

1. **Re-escrow Failure**: If a booking needed to be re-escrowed (e.g., after a failed first attempt), the contract would reject the call with a duplicate ID error.
2. **No Retry Mechanism**: Failed escrow creations could not be retried for the same booking.
3. **Inflexible Architecture**: Tied business logic (booking) too tightly to smart contract state (escrow).

## Solution

Implemented a **unique escrow ID generation strategy** that:

✅ Generates globally unique escrow IDs using UUID  
✅ Maintains traceability to the original booking  
✅ Supports retry scenarios with different IDs  
✅ Allows custom escrow IDs when needed  
✅ Prevents duplicate ID errors on re-escrow  

## Implementation Details

### 1. Unique ID Generation Strategy

```typescript
private generateEscrowId(bookingId: string, customId?: string): string {
  if (customId) {
    return customId;
  }
  // Format: {bookingId}-{uuid} to maintain traceability while ensuring uniqueness
  return `${bookingId}-${randomUUID()}`;
}
```

**Example Output:**
- `booking-12345-550e8400-e29b-41d4-a716-446655440000`
- `booking-12345-6ba7b810-9dad-11d1-80b4-00c04fd430c8` (retry)

### 2. CreateEscrow Method

```typescript
async createEscrow(input: CreateEscrowInput): Promise<EscrowResult> {
  // Generate unique escrow ID to prevent duplicate ID errors on re-escrow
  const escrowId = this.generateEscrowId(input.bookingId, input.escrowId);

  // Call Soroban contract with proper escrow ID as first argument
  const operation = this.contract.call(
    'create_escrow',
    nativeToScVal(escrowId, { type: 'string' }),  // ✅ Unique escrow ID
    nativeToScVal(input.learnerId, { type: 'string' }),
    nativeToScVal(input.mentorId, { type: 'string' }),
    nativeToScVal(input.amount, { type: 'i128' }),
    nativeToScVal(input.currency, { type: 'string' })
  );
  
  // ... transaction handling
}
```

### 3. TypeScript Interfaces

```typescript
export interface CreateEscrowInput {
  bookingId: string;       // Original booking reference
  learnerId: string;       // Learner identifier
  mentorId: string;        // Mentor identifier
  amount: string;          // Amount in stroops
  currency: string;        // Currency code (e.g., USDC, XLM)
  escrowId?: string;       // Optional: custom escrow ID for special cases
}

export interface EscrowResult {
  escrowId: string;        // Unique escrow identifier
  transactionHash: string; // Blockchain transaction hash
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
}
```

## Key Features

### ✅ Automatic Unique ID Generation
Every escrow creation gets a unique ID automatically, even for the same booking.

### ✅ Retry Support
Failed escrow attempts can be retried without duplicate ID errors:

```typescript
// First attempt (fails)
try {
  await escrowService.createEscrow({ bookingId: 'booking-123', ... });
} catch (error) {
  // Retry with NEW unique ID - no conflict!
  await escrowService.createEscrow({ bookingId: 'booking-123', ... });
}
```

### ✅ Traceability
Escrow IDs contain the booking ID for easy tracing:
```
booking-12345-{uuid}
```

### ✅ Custom ID Support
For special scenarios, you can provide a custom escrow ID:

```typescript
await escrowService.createEscrow({
  bookingId: 'booking-456',
  escrowId: 'custom-escrow-2024-001', // Your custom ID
  ...
});
```

## Additional Methods

The service includes comprehensive escrow management:

- `createEscrow(input)` - Create new escrow with unique ID
- `getEscrowDetails(escrowId)` - Retrieve escrow information
- `releaseEscrow(escrowId)` - Release funds to mentor
- `cancelEscrow(escrowId)` - Cancel and refund to learner

## Testing

Run the test suite to verify the implementation:

```bash
npm test -- soroban-escrow.test.ts
```

**Test Coverage:**
- ✅ Unique ID generation for same booking
- ✅ Custom escrow ID usage
- ✅ Re-escrow capability
- ✅ Traceability verification
- ✅ UUID format validation

## Usage Example

```typescript
import { SorobanEscrowService, CreateEscrowInput } from './services/escrow.service';

const escrowService = new SorobanEscrowService(
  process.env.SOROBAN_CONTRACT_ID,
  process.env.SOROBAN_RPC_URL,
  process.env.ADMIN_SECRET_KEY
);

// Create escrow
const result = await escrowService.createEscrow({
  bookingId: 'booking-12345',
  learnerId: 'learner-abc',
  mentorId: 'mentor-xyz',
  amount: '1000000000',
  currency: 'USDC'
});

console.log(result.escrowId); 
// Output: booking-12345-550e8400-e29b-41d4-a716-446655440000
```

## Files Modified/Created

1. **`src/services/escrow.service.ts`** - Added `SorobanEscrowService` class with unique ID generation
2. **`tests/soroban-escrow.test.ts`** - Comprehensive test suite
3. **`src/examples/escrow-usage.example.ts`** - Usage examples and best practices

## Benefits

| Before | After |
|--------|-------|
| ❌ 1:1 booking-to-escrow coupling | ✅ N:M relationship supported |
| ❌ No retry on failure | ✅ Unlimited retries with unique IDs |
| ❌ Duplicate ID errors | ✅ Guaranteed uniqueness |
| ❌ No traceability | ✅ Booking ID embedded in escrow ID |
| ❌ Inflexible | ✅ Custom ID support when needed |

## Migration Notes

If you have existing code using the old pattern:

**Before:**
```typescript
// ❌ Old - uses bookingId directly
args: [input.bookingId, input.learnerId, ...]
```

**After:**
```typescript
// ✅ New - generates unique escrow ID
const escrowId = generateEscrowId(input.bookingId);
args: [escrowId, input.learnerId, ...]
```

## Contract Compatibility

The implementation assumes the Soroban contract accepts a `string` type for the escrow ID parameter. If your contract uses a different type (e.g., `bytes`, `u64`), adjust the `nativeToScVal` type accordingly:

```typescript
// For bytes type
nativeToScVal(escrowId, { type: 'bytes' })

// For u64 type (requires numeric ID)
nativeToScVal(escrowId, { type: 'u64' })
```

## Security Considerations

- ✅ Admin keypair required for all operations
- ✅ Transaction timeout set to 300 seconds
- ✅ Proper error handling for failed transactions
- ✅ Status verification after transaction submission

## Future Enhancements

- [ ] Add escrow ID collision detection (database layer)
- [ ] Implement escrow ID indexing for fast lookups
- [ ] Add retry logic with exponential backoff
- [ ] Support batch escrow creation
- [ ] Add event emissions for analytics
