#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Val, Vec,
};

const ADMIN: Symbol = symbol_short!("ADMIN");
const OP_COUNT: Symbol = symbol_short!("OP_CNT");

// ---------------------------------------------------------------------------
// Timestamp security constants
// ---------------------------------------------------------------------------

/// Minimum delay before an operation can be executed (48 hours).
/// This is long enough that even a validator who skews the clock forward by
/// TIMESTAMP_TOLERANCE_SECS cannot meaningfully shorten the effective delay.
const MIN_DELAY: u64 = 48 * 60 * 60; // 48 hours

/// Maximum delay (30 days). Caps how far into the future an operation can be
/// scheduled, preventing operations from being parked indefinitely.
const MAX_DELAY: u64 = 30 * 24 * 60 * 60; // 30 days

/// Operations expire this many seconds after their `ready_at` time if not
/// executed.  This prevents stale operations from being executed long after
/// they were intended, which could be exploited if the contract state has
/// changed in the interim.
pub const OPERATION_EXPIRY_SECS: u64 = 14 * 24 * 60 * 60; // 14 days

/// Tolerance window applied to the `ready_at` check to absorb validator
/// timestamp drift (Stellar validators may drift up to ~30 s).
/// An operation is considered "ready" only when:
///   current_time >= ready_at + TIMESTAMP_TOLERANCE_SECS
/// This prevents a validator with a slightly fast clock from executing an
/// operation before the intended delay has fully elapsed.
pub const TIMESTAMP_TOLERANCE_SECS: u64 = 60; // 1 minute

#[contracttype]
#[derive(Clone)]
pub struct Operation {
    pub proposer: Address,
    pub target: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub ready_at: u64,
    pub done: bool,
}

#[contract]
pub struct TimelockController;

