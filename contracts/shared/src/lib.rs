#![no_std]

use soroban_sdk::contracterror;

pub mod reentrancy_guard;
pub mod state_machine;

pub use reentrancy_guard::ReentrancyGuard;
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
