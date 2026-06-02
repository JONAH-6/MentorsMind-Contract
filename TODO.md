# TODO - Fix governance StateMachine transition enforcement

- [ ] Add a small helper that enforces `ProposalStatus: StateMachine::is_valid_transition` before mutating proposal.status.
- [ ] Update `execute_proposal()` to use the helper for transitions to `Passed` then `Queued`.
- [ ] Update `execute_queued_proposal()` to use the helper for transition from `Queued` to `Executed`.
- [ ] Update tests if needed and run `cargo test` for the governance contract/workspace.
- [ ] Verify the state machine dead-code issue is fully resolved and no direct status bypass remains in these flows.

