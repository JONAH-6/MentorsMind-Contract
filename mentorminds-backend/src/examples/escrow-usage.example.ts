/**
 * SorobanEscrowService Usage Example
 * 
 * This example demonstrates the proper usage of SorobanEscrowService
 * with unique escrow ID generation to prevent duplicate ID errors.
 */

import { SorobanEscrowService, CreateEscrowInput } from '../services/escrow.service';

// Initialize the service
const escrowService = new SorobanEscrowService(
  process.env.SOROBAN_CONTRACT_ID || 'YOUR_CONTRACT_ID',
  process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  process.env.ADMIN_SECRET_KEY || 'YOUR_ADMIN_SECRET',
  process.env.NETWORK_PASSPHRASE // Optional: defaults to TESTNET
);

/**
 * Example 1: Create a new escrow with auto-generated unique ID
 */
async function createNewEscrow() {
  const input: CreateEscrowInput = {
    bookingId: 'booking-12345',
    learnerId: 'learner-abc',
    mentorId: 'mentor-xyz',
    amount: '1000000000', // Amount in stroops (1 XLM = 10^7 stroops)
    currency: 'USDC',
  };

  try {
    const result = await escrowService.createEscrow(input);
    console.log('Escrow created successfully:', {
      escrowId: result.escrowId, // Unique ID like: booking-12345-{uuid}
      transactionHash: result.transactionHash,
      status: result.status,
    });
    return result;
  } catch (error) {
    console.error('Failed to create escrow:', error);
    throw error;
  }
}

/**
 * Example 2: Retry escrow creation after failure
 * The same booking can be re-escrowed with a different unique ID
 */
async function retryEscrowAfterFailure(originalBookingId: string) {
  const input: CreateEscrowInput = {
    bookingId: originalBookingId,
    learnerId: 'learner-abc',
    mentorId: 'mentor-xyz',
    amount: '1000000000',
    currency: 'USDC',
    // escrowId is optional - will auto-generate a new unique ID
  };

  try {
    // This will generate a NEW unique escrow ID, different from the failed attempt
    const result = await escrowService.createEscrow(input);
    console.log('Retry successful with new escrow ID:', result.escrowId);
    return result;
  } catch (error) {
    console.error('Retry failed:', error);
    throw error;
  }
}

/**
 * Example 3: Create escrow with custom ID (for specific use cases)
 */
async function createEscrowWithCustomId() {
  const input: CreateEscrowInput = {
    bookingId: 'booking-67890',
    learnerId: 'learner-def',
    mentorId: 'mentor-uvw',
    amount: '2000000000',
    currency: 'XLM',
    escrowId: 'custom-escrow-2024-001', // Optional custom ID
  };

  try {
    const result = await escrowService.createEscrow(input);
    console.log('Custom escrow created:', result.escrowId);
    return result;
  } catch (error) {
    console.error('Failed to create custom escrow:', error);
    throw error;
  }
}

/**
 * Example 4: Release escrow after service completion
 */
async function releaseEscrow(escrowId: string) {
  try {
    const txHash = await escrowService.releaseEscrow(escrowId);
    console.log('Escrow released:', txHash);
    return txHash;
  } catch (error) {
    console.error('Failed to release escrow:', error);
    throw error;
  }
}

/**
 * Example 5: Cancel escrow and refund
 */
async function cancelEscrow(escrowId: string) {
  try {
    const txHash = await escrowService.cancelEscrow(escrowId);
    console.log('Escrow cancelled:', txHash);
    return txHash;
  } catch (error) {
    console.error('Failed to cancel escrow:', error);
    throw error;
  }
}

/**
 * Example 6: Get escrow details
 */
async function getEscrowInfo(escrowId: string) {
  try {
    const details = await escrowService.getEscrowDetails(escrowId);
    console.log('Escrow details:', details);
    return details;
  } catch (error) {
    console.error('Failed to get escrow details:', error);
    throw error;
  }
}

// Export for use in controllers
export {
  createNewEscrow,
  retryEscrowAfterFailure,
  createEscrowWithCustomId,
  releaseEscrow,
  cancelEscrow,
  getEscrowInfo,
};
