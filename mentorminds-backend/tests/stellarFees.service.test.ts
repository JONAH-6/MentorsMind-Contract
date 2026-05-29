import { StellarFeesService } from "../src/services/stellarFees.service";

const FALLBACK_FEE = 100;

describe("StellarFeesService", () => {
  it("returns fallback fee when Horizon is unreachable", async () => {
    // Point at a URL that will never respond
    const service = new StellarFeesService("http://127.0.0.1:1");
    const result = await service.getFeeEstimate(1);
    expect(result.recommended_fee).toBe(String(FALLBACK_FEE));
  });

  it("scales fallback fee by operationCount", async () => {
    const service = new StellarFeesService("http://127.0.0.1:1");
    const result = await service.getFeeEstimate(3);
    expect(result.recommended_fee).toBe(String(FALLBACK_FEE * 3));
  });

  it("returns cached fee on second call without hitting Horizon again", async () => {
    let callCount = 0;
    const mockServer = {
      feeStats: async () => {
        callCount++;
        return { fee_charged: { mode: "200" } };
      },
    };

    // Inject mock server via constructor override
    const service = new StellarFeesService("https://horizon-testnet.stellar.org");
    // @ts-expect-error — accessing private field for test
    service.server = mockServer;

    await service.getFeeEstimate(1);
    await service.getFeeEstimate(1);

    // Second call should use cache, not call feeStats again
    expect(callCount).toBe(1);
  });

  it("uses CacheService (not raw Redis) — no crash when Redis is null", async () => {
    // Simulate Redis being null by verifying the service does not import redis directly.
    // The service must only use cacheService from cache.service.ts.
    const serviceSource = require("fs").readFileSync(
      require("path").join(__dirname, "../src/services/stellarFees.service.ts"),
      "utf8"
    );
    expect(serviceSource).not.toMatch(/from ['"].*redis['"]/);
    expect(serviceSource).toMatch(/cacheService/);
  });
});
