#![no_std]

use soroban_sdk::contracterror;

/// Shared contract primitives reused across multiple Soroban modules.
///
/// Centralizing these definitions keeps authorization and state-transition
/// behavior aligned across contracts that make the same safety assumptions.
pub mod reentrancy_guard;
pub mod sig_validation;
pub mod state_machine;

pub use reentrancy_guard::ReentrancyGuard;
pub use sig_validation::{
    current_nonce, is_deadline_valid, validate_and_consume_nonce, validate_deadline,
    MetaTxAction, MetaTxPayload, SigError, EXPIRY_TOLERANCE_SECS, MAX_DEADLINE_SECS,
};
pub use state_machine::StateMachine;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SharedError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NotFound = 4,
    InvalidAmount = 5,
    InvalidState = 6,
    DuplicateEntry = 7,
    UnsupportedOperation = 8,
    Overflow = 9,
    Underflow = 10,
}
