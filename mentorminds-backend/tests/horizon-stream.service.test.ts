import { HorizonStreamService } from "../src/services/horizon-stream.service";
import { paymentTrackerService } from "../src/services/payment-tracker.service";

jest.mock("../src/services/payment-tracker.service", () => ({
  paymentTrackerService: { findPending: jest.fn() },
}));
jest.mock("../src/services/event-indexer.service", () => ({
  eventIndexerService: { getCursorState: jest.fn(), saveEvent: jest.fn(), updateCursorState: jest.fn() },
}));

describe("HorizonStreamService", () => {
  const originalPlatform = process.env.PLATFORM_STELLAR_ACCOUNT;
  const originalExtra = process.env.HORIZON_PLATFORM_EXTRA_ACCOUNTS;

  afterEach(() => {
    if (originalPlatform === undefined) {
      delete process.env.PLATFORM_STELLAR_ACCOUNT;
    } else {
      process.env.PLATFORM_STELLAR_ACCOUNT = originalPlatform;
    }
    if (originalExtra === undefined) {
      delete process.env.HORIZON_PLATFORM_EXTRA_ACCOUNTS;
    } else {
      process.env.HORIZON_PLATFORM_EXTRA_ACCOUNTS = originalExtra;
    }
  });

  it("buildEventsUrl omits account filter when no account is passed", () => {
    const service = new HorizonStreamService();
    const url = service.buildEventsUrl("99");

    expect(url).toContain("/events?");
    expect(url).toContain("type=contract");
    expect(url).toContain("cursor=99");
    expect(url).not.toContain("account=");
  });

  it("buildEventsUrl includes account when scoping to platform ingress", () => {
    const service = new HorizonStreamService();
    const url = service.buildEventsUrl("100", "GPLATFORMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

    expect(url).toContain("cursor=100");
    expect(url).toContain(
      "account=GPLATFORMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
    );
  });

  it("getPlatformAccounts returns primary then extras, deduped", () => {
    process.env.PLATFORM_STELLAR_ACCOUNT = "GAAA";
    process.env.HORIZON_PLATFORM_EXTRA_ACCOUNTS = " GBBB , GAAA ,GCC ";

    const service = new HorizonStreamService();
    expect(service.getPlatformAccounts()).toEqual(["GAAA", "GBBB", "GCC"]);
  });
});

describe("HorizonStreamService.processPaymentOperation — amount matching (#199)", () => {
  const service = new HorizonStreamService();
  const mockFindPending = paymentTrackerService.findPending as jest.Mock;

  const basePending = {
    id: "p1",
    senderAddress: "GSENDER",
    receiverAddress: "GRECEIVER",
    status: "pending" as const,
    txHash: null,
    amount: "100",
    assetCode: "XLM",
    fee: null,
    ledgerSequence: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ["100.0000000", "Stellar 7-decimal format matches DB integer string"],
    ["100.00",      "2-decimal format matches"],
    ["100",         "exact match"],
    ["99.9999999",  "within tolerance"],
  ])("amount %s — %s", async (stellarAmount) => {
    mockFindPending.mockResolvedValue([basePending]);
    // Should NOT call alertOnLargeIncomingTransaction (no console.warn)
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await service.processPaymentOperation(
      { from: "GSENDER", to: "GRECEIVER", amount: stellarAmount, asset: "XLM" },
      "GRECEIVER"
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("mismatched amount triggers large-payment alert", async () => {
    mockFindPending.mockResolvedValue([{ ...basePending, amount: "200" }]);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // Use an amount above the default threshold (10000) to trigger the alert
    await service.processPaymentOperation(
      { from: "GSENDER", to: "GRECEIVER", amount: "15000.0000000", asset: "XLM" },
      "GRECEIVER"
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ALERT"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });
});
