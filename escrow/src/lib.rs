/// Cache of accrued yield per escrow to avoid repeated get_value calls.
const YIELD_ACCRUED_CACHE: Symbol = symbol_short!("YLD_ACC");
