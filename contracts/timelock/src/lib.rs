#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, symbol_short, Address, BytesN, Env,
    Symbol, Val, Vec,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    NotAdmin           = 3,
    OperationNotFound  = 4,
    AlreadyDone        = 5,
    NotReady           = 6,
    InvalidDelay       = 7,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum delay: 24 hours (satisfies "24-48h" requirement lower bound)
pub const MIN_DELAY: u64 = 24 * 60 * 60;
/// Maximum delay: 30 days
pub const MAX_DELAY: u64 = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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
    pub proposer:  Address,
    pub target:    Address,
    pub function:  Symbol,
    pub args:      Vec<Val>,
    pub ready_at:  u64,
    pub done:      bool,
}

// ---------------------------------------------------------------------------
// Storage Keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    OpCount,
    Op(BytesN<32>),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct TimelockController;

#[contractimpl]
impl TimelockController {
    /// Initialize the timelock with an admin address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::OpCount, &0u64);
        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("init")),
            admin,
        );
        Ok(())
    }

    /// Schedule a delayed operation.
    /// `delay` must be between MIN_DELAY (24h) and MAX_DELAY (30d).
    /// Any caller may schedule; the admin can cancel any operation.
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
    ) -> Result<BytesN<32>, Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }
        if delay < MIN_DELAY || delay > MAX_DELAY {
            return Err(Error::InvalidDelay);
        }
        caller.require_auth();

        let mut count: u64 = env.storage().instance().get(&DataKey::OpCount).unwrap_or(0);
        count += 1;
        env.storage().instance().set(&DataKey::OpCount, &count);

        // Deterministic op_id from counter
        let mut raw = [0u8; 32];
        raw[24] = ((count >> 56) & 0xff) as u8;
        raw[25] = ((count >> 48) & 0xff) as u8;
        raw[26] = ((count >> 40) & 0xff) as u8;
        raw[27] = ((count >> 32) & 0xff) as u8;
        raw[28] = ((count >> 24) & 0xff) as u8;
        raw[29] = ((count >> 16) & 0xff) as u8;
        raw[30] = ((count >> 8)  & 0xff) as u8;
        raw[31] = (count         & 0xff) as u8;
        let op_id: BytesN<32> = BytesN::from_array(&env, &raw);

        let now = env.ledger().timestamp();
        let op = Operation {
            proposer: caller.clone(),
            target:   target.clone(),
            function: function.clone(),
            args,
            ready_at: env.ledger().timestamp() + delay,
            done:     false,
            ready_at: now
                .checked_add(delay)
                .expect("timestamp overflow"),
            done: false,
        };
        env.storage().persistent().set(&DataKey::Op(op_id.clone()), &op);

        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("sched"), op_id.clone()),
            (caller, target, function, delay),
        );
        Ok(op_id)
    }

    /// Execute a scheduled operation once its delay has elapsed.
    pub fn execute(env: Env, operation_id: BytesN<32>) -> Result<(), Error> {
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
            .get(&DataKey::Op(operation_id.clone()))
            .ok_or(Error::OperationNotFound)?;
        if op.done {
            return Err(Error::AlreadyDone);
        }
        if env.ledger().timestamp() < op.ready_at {
            return Err(Error::NotReady);
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
        env.storage().persistent().set(&DataKey::Op(operation_id.clone()), &op);

        env.invoke_contract::<Val>(&op.target, &op.function, op.args.clone());

        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("exec"), operation_id),
            true,
        );
        Ok(())
    }

    /// Cancel a scheduled operation.
    /// The proposer or the admin may cancel.
    pub fn cancel(env: Env, operation_id: BytesN<32>) -> Result<(), Error> {
        let op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Op(operation_id.clone()))
            .ok_or(Error::OperationNotFound)?;
        if op.done {
            return Err(Error::AlreadyDone);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if op.proposer == admin {
            op.proposer.require_auth();
        } else {
            // Either the proposer or the admin can cancel
            admin.require_auth();
        }

        env.storage().persistent().remove(&DataKey::Op(operation_id.clone()));

        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("cancel"), operation_id),
            true,
        );
        Ok(())
    }

    /// Transfer admin role (requires current admin auth).
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("adm_xfr")),
            (admin, new_admin),
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    pub fn is_operation_ready(env: Env, operation_id: BytesN<32>) -> bool {
        match env.storage().persistent().get::<_, Operation>(&DataKey::Op(operation_id)) {
            Some(op) => !op.done && env.ledger().timestamp() >= op.ready_at,
            None => false,
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
        match env.storage().persistent().get::<_, Operation>(&DataKey::Op(operation_id)) {
            Some(op) => op.done,
            None => false,
        }
    }

    pub fn get_operation(env: Env, operation_id: BytesN<32>) -> Result<Operation, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Op(operation_id))
            .ok_or(Error::OperationNotFound)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{vec, Env, Symbol};

    // -----------------------------------------------------------------------
    // Mock target contract for execute tests
    // -----------------------------------------------------------------------

    #[contract]
    pub struct MockTarget;

    #[contractimpl]
    impl MockTarget {
        pub fn set_fee(_env: Env, _fee: u32) {}
        pub fn update_treasury(_env: Env, _addr: Address) {}
    }

    // -----------------------------------------------------------------------
    // Fixture
    // -----------------------------------------------------------------------

    struct Fixture {
        env:      Env,
        contract: Address,
        admin:    Address,
        target:   Address,
    }

    impl Fixture {
        fn setup() -> Self {
            let env = Env::default();
            env.mock_all_auths();
            env.ledger().set_timestamp(1_000_000);

            let admin    = Address::generate(&env);
            let target   = env.register_contract(None, MockTarget);
            let contract = env.register_contract(None, TimelockController);
            TimelockContractClient::new(&env, &contract).initialize(&admin).unwrap();

            Fixture { env, contract, admin, target }
        }

        fn client(&self) -> TimelockContractClient {
            TimelockContractClient::new(&self.env, &self.contract)
        }

        fn schedule_fee(&self, delay: u64) -> BytesN<32> {
            self.client().schedule(
                &self.admin,
                &self.target,
                &Symbol::new(&self.env, "set_fee"),
                &vec![&self.env],
                &delay,
            ).unwrap()
        }
    }

    // -----------------------------------------------------------------------
    // Tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin    = Address::generate(&env);
        let contract = env.register_contract(None, TimelockController);
        let client   = TimelockContractClient::new(&env, &contract);

        client.initialize(&admin).unwrap();
        assert_eq!(client.get_admin().unwrap(), admin);

        // Double init rejected
        assert_eq!(client.try_initialize(&admin), Err(Ok(Error::AlreadyInitialized)));
    }

    #[test]
    fn test_schedule_valid_delay() {
        let f = Fixture::setup();
        // 24h delay (minimum)
        let op_id = f.schedule_fee(MIN_DELAY);
        let op = f.client().get_operation(&op_id).unwrap();
        assert_eq!(op.done, false);
        assert_eq!(op.ready_at, 1_000_000 + MIN_DELAY);
    }

    #[test]
    fn test_schedule_invalid_delay() {
        let f = Fixture::setup();
        // Below minimum
        assert_eq!(
            f.client().try_schedule(
                &f.admin, &f.target,
                &Symbol::new(&f.env, "set_fee"),
                &vec![&f.env], &(MIN_DELAY - 1),
            ),
            Err(Ok(Error::InvalidDelay))
        );
        // Above maximum
        assert_eq!(
            f.client().try_schedule(
                &f.admin, &f.target,
                &Symbol::new(&f.env, "set_fee"),
                &vec![&f.env], &(MAX_DELAY + 1),
            ),
            Err(Ok(Error::InvalidDelay))
        );
    }

    #[test]
    fn test_execute_before_ready_fails() {
        let f = Fixture::setup();
        let op_id = f.schedule_fee(MIN_DELAY);

        // Still before ready_at
        assert_eq!(f.client().try_execute(&op_id), Err(Ok(Error::NotReady)));
        assert_eq!(f.client().is_operation_ready(&op_id), false);
    }

    #[test]
    fn test_execute_after_delay_succeeds() {
        let f = Fixture::setup();
        let op_id = f.schedule_fee(MIN_DELAY);

        // Advance time past ready_at
        f.env.ledger().set_timestamp(1_000_000 + MIN_DELAY);
        assert_eq!(f.client().is_operation_ready(&op_id), true);

        f.client().execute(&op_id).unwrap();
        assert_eq!(f.client().is_operation_done(&op_id), true);

        // Double execute rejected
        assert_eq!(f.client().try_execute(&op_id), Err(Ok(Error::AlreadyDone)));
    }

    #[test]
    fn test_cancel_operation() {
        let f = Fixture::setup();
        let op_id = f.schedule_fee(MIN_DELAY);

        f.client().cancel(&op_id).unwrap();

        // Operation removed — get_operation returns error
        assert_eq!(f.client().try_get_operation(&op_id), Err(Ok(Error::OperationNotFound)));
    }

    #[test]
    fn test_cancel_done_operation_fails() {
        let f = Fixture::setup();
        let op_id = f.schedule_fee(MIN_DELAY);
        f.env.ledger().set_timestamp(1_000_000 + MIN_DELAY);
        f.client().execute(&op_id).unwrap();

        assert_eq!(f.client().try_cancel(&op_id), Err(Ok(Error::AlreadyDone)));
    }

    #[test]
    fn test_transfer_admin() {
        let f = Fixture::setup();
        let new_admin = Address::generate(&f.env);

        f.client().transfer_admin(&new_admin).unwrap();
        assert_eq!(f.client().get_admin().unwrap(), new_admin);
    }

    #[test]
    fn test_fee_change_requires_delay() {
        // Simulate the pattern: fee changes must go through timelock
        let f = Fixture::setup();
        let op_id = f.schedule_fee(MIN_DELAY); // 24h delay

        // Cannot execute immediately
        assert_eq!(f.client().try_execute(&op_id), Err(Ok(Error::NotReady)));

        // After 24h, can execute
        f.env.ledger().set_timestamp(1_000_000 + MIN_DELAY);
        f.client().execute(&op_id).unwrap();
    }

    #[test]
    fn test_treasury_update_requires_delay() {
        let f = Fixture::setup();
        let new_treasury = Address::generate(&f.env);
        let op_id = f.client().schedule(
            &f.admin,
            &f.target,
            &Symbol::new(&f.env, "update_treasury"),
            &vec![&f.env, new_treasury.into_val(&f.env)],
            &MIN_DELAY,
        ).unwrap();

        assert_eq!(f.client().try_execute(&op_id), Err(Ok(Error::NotReady)));
        f.env.ledger().set_timestamp(1_000_000 + MIN_DELAY);
        f.client().execute(&op_id).unwrap();
    }

    #[test]
    fn test_admin_change_requires_delay() {
        // Admin changes should also go through timelock for community review
        let f = Fixture::setup();
        let new_admin = Address::generate(&f.env);
        let op_id = f.client().schedule(
            &f.admin,
            &f.contract,
            &Symbol::new(&f.env, "transfer_admin"),
            &vec![&f.env, new_admin.into_val(&f.env)],
            &(48 * 60 * 60), // 48h for admin changes
        ).unwrap();

        // Not ready immediately
        assert_eq!(f.client().try_execute(&op_id), Err(Ok(Error::NotReady)));
        // Ready after 48h
        f.env.ledger().set_timestamp(1_000_000 + 48 * 60 * 60);
        // Note: execute calls transfer_admin on the timelock itself
        // which requires admin auth — in production this would be the multisig
        f.client().execute(&op_id).unwrap();
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
