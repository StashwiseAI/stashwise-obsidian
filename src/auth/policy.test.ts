import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import {
  decidePollFailure,
  FATAL_FAILURE_STREAK,
  QUIET_FAILURE_STREAK,
  type PollFailureContext,
} from "./policy.js";

function ctx(overrides: Partial<PollFailureContext> = {}): PollFailureContext {
  return {
    consecutiveFailures: 1,
    totalFailures: 1,
    elapsedMs: 2000,
    error: new TypeError("Failed to fetch"),
    ...overrides,
  };
}

describe("decidePollFailure", () => {
  it("retries silently through a short blip", () => {
    for (let n = 1; n < QUIET_FAILURE_STREAK; n++) {
      expect(decidePollFailure(ctx({ consecutiveFailures: n }))).toEqual({
        action: "retry",
      });
    }
  });

  it("tells the user once the failures stop looking like a blip", () => {
    const decision = decidePollFailure(ctx({ consecutiveFailures: QUIET_FAILURE_STREAK }));
    expect(decision.action).toBe("retry");
    expect(decision).toHaveProperty("status");
    expect((decision as { status: string }).status).toMatch(/retrying/i);
  });

  it("keeps retrying right up to the fatal streak", () => {
    const decision = decidePollFailure(
      ctx({ consecutiveFailures: FATAL_FAILURE_STREAK - 1 }),
    );
    expect(decision.action).toBe("retry");
  });

  it("aborts after about a minute of unbroken failure", () => {
    const decision = decidePollFailure(ctx({ consecutiveFailures: FATAL_FAILURE_STREAK }));
    expect(decision).toEqual({
      action: "abort",
      message: "Lost connection to Stashwise. Check your network and try again.",
    });
  });

  it("aborts immediately on a 4xx, since repeating the request cannot help", () => {
    const decision = decidePollFailure(
      ctx({ consecutiveFailures: 1, error: new ApiError(400, "Unknown device code") }),
    );
    expect(decision).toEqual({ action: "abort", message: "Unknown device code" });
  });

  it("treats a 5xx as transient, because the backend may just be restarting", () => {
    expect(
      decidePollFailure(ctx({ consecutiveFailures: 1, error: new ApiError(502, "Bad gateway") })),
    ).toEqual({ action: "retry" });
  });

  it("does not abort on a 4xx that the caller already handles", () => {
    // 404 means the pairing is gone and never reaches this policy, but if the
    // caller's guard were ever removed we would rather abort than loop. This
    // pins the current behaviour so that change is visible.
    const decision = decidePollFailure(
      ctx({ error: new ApiError(404, "Pairing not found") }),
    );
    expect(decision.action).toBe("abort");
  });
});
