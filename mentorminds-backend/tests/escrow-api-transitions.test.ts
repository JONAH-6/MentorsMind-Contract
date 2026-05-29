import {
  EscrowApiService,
  EscrowRecord,
  EscrowRepository,
  EscrowStatus,
  SorobanEscrowService,
} from "../src/services/escrow-api.service";

function makeRecord(
  id: string,
  status: EscrowStatus
): EscrowRecord {
  return {
    id,
    mentorId: "mentor-1",
    learnerId: "learner-1",
    amount: "100",
    status,
    createdAt: new Date(),
    stellarTxHash: null,
    sorobanContractVersion: null,
  };
}

class InMemoryEscrowRepo implements EscrowRepository {
  private store = new Map<string, EscrowRecord>();

  seed(records: EscrowRecord[]): void {
    for (const r of records) this.store.set(r.id, r);
  }

  async create(input: Omit<EscrowRecord, "createdAt">): Promise<EscrowRecord> {
    const record: EscrowRecord = { ...input, createdAt: new Date() };
    this.store.set(record.id, record);
    return record;
  }

  async deleteById(id: string): Promise<void> {
    this.store.delete(id);
  }

  async markFunded(
    id: string,
    stellarTxHash: string,
    sorobanContractVersion: string | null
  ): Promise<EscrowRecord> {
    const record = this.store.get(id)!;
    const updated = { ...record, status: "funded" as EscrowStatus, stellarTxHash, sorobanContractVersion };
    this.store.set(id, updated);
    return updated;
  }

  async findPendingOlderThan(): Promise<EscrowRecord[]> {
    return [];
  }

  async findByUserId(): Promise<{ escrows: EscrowRecord[]; total: number }> {
    return { escrows: [], total: 0 };
  }

  async findById(id: string): Promise<EscrowRecord | null> {
    return this.store.get(id) ?? null;
  }

  async updateStatus(id: string, status: EscrowStatus): Promise<EscrowRecord> {
    const record = this.store.get(id);
    if (!record) throw new Error("Escrow not found");
    const updated = { ...record, status };
    this.store.set(id, updated);
    return updated;
  }
}

const stubSoroban: SorobanEscrowService = {
  createEscrow: jest.fn(),
  openDispute: jest.fn().mockResolvedValue({ txHash: "dispute-tx-hash" }),
  resolveDispute: jest.fn().mockResolvedValue({ txHash: "resolve-tx-hash" }),
  refund: jest.fn().mockResolvedValue({ txHash: "refund-tx-hash" }),
};

describe("EscrowApiService.validateStateTransition", () => {
  it("allows pending → funded", () => {
    expect(EscrowApiService.validateStateTransition("pending", "funded")).toBe(true);
  });

  it("allows funded → released", () => {
    expect(EscrowApiService.validateStateTransition("funded", "released")).toBe(true);
  });

  it("allows funded → disputed", () => {
    expect(EscrowApiService.validateStateTransition("funded", "disputed")).toBe(true);
  });

  it("allows funded → refunded", () => {
    expect(EscrowApiService.validateStateTransition("funded", "refunded")).toBe(true);
  });

  it("allows disputed → resolved", () => {
    expect(EscrowApiService.validateStateTransition("disputed", "resolved")).toBe(true);
  });

  it("rejects disputed → refunded (must go through admin resolution)", () => {
    expect(EscrowApiService.validateStateTransition("disputed", "refunded")).toBe(false);
  });

  it("rejects pending → released", () => {
    expect(EscrowApiService.validateStateTransition("pending", "released")).toBe(false);
  });

  it("rejects pending → disputed", () => {
    expect(EscrowApiService.validateStateTransition("pending", "disputed")).toBe(false);
  });

  it("rejects pending → refunded", () => {
    expect(EscrowApiService.validateStateTransition("pending", "refunded")).toBe(false);
  });

  it("rejects pending → resolved", () => {
    expect(EscrowApiService.validateStateTransition("pending", "resolved")).toBe(false);
  });

  it("rejects released → funded", () => {
    expect(EscrowApiService.validateStateTransition("released", "funded")).toBe(false);
  });

  it("rejects released → disputed", () => {
    expect(EscrowApiService.validateStateTransition("released", "disputed")).toBe(false);
  });

  it("rejects released → refunded", () => {
    expect(EscrowApiService.validateStateTransition("released", "refunded")).toBe(false);
  });

  it("rejects released → resolved", () => {
    expect(EscrowApiService.validateStateTransition("released", "resolved")).toBe(false);
  });

  it("rejects refunded → released", () => {
    expect(EscrowApiService.validateStateTransition("refunded", "released")).toBe(false);
  });

  it("rejects refunded → disputed", () => {
    expect(EscrowApiService.validateStateTransition("refunded", "disputed")).toBe(false);
  });

  it("rejects resolved → released", () => {
    expect(EscrowApiService.validateStateTransition("resolved", "released")).toBe(false);
  });

  it("rejects resolved → refunded", () => {
    expect(EscrowApiService.validateStateTransition("resolved", "refunded")).toBe(false);
  });

  it("rejects disputed → funded", () => {
    expect(EscrowApiService.validateStateTransition("disputed", "funded")).toBe(false);
  });

  it("rejects disputed → released", () => {
    expect(EscrowApiService.validateStateTransition("disputed", "released")).toBe(false);
  });
});

