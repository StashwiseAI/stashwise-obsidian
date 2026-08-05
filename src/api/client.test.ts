import { describe, expect, it } from "vitest";
import {
  ApiError,
  describeApiError,
  StashwiseApi,
  type Transport,
  type TransportRequest,
} from "./client.js";

function recordingTransport(
  responses: Array<{ status: number; text: string }>,
): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  let i = 0;
  const transport: Transport = async (req) => {
    calls.push(req);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { transport, calls };
}

describe("describeApiError", () => {
  it("surfaces a string FastAPI detail verbatim", () => {
    const err = describeApiError(
      402,
      JSON.stringify({ detail: "You have used all 5 free saves this month." }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(402);
    expect(err.message).toBe("You have used all 5 free saves this month.");
  });

  it("prefers detail.message when the detail is a structured save-limit object", () => {
    // save_limit_detail returns an object, not a string. Losing its message is
    // exactly the failure this function exists to prevent.
    const body = JSON.stringify({
      detail: { message: "Free agents stop at the cap.", used: 5, limit: 5, reason: "analyzed_cap" },
    });
    const err = describeApiError(402, body);
    expect(err.message).toBe("Free agents stop at the cap.");
    expect((err.detail as { reason: string }).reason).toBe("analyzed_cap");
  });

  it("falls back to raw text when the body is not JSON", () => {
    const err = describeApiError(502, "<html>Bad Gateway</html>");
    expect(err.message).toBe("<html>Bad Gateway</html>");
  });

  it("falls back to the status code when the body is empty", () => {
    expect(describeApiError(500, "").message).toBe("HTTP 500");
  });
});

describe("StashwiseApi", () => {
  const base = () => "https://stashwise-api.fly.dev/api/v1";

  it("sends a bearer token only when one is given", async () => {
    const { transport, calls } = recordingTransport([
      { status: 200, text: JSON.stringify({ results: [], query: "x", retrieval_ms: 1 }) },
    ]);
    const api = new StashwiseApi(transport, base);

    await api.search("tok_123", "agents", 5, "all");
    expect(calls[0].headers.Authorization).toBe("Bearer tok_123");

    await api.startDeviceCode("Stashwise for Obsidian (Vault)");
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  it("identifies itself as obsidian so the authorize page can name it", async () => {
    // Without this the backend defaults to "cli" and the page tells the user to
    // return to a terminal they never opened.
    const { transport, calls } = recordingTransport([{ status: 200, text: "{}" }]);
    const api = new StashwiseApi(transport, base);

    await api.startDeviceCode("Stashwise for Obsidian (My Vault)");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      client_label: "Stashwise for Obsidian (My Vault)",
      client_kind: "obsidian",
    });
  });

  it("builds URLs against the configured base and tolerates a trailing slash", async () => {
    const { transport, calls } = recordingTransport([{ status: 200, text: "{}" }]);
    const api = new StashwiseApi(transport, () => "http://127.0.0.1:8000/api/v1/");

    await api.me("tok");
    expect(calls[0].url).toBe("http://127.0.0.1:8000/api/v1/auth/me");
  });

  it("serialises the search body the backend expects", async () => {
    const { transport, calls } = recordingTransport([
      { status: 200, text: JSON.stringify({ results: [], query: "q", retrieval_ms: 0 }) },
    ]);
    const api = new StashwiseApi(transport, base);

    await api.search("tok", "agent memory", 8, "wiki");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      query: "agent memory",
      k: 8,
      scope: "wiki",
    });
    expect(calls[0].method).toBe("POST");
  });

  it("throws an ApiError carrying the status for a 4xx", async () => {
    const { transport } = recordingTransport([
      { status: 401, text: JSON.stringify({ detail: "Not authenticated" }) },
    ]);
    const api = new StashwiseApi(transport, base);

    await expect(api.me("stale")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "Not authenticated",
    });
  });

  it("returns undefined for a 204 rather than trying to parse an empty body", async () => {
    const { transport } = recordingTransport([{ status: 204, text: "" }]);
    const api = new StashwiseApi(transport, base);

    await expect(api.me("tok")).resolves.toBeUndefined();
  });
});