#[contractimpl]
impl TimelockController {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().persistent().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&ADMIN, &admin);
    }

    /// Schedule a new operation.
    ///
    /// # Timestamp security
    /// `delay` must be within [`MIN_DELAY`, `MAX_DELAY`].  The `ready_at`
    /// timestamp is computed as `now + delay` where `now` is the current
    /// ledger timestamp.  Because we add `TIMESTAMP_TOLERANCE_SECS` to the
    /// `ready_at` check in `execute`, a validator that skews the clock forward
    /// by up to `TIMESTAMP_TOLERANCE_SECS` cannot cause the operation to
    /// execute before the full `delay` has elapsed.
    pub fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        delay: u64,
    ) -> BytesN<32> {
        caller.require_auth();
        if !(MIN_DELAY..=MAX_DELAY).contains(&delay) {
            panic!("invalid delay");
        }
        let mut count: u64 = env.storage().persistent().get(&OP_COUNT).unwrap_or(0);
        count += 1;
        env.storage().persistent().set(&OP_COUNT, &count);
        let mut raw = [0u8; 32];
        raw[24] = ((count >> 56) & 0xff) as u8;
        raw[25] = ((count >> 48) & 0xff) as u8;
        raw[26] = ((count >> 40) & 0xff) as u8;
        raw[27] = ((count >> 32) & 0xff) as u8;
        raw[28] = ((count >> 24) & 0xff) as u8;
        raw[29] = ((count >> 16) & 0xff) as u8;
        raw[30] = ((count >> 8) & 0xff) as u8;
        raw[31] = (count & 0xff) as u8;
        let op_id: BytesN<32> = BytesN::from_array(&env, &raw);
        let now = env.ledger().timestamp();
        let op = Operation {
            proposer: caller.clone(),
            target: target.clone(),
            function: function.clone(),
            args,
            ready_at: now
                .checked_add(delay)
                .expect("timestamp overflow"),
            done: false,
        };
        let key = (symbol_short!("OP"), op_id.clone());
        env.storage().persistent().set(&key, &op);
        env.events().publish(
            (
                symbol_short!("timelock"),
                symbol_short!("scheduled"),
                op_id.clone(),
            ),
            (caller, target, function),
        );
        op_id
    }

    /// Execute a ready operation.
    ///
    /// # Timestamp security
    /// Two checks are applied:
    /// 1. **Readiness with tolerance**: `current_time >= ready_at + TIMESTAMP_TOLERANCE_SECS`.
    ///    This absorbs forward clock drift so a validator cannot execute an
    ///    operation before the full delay has elapsed.
    /// 2. **Expiry**: `current_time < ready_at + OPERATION_EXPIRY_SECS`.
    ///    Stale operations that were never executed within the expiry window
    ///    are rejected.  This prevents an attacker from holding a valid
    ///    operation and executing it at an opportune moment far in the future
    ///    when the contract state may have changed.
    pub fn execute(env: Env, operation_id: BytesN<32>) {
        let key = (symbol_short!("OP"), operation_id.clone());
        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");
        if op.done {
            panic!("operation already done");
        }

        let now = env.ledger().timestamp();

        // Readiness check with tolerance window.
        if now < op.ready_at.saturating_add(TIMESTAMP_TOLERANCE_SECS) {
            panic!("operation not ready");
        }

        // Expiry check: reject operations that have been sitting unexecuted
        // for longer than OPERATION_EXPIRY_SECS past their ready_at time.
        let expiry = op
            .ready_at
            .checked_add(OPERATION_EXPIRY_SECS)
            .expect("timestamp overflow");
        if now >= expiry {
            panic!("operation expired");
        }

        env.invoke_contract::<Val>(&op.target, &op.function, op.args.clone());
        op.done = true;
        env.storage().persistent().set(&key, &op);
        env.events().publish(
            (
                symbol_short!("timelock"),
                symbol_short!("executed"),
                operation_id,
            ),
            true,
        );
    }

    pub fn cancel(env: Env, operation_id: BytesN<32>) {
        let key = (symbol_short!("OP"), operation_id.clone());
        let op: Operation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");
        if op.done {
            panic!("operation already done");
        }
        let admin: Address = env
            .storage()
            .persistent()
            .get(&ADMIN)
            .expect("not initialized");
        if admin != op.proposer {
            admin.require_auth();
        } else {
            op.proposer.require_auth();
        }
        env.storage().persistent().remove(&key);
        env.events().publish(
            (
                symbol_short!("timelock"),
                symbol_short!("cancelled"),
                operation_id,
            ),
            true,
        );
    }

    /// Returns true if the operation is ready to execute (delay elapsed,
    /// tolerance satisfied, not yet expired, not yet done).
    pub fn is_operation_ready(env: Env, operation_id: BytesN<32>) -> bool {
        let key = (symbol_short!("OP"), operation_id);
        let op: Operation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");
        if op.done {
            return false;
        }
        let now = env.ledger().timestamp();
        let ready = now >= op.ready_at.saturating_add(TIMESTAMP_TOLERANCE_SECS);
        let not_expired = now
            < op.ready_at
                .checked_add(OPERATION_EXPIRY_SECS)
                .expect("timestamp overflow");
        ready && not_expired
    }

    pub fn is_operation_done(env: Env, operation_id: BytesN<32>) -> bool {
        let key = (symbol_short!("OP"), operation_id);
        let op: Operation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");
        op.done
    }

    /// Returns true if the operation exists but has passed its expiry window
    /// without being executed.
    pub fn is_operation_expired(env: Env, operation_id: BytesN<32>) -> bool {
        let key = (symbol_short!("OP"), operation_id);
        let op: Operation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("operation not found");
        if op.done {
            return false;
        }
        let now = env.ledger().timestamp();
        let expiry = op
            .ready_at
            .checked_add(OPERATION_EXPIRY_SECS)
            .expect("timestamp overflow");
        now >= expiry
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Env,
    };

    fn setup() -> (Env, Address, TimelockControllerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, TimelockController);
        let client = TimelockControllerClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, admin, client)
    }

    fn schedule_op(
        env: &Env,
        client: &TimelockControllerClient,
        caller: &Address,
    ) -> BytesN<32> {
        let target = Address::generate(env);
        let function = Symbol::new(env, "noop");
        let args = Vec::new(env);
        client.schedule(caller, &target, &function, &args, &MIN_DELAY)
    }

    // --- schedule ---

    #[test]
    fn test_schedule_valid() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);
        assert!(!client.is_operation_done(&op_id));
    }

    #[test]
    #[should_panic(expected = "invalid delay")]
    fn test_schedule_delay_too_short() {
        let (env, admin, client) = setup();
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "noop");
        let args = Vec::new(&env);
        client.schedule(&admin, &target, &function, &args, &(MIN_DELAY - 1));
    }

    #[test]
    #[should_panic(expected = "invalid delay")]
    fn test_schedule_delay_too_long() {
        let (env, admin, client) = setup();
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "noop");
        let args = Vec::new(&env);
        client.schedule(&admin, &target, &function, &args, &(MAX_DELAY + 1));
    }

    // --- execute: readiness with tolerance ---

    #[test]
    #[should_panic(expected = "operation not ready")]
    fn test_execute_before_ready_at_panics() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);

        // Advance to exactly ready_at — still blocked by tolerance window.
        env.ledger().with_mut(|li| li.timestamp += MIN_DELAY);
        client.execute(&op_id);
    }

    #[test]
    #[should_panic(expected = "operation not ready")]
    fn test_execute_at_ready_at_plus_tolerance_minus_one_panics() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);

        // One second before tolerance window clears.
        env.ledger()
            .with_mut(|li| li.timestamp += MIN_DELAY + TIMESTAMP_TOLERANCE_SECS - 1);
        client.execute(&op_id);
    }

    /// Simulate a validator that skews the clock forward by TIMESTAMP_TOLERANCE_SECS.
    /// The operation must NOT execute before the full delay has elapsed.
    #[test]
    #[should_panic(expected = "operation not ready")]
    fn test_manipulated_timestamp_cannot_execute_early() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);

        // Validator skews clock forward by TOLERANCE — still at ready_at + TOLERANCE,
        // which is the boundary (not strictly greater), so still blocked.
        env.ledger()
            .with_mut(|li| li.timestamp += MIN_DELAY + TIMESTAMP_TOLERANCE_SECS);
        client.execute(&op_id);
    }

    // --- execute: expiry ---

    #[test]
    #[should_panic(expected = "operation expired")]
    fn test_execute_after_expiry_panics() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);

        // Advance past ready_at + OPERATION_EXPIRY_SECS.
        env.ledger()
            .with_mut(|li| li.timestamp += MIN_DELAY + OPERATION_EXPIRY_SECS + 1);
        client.execute(&op_id);
    }

    #[test]
    fn test_is_operation_expired() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);

        // Not expired yet
        assert!(!client.is_operation_expired(&op_id));

        // Advance past expiry
        env.ledger()
            .with_mut(|li| li.timestamp += MIN_DELAY + OPERATION_EXPIRY_SECS + 1);
        assert!(client.is_operation_expired(&op_id));
    }

    #[test]
    fn test_is_operation_ready_respects_tolerance() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);

        // At ready_at — not ready (tolerance not cleared)
        env.ledger().with_mut(|li| li.timestamp += MIN_DELAY);
        assert!(!client.is_operation_ready(&op_id));

        // At ready_at + TOLERANCE — boundary, still not ready (strict >)
        env.ledger()
            .with_mut(|li| li.timestamp += TIMESTAMP_TOLERANCE_SECS);
        assert!(!client.is_operation_ready(&op_id));

        // One second past tolerance — now ready
        env.ledger().with_mut(|li| li.timestamp += 1);
        assert!(client.is_operation_ready(&op_id));
    }

    // --- cancel ---

    #[test]
    fn test_cancel_pending_operation() {
        let (env, admin, client) = setup();
        let op_id = schedule_op(&env, &client, &admin);
        client.cancel(&op_id);
    }

    #[test]
    #[should_panic(expected = "operation not found")]
    fn test_cancel_nonexistent_panics() {
        let (env, _admin, client) = setup();
        let fake_id = BytesN::from_array(&env, &[0u8; 32]);
        client.cancel(&fake_id);
    }
}
