import {
  SorobanEscrowServiceImpl,
  StellarSorobanClient,
  BookingRepository,
  BookingRecord,
  BookingPaymentStatus,
  EscrowOnChainState,
  EscrowStateResolver,
} from "../src/services/sorobanEscrow.service";

function makeBooking(
  id: string,
  escrowId: string,
  status = "pending"
): BookingRecord {
  return { id, escrowId, status, paymentStatus: "pending" };
}

// ── Issue #261: applyEscrowStateToBookings ────────────────────────────────────

describe("applyEscrowStateToBookings — Issue #261", () => {
  function makeRepo(): {
    repo: BookingRepository;
    calls: Array<{ bookingId: string; status: BookingPaymentStatus }>;
  } {
    const calls: Array<{ bookingId: string; status: BookingPaymentStatus }> = [];
    const repo: BookingRepository = {
      updatePaymentStatus: jest
        .fn()
        .mockImplementation((bookingId, status) => {
          calls.push({ bookingId, status });
          return Promise.resolve();
        }),
      findBookingsWithActiveEscrow: jest.fn(),
    };
    return { repo, calls };
  }

  it("sets payment_status = disputed (not failed) when escrow is disputed", async () => {
    const { repo, calls } = makeRepo();
    const service = new SorobanEscrowServiceImpl();

    await service.applyEscrowStateToBookings(
      { escrowId: "esc-1", status: "disputed" },
      "booking-1",
      repo
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ bookingId: "booking-1", status: "disputed" });
  });

  it("never sets payment_status = failed for disputed escrows", async () => {
    const { repo, calls } = makeRepo();
    const service = new SorobanEscrowServiceImpl();

    await service.applyEscrowStateToBookings(
      { escrowId: "esc-1", status: "disputed" },
      "booking-1",
      repo
    );

    const failedCall = calls.find((c) => c.status === "failed");
    expect(failedCall).toBeUndefined();
  });

  it("sets payment_status = paid when escrow is released", async () => {
    const { repo, calls } = makeRepo();
    const service = new SorobanEscrowServiceImpl();

    await service.applyEscrowStateToBookings(
      { escrowId: "esc-1", status: "released" },
      "booking-2",
      repo
    );

    expect(calls[0]).toEqual({ bookingId: "booking-2", status: "paid" });
  });

  it("sets payment_status = refunded when escrow is refunded", async () => {
    const { repo, calls } = makeRepo();
    const service = new SorobanEscrowServiceImpl();

    await service.applyEscrowStateToBookings(
      { escrowId: "esc-1", status: "refunded" },
      "booking-3",
      repo
    );

    expect(calls[0]).toEqual({ bookingId: "booking-3", status: "refunded" });
  });

  it("makes no payment status update when escrow is active", async () => {
    const { repo, calls } = makeRepo();
    const service = new SorobanEscrowServiceImpl();

    await service.applyEscrowStateToBookings(
      { escrowId: "esc-1", status: "active" },
      "booking-4",
      repo
    );

    expect(calls).toHaveLength(0);
  });

  it("makes no payment status update when escrow is resolved", async () => {
    const { repo, calls } = makeRepo();
    const service = new SorobanEscrowServiceImpl();

    await service.applyEscrowStateToBookings(
      { escrowId: "esc-1", status: "resolved" },
      "booking-5",
      repo
    );

    expect(calls).toHaveLength(0);
  });
});

// ── Issue #262: syncPendingEscrows ────────────────────────────────────────────

