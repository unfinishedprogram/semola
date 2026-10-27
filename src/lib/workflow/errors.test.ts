import { describe, expect, test } from "bun:test";
import { InvalidStepFailureError, StepFailure } from "./errors.js";

describe("StepFailure", () => {
  test("defaults retryable to false", () => {
    const failure = new StepFailure({ code: "Declined", message: "declined" });

    expect(failure.retryable).toBe(false);
  });

  test("keeps code, retry choice and details", () => {
    const failure = new StepFailure({
      code: "RateLimited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 25,
      details: { orderId: "o_1" },
    });

    expect(failure.code).toBe("RateLimited");
    expect(failure.message).toBe("slow down");
    expect(failure.retryable).toBe(true);
    expect(failure.retryAfterMs).toBe(25);
    expect(failure.details).toEqual({ orderId: "o_1" });
  });

  test.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects retryAfterMs %p", (retryAfterMs) => {
    const create = () =>
      new StepFailure({ code: "RateLimited", message: "x", retryAfterMs });

    expect(create).toThrow(InvalidStepFailureError);
  });

  test("rejects details that are not JSON-serializable", () => {
    const create = () =>
      new StepFailure({
        code: "Broken",
        message: "bad details",
        details: { big: 10n } as never,
      });

    expect(create).toThrow(InvalidStepFailureError);
  });
});
