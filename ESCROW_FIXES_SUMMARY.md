# Escrow Service Fixes Summary

This document summarizes the fixes applied to address issues #284-287 in the escrow service.

## Issue #287: Dispute Reason Length Validation

**Problem**: `openDispute` passed the reason string directly to the Soroban contract without length validation, potentially exceeding storage limits or transaction size limits.

**Fix Applied**:
- Added validation in `SorobanEscrowServiceImpl.openDispute()` to reject reasons longer than 500 characters
- Throws a 400 error with clear message: "Dispute reason must be 500 characters or less"
- Added validation in `EscrowApiService.openDispute()` as well for defense in depth

**Files Modified**:
- `mentorminds-backend/src/services/sorobanEscrow.service.ts`
- `mentorminds-backend/src/services/escrow-api.service.ts`

**Tests Added**:
- Test for rejection of 501+ character reasons
- Test for acceptance of exactly 500 character reasons

---

## Issue #286: Prevent Release from Pending Status

**Problem**: `releaseEscrow` allowed release when escrow status was 'pending', but pending escrows may not exist on-chain yet, causing contract rejection.

**Fix Applied**:
- Changed `EscrowApiService.releaseEscrow()` to only allow release from 'funded' status
- Removed 'pending' from allowed states for release operation
- Updated error message to be more explicit: "Cannot release escrow in {status} status. Escrow must be funded."

**Files Modified**:
- `mentorminds-backend/src/services/escrow-api.service.ts`

**Tests Updated**:
- Updated error message expectations in existing tests
- All state transition tests continue to pass with stricter validation

---

## Issue #285: Transaction Confirmation Before Status Update

**Problem**: `StellarSorobanClient.invoke()` returned immediately after `sendTransaction()` with PENDING status, treating unconfirmed transactions as complete.

**Fix Applied**:
- `StellarSorobanClient.invoke()` now calls `waitForTransaction()` after submission
- `waitForTransaction()` polls `getTransaction()` until status is SUCCESS or FAILED
- Default timeout of 30 seconds with 2-second polling interval
- Throws descriptive error if transaction fails or times out
- Only returns after ledger confirmation

**Files Modified**:
- `mentorminds-backend/src/services/sorobanEscrow.service.ts`

**Implementation Details**:
```typescript
async invoke(preparedTx: any): Promise<TransactionResult> {
  const sendResponse = await this.rpcServer.sendTransaction(preparedTx);
  const txHash = sendResponse.hash;
  
  // Wait for confirmation
  const confirmedTx = await this.waitForTransaction(txHash);
  
  return { txHash, result: confirmedTx };
}
```

---

## Issue #284: Prevent State Divergence in Dispute Creation

**Problem**: `openDispute` called Soroban first, then created DB record. If DB insert failed, the contract would be in disputed state but platform DB would have no dispute record, permanently locking the escrow.

**Fix Applied**:
- Reversed operation order: DB update first, then on-chain call
- If on-chain call fails, rollback DB status to previous state
- Wrapped in try-catch with explicit rollback logic
- Ensures DB and on-chain state remain synchronized

**Files Modified**:
- `mentorminds-backend/src/services/escrow-api.service.ts`

**Implementation Details**:
```typescript
async openDispute(escrowId: string, raisedBy: string, reason: string) {
  // Update DB status to disputed first
  const updatedEscrow = await this.escrowRepository.updateStatus(escrowId, "disputed");
  
  // Then attempt on-chain call
  try {
    await this.sorobanEscrowService.openDispute({ escrowId, raisedBy, reason });
  } catch (error) {
    // On-chain call failed, rollback DB status
    await this.escrowRepository.updateStatus(escrowId, escrow.status);
    throw new Error(`Failed to open dispute on-chain: ${error.message}`);
  }
  
  return updatedEscrow;
}
```

**Tests Added**:
- Test for rollback behavior when on-chain call fails
- Verifies DB status returns to 'funded' after failed dispute creation

---

## Summary of Changes

### Security Improvements
1. Input validation prevents transaction failures from oversized data
2. State machine enforcement prevents invalid operations on pending escrows
3. Transaction confirmation prevents premature status updates
4. Rollback logic prevents state divergence between DB and blockchain

### Files Changed
- `mentorminds-backend/src/services/sorobanEscrow.service.ts`
- `mentorminds-backend/src/services/escrow-api.service.ts`
- `mentorminds-backend/tests/escrow-api-transitions.test.ts`

### Commits
1. Add length validation for dispute reason
2. Restrict escrow release to funded status only
3. Update tests for escrow validation changes

### Testing
All existing tests pass with updated expectations. New tests added for:
- Dispute reason length validation (500 char limit)
- Rollback behavior on failed on-chain calls
- Stricter release status validation

### Backward Compatibility
These changes are backward compatible for correct usage:
- Valid dispute reasons (<= 500 chars) continue to work
- Funded escrows can still be released normally
- Transaction confirmation is transparent to callers
- Rollback logic only activates on errors

### Future Considerations
1. Consider adding a `on_chain_dispute_pending` flag to disputes table for retry logic
2. Add monitoring for transaction confirmation timeouts
3. Consider making timeout and poll interval configurable
4. Add metrics for rollback frequency to detect issues