describe("syncPendingEscrows — Issue #262", () => {
  it("queries bookings with status 'pending' included", async () => {
    const mockFindBookings = jest.fn().mockResolvedValue([]);
    const repo: BookingRepository = {
      updatePaymentStatus: jest.fn(),
      findBookingsWithActiveEscrow: mockFindBookings,
    };
    const stateResolver: EscrowStateResolver = {
      getEscrowState: jest.fn(),
    };

    const service = new SorobanEscrowServiceImpl();
    await service.syncPendingEscrows(repo, stateResolver);

    const [statusList] = mockFindBookings.mock.calls[0] as [string[]];
    expect(statusList).toContain("pending");
  });

  it("also queries confirmed, completed, and cancelled bookings", async () => {
    const mockFindBookings = jest.fn().mockResolvedValue([]);
    const repo: BookingRepository = {
      updatePaymentStatus: jest.fn(),
      findBookingsWithActiveEscrow: mockFindBookings,
    };

    const service = new SorobanEscrowServiceImpl();
    await service.syncPendingEscrows(repo, { getEscrowState: jest.fn() });

    const [statusList] = mockFindBookings.mock.calls[0] as [string[]];
    expect(statusList).toContain("confirmed");
    expect(statusList).toContain("completed");
    expect(statusList).toContain("cancelled");
  });

  it("fetches on-chain state for each booking and applies it", async () => {
    const booking = makeBooking("b-1", "esc-1", "pending");
    const repo: BookingRepository = {
      updatePaymentStatus: jest.fn().mockResolvedValue(undefined),
      findBookingsWithActiveEscrow: jest.fn().mockResolvedValue([booking]),
    };
    const stateResolver: EscrowStateResolver = {
      getEscrowState: jest
        .fn()
        .mockResolvedValue({ escrowId: "esc-1", status: "disputed" }),
    };

    const service = new SorobanEscrowServiceImpl();
    await service.syncPendingEscrows(repo, stateResolver);

    expect(stateResolver.getEscrowState).toHaveBeenCalledWith("esc-1");
    expect(repo.updatePaymentStatus).toHaveBeenCalledWith("b-1", "disputed");
  });

  it("syncs multiple bookings in sequence", async () => {
    const bookings = [
      makeBooking("b-1", "esc-1", "pending"),
      makeBooking("b-2", "esc-2", "confirmed"),
    ];
    const repo: BookingRepository = {
      updatePaymentStatus: jest.fn().mockResolvedValue(undefined),
      findBookingsWithActiveEscrow: jest.fn().mockResolvedValue(bookings),
    };
    const stateResolver: EscrowStateResolver = {
      getEscrowState: jest.fn().mockImplementation(
        (escrowId: string): Promise<EscrowOnChainState> =>
          Promise.resolve({
            escrowId,
            status: escrowId === "esc-1" ? "released" : "disputed",
          })
      ),
    };

    const service = new SorobanEscrowServiceImpl();
    await service.syncPendingEscrows(repo, stateResolver);

    expect(repo.updatePaymentStatus).toHaveBeenCalledWith("b-1", "paid");
    expect(repo.updatePaymentStatus).toHaveBeenCalledWith("b-2", "disputed");
  });
});

// ── Issue #263: StellarSorobanClient.buildContractTransaction ─────────────────

describe("StellarSorobanClient.buildContractTransaction — Issue #263", () => {
  const originalEnv = process.env.SOROBAN_FEE_MULTIPLIER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SOROBAN_FEE_MULTIPLIER;
    } else {
      process.env.SOROBAN_FEE_MULTIPLIER = originalEnv;
    }
  });

  it("calls getFeeEstimate(1) on the fees service", async () => {
    const mockFees = {
      getFeeEstimate: jest.fn().mockResolvedValue({ recommended_fee: "200" }),
    };

    const client = new StellarSorobanClient(mockFees);
    await client.buildContractTransaction();

    expect(mockFees.getFeeEstimate).toHaveBeenCalledWith(1);
  });

  it("applies the default SOROBAN_FEE_MULTIPLIER of 10", async () => {
    delete process.env.SOROBAN_FEE_MULTIPLIER;

    const mockFees = {
      getFeeEstimate: jest.fn().mockResolvedValue({ recommended_fee: "200" }),
    };

    const client = new StellarSorobanClient(mockFees);
    const { fee } = await client.buildContractTransaction();

    expect(fee).toBe("2000"); // 200 * 10
  });

  it("respects a custom SOROBAN_FEE_MULTIPLIER env var", async () => {
    process.env.SOROBAN_FEE_MULTIPLIER = "5";

    const mockFees = {
      getFeeEstimate: jest.fn().mockResolvedValue({ recommended_fee: "300" }),
    };

    const client = new StellarSorobanClient(mockFees);
    const { fee } = await client.buildContractTransaction();

    expect(fee).toBe("1500"); // 300 * 5
  });

  it("produces a fee higher than the static BASE_FEE of 100", async () => {
    delete process.env.SOROBAN_FEE_MULTIPLIER;

    const mockFees = {
      getFeeEstimate: jest.fn().mockResolvedValue({ recommended_fee: "200" }),
    };

    const client = new StellarSorobanClient(mockFees);
    const { fee } = await client.buildContractTransaction();

    // 200 * 10 = 2000 > 100 (BASE_FEE constant)
    expect(parseInt(fee, 10)).toBeGreaterThan(100);
  });

  it("uses the recommended fee, not a hardcoded constant", async () => {
    delete process.env.SOROBAN_FEE_MULTIPLIER;

    const mockFees = {
      getFeeEstimate: jest.fn().mockResolvedValue({ recommended_fee: "500" }),
    };

    const client = new StellarSorobanClient(mockFees);
    const { fee } = await client.buildContractTransaction();

    // Fee should reflect the mocked recommended_fee, not 100
    expect(parseInt(fee, 10)).toBe(5000); // 500 * 10
  });
});
