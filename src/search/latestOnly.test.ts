import { describe, expect, it } from "vitest";
import { createLatestOnly } from "./latestOnly.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLatestOnly", () => {
  it("passes through a lone result", async () => {
    const run = createLatestOnly<string>();
    await expect(run(Promise.resolve("agents"))).resolves.toBe("agents");
  });

  it("discards a slow earlier response that lands after a faster later one", async () => {
    // The exact shape of the bug: "ag" is issued first but resolves last.
    const run = createLatestOnly<string>();
    const slow = deferred<string>();
    const fast = deferred<string>();

    const first = run(slow.promise);
    const second = run(fast.promise);

    fast.resolve("agents");
    await expect(second).resolves.toBe("agents");

    slow.resolve("ag");
    await expect(first).resolves.toBeNull();
  });

  it("keeps the newest result even when responses arrive in order", async () => {
    const run = createLatestOnly<number>();
    const a = deferred<number>();
    const b = deferred<number>();

    const first = run(a.promise);
    const second = run(b.promise);

    a.resolve(1);
    b.resolve(2);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe(2);
  });

  it("still rejects on a real failure rather than swallowing it as superseded", async () => {
    const run = createLatestOnly<string>();
    await expect(run(Promise.reject(new Error("offline")))).rejects.toThrow("offline");
  });
});
