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
    NotInitialized = 2,
    NotAdmin = 3,
    OperationNotFound = 4,
    AlreadyDone = 5,
    NotReady = 6,
    InvalidDelay = 7,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum delay: 48 hours
pub const MIN_DELAY: u64 = 48 * 60 * 60;
/// Maximum delay: 30 days
pub const MAX_DELAY: u64 = 30 * 24 * 60 * 60;
pub const OPERATION_EXPIRY_SECS: u64 = 14 * 24 * 60 * 60; // 14 days
pub const TIMESTAMP_TOLERANCE_SECS: u64 = 60; // 1 minute

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
        env.events().publish((symbol_short!("timelock"), symbol_short!("init")), admin);
        Ok(())
    }

    /// Schedule a delayed operation.
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
        raw[30] = ((count >> 8) & 0xff) as u8;
        raw[31] = (count & 0xff) as u8;
        let op_id: BytesN<32> = BytesN::from_array(&env, &raw);

        let now = env.ledger().timestamp();
        let op = Operation {
            proposer: caller.clone(),
            target: target.clone(),
            function: function.clone(),
            args,
            ready_at: now.checked_add(delay).expect("timestamp overflow"),
            done: false,
        };
        env.storage().persistent().set(&DataKey::Op(op_id.clone()), &op);

        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("sched"), op_id.clone()),
            (caller, target, function, delay),
        );
        Ok(op_id)
    }

    /// Execute a ready operation.
    pub fn execute(env: Env, operation_id: BytesN<32>) {
        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Op(operation_id.clone()))
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
        env.storage()
            .persistent()
            .set(&DataKey::Op(operation_id.clone()), &op);

        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("exec"), operation_id),
            true,
        );
    }

    /// Cancel a scheduled operation.
    pub fn cancel(env: Env, operation_id: BytesN<32>) {
        let op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Op(operation_id.clone()))
            .expect("operation not found");
        if op.done {
            panic!("operation already done");
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");

        if op.proposer != admin {
            admin.require_auth();
        } else {
            op.proposer.require_auth();
        }

        env.storage().persistent().remove(&DataKey::Op(operation_id.clone()));

        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("cancel"), operation_id),
            true,
        );
    }

    /// Transfer admin role (requires current admin auth).
    pub fn transfer_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("timelock"), symbol_short!("adm_xfr")),
            (admin, new_admin),
        );
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    /// Returns true if the operation is ready to execute (delay elapsed, tolerance satisfied, not yet expired, not yet done).
    pub fn is_operation_ready(env: Env, operation_id: BytesN<32>) -> bool {
        let op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Op(operation_id))
            .expect("operation not found");
        if op.done {
            return false;
        }
        let now = env.ledger().timestamp();
        let ready = now >= op.ready_at.saturating_add(TIMESTAMP_TOLERANCE_SECS);
        let not_expired = now
            < op
                .ready_at
                .checked_add(OPERATION_EXPIRY_SECS)
                .expect("timestamp overflow");
        ready && not_expired
    }

    /// Returns true if the operation exists but has passed its expiry window without being executed.
    pub fn is_operation_expired(env: Env, operation_id: BytesN<32>) -> bool {
        let op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Op(operation_id))
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

    pub fn is_operation_done(env: Env, operation_id: BytesN<32>) -> bool {
        match env.storage().persistent().get::<_, Operation>(&DataKey::Op(operation_id)) {
            Some(op) => op.done,
            None => false,
        }
    }

    pub fn get_operation(env: Env, operation_id: BytesN<32>) -> Operation {
        env.storage()
            .persistent()
            .get(&DataKey::Op(operation_id))
            .expect("operation not found")
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
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

    #[contract]
    pub struct MockTarget;

    #[contractimpl]
    impl MockTarget {
        pub fn set_fee(_env: Env, _fee: u32) {}
        pub fn update_treasury(_env: Env, _addr: Address) {}
    }

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
        client
            .schedule(caller, &target, &function, &args, &MIN_DELAY)
            .unwrap()
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, TimelockController);
        let client = TimelockControllerClient::new(&env, &contract_id);
        client.initialize(&admin);
        assert_eq!(client.get_admin(), admin);
    }

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
}