describe("EscrowApiService state-changing methods use validateStateTransition", () => {
  it("releaseEscrow succeeds from funded", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    const result = await service.releaseEscrow("esc-1");
    expect(result.status).toBe("released");
  });

  it("releaseEscrow throws when escrow is pending", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "pending")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.releaseEscrow("esc-1")).rejects.toThrow(
      "Cannot release escrow in pending status. Escrow must be funded."
    );
  });

  it("releaseEscrow throws when escrow is already released", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "released")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.releaseEscrow("esc-1")).rejects.toThrow(
      "Cannot release escrow in released status. Escrow must be funded."
    );
  });

  it("releaseEscrow throws when escrow is disputed", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "disputed")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.releaseEscrow("esc-1")).rejects.toThrow(
      "Cannot release escrow in disputed status. Escrow must be funded."
    );
  });

  it("refundEscrow succeeds from funded when called by mentor", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    const result = await service.refundEscrow("esc-1", "mentor-1");
    expect(result.status).toBe("refunded");
    expect(stubSoroban.refund).toHaveBeenCalledWith({
      escrowId: "esc-1",
      refundedBy: "mentor-1",
    });
  });

  it("refundEscrow throws when called by unauthorized user (not mentor)", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.refundEscrow("esc-1", "not-the-mentor")).rejects.toThrow(
      "Unauthorized: only the mentor can trigger a refund"
    );
    
    const escrow = await repo.findById("esc-1");
    expect(escrow?.status).toBe("funded");
  });

  it("refundEscrow rolls back DB status when on-chain call fails", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    
    const failingSoroban: SorobanEscrowService = {
      ...stubSoroban,
      refund: jest.fn().mockRejectedValue(new Error("On-chain refund error")),
    };
    
    const service = new EscrowApiService(repo, failingSoroban);

    await expect(service.refundEscrow("esc-1", "mentor-1")).rejects.toThrow(
      "Failed to refund escrow on-chain for esc-1: On-chain refund error"
    );
    
    const escrow = await repo.findById("esc-1");
    expect(escrow?.status).toBe("funded");
  });

  it("refundEscrow throws when escrow is disputed (must go through admin resolution)", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "disputed")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.refundEscrow("esc-1", "mentor-1")).rejects.toThrow(
      "Cannot refund escrow in disputed status"
    );
  });

  it("refundEscrow throws when escrow is pending", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "pending")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.refundEscrow("esc-1", "mentor-1")).rejects.toThrow(
      "Cannot refund escrow in pending status"
    );
  });

  it("refundEscrow throws when escrow is released", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "released")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.refundEscrow("esc-1", "mentor-1")).rejects.toThrow(
      "Cannot refund escrow in released status"
    );
  });

  it("openDispute succeeds from funded", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    const result = await service.openDispute("esc-1", "user-1", "Service not delivered");
    expect(result.status).toBe("disputed");
  });

  it("openDispute throws when escrow is pending", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "pending")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.openDispute("esc-1", "user-1", "Service not delivered")).rejects.toThrow(
      "Cannot open dispute for escrow in pending status"
    );
  });

  it("openDispute throws when escrow is released", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "released")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.openDispute("esc-1", "user-1", "Service not delivered")).rejects.toThrow(
      "Cannot open dispute for escrow in released status"
    );
  });

  it("openDispute throws when escrow is already disputed", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "disputed")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.openDispute("esc-1", "user-1", "Service not delivered")).rejects.toThrow(
      "Cannot open dispute for escrow in disputed status"
    );
  });

  it("openDispute throws when reason exceeds 500 characters", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    const longReason = "a".repeat(501);
    await expect(service.openDispute("esc-1", "user-1", longReason)).rejects.toThrow(
      "Dispute reason must be 500 characters or less"
    );
  });

  it("openDispute succeeds with 500 character reason", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    const maxReason = "a".repeat(500);
    const result = await service.openDispute("esc-1", "user-1", maxReason);
    expect(result.status).toBe("disputed");
  });

  it("openDispute rolls back DB status when on-chain call fails", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    
    const failingSoroban: SorobanEscrowService = {
      createEscrow: jest.fn(),
      openDispute: jest.fn().mockRejectedValue(new Error("On-chain error")),
      resolveDispute: jest.fn(),
      refund: jest.fn(),
    };
    
    const service = new EscrowApiService(repo, failingSoroban);

    await expect(service.openDispute("esc-1", "user-1", "Service not delivered")).rejects.toThrow(
      "Failed to open dispute on-chain for escrow esc-1: On-chain error"
    );
    
    const escrow = await repo.findById("esc-1");
    expect(escrow?.status).toBe("funded");
  });

  it("resolveDispute succeeds from disputed", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "disputed")]);
    const service = new EscrowApiService(repo, stubSoroban);

    const result = await service.resolveDispute("esc-1");
    expect(result.status).toBe("resolved");
  });

  it("resolveDispute throws when escrow is funded", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "funded")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.resolveDispute("esc-1")).rejects.toThrow(
      "Cannot resolve dispute for escrow in funded status"
    );
  });

  it("resolveDispute throws when escrow is already resolved", async () => {
    const repo = new InMemoryEscrowRepo();
    repo.seed([makeRecord("esc-1", "resolved")]);
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.resolveDispute("esc-1")).rejects.toThrow(
      "Cannot resolve dispute for escrow in resolved status"
    );
  });

  it("releaseEscrow throws when escrow not found", async () => {
    const repo = new InMemoryEscrowRepo();
    const service = new EscrowApiService(repo, stubSoroban);

    await expect(service.releaseEscrow("nonexistent")).rejects.toThrow(
      "Escrow nonexistent not found"
    );
  });
});
