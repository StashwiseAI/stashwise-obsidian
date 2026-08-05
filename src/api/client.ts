// Typed HTTP client for the Stashwise backend.
//
// Ported from stashwise-cli/src/api.ts, with one deliberate difference: the
// transport is injected rather than imported. Obsidian supplies `requestUrl`
// as an external module at runtime, so importing it here would make this file
// unresolvable under vitest. Injection keeps the client a pure unit and leaves
// main.ts as the single place that knows about the Obsidian API.

import type {
  AgentSearchResponse,
  AgentSyncResponse,
  AgentTokenListResponse,
  DeviceCodePollResponse,
  DeviceCodeStartResponse,
  SearchScope,
  StashwiseUser,
  SyncContent,
} from "./types.js";

export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface TransportResponse {
  status: number;
  text: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Parsed `detail` from a FastAPI error body, when there is one. */
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Pull a human-readable message out of a FastAPI error body.
 *
 * The backend answers a hit save cap with a structured `detail` built by
 * `save_limit_detail`. Surfacing that text verbatim matters: free agent tokens
 * hard stop at the cap while paid ones fall through to raw saves, and only the
 * server knows which case a given token is in.
 */
export function describeApiError(status: number, rawBody: string): ApiError {
  let detail: unknown;
  try {
    const parsed = JSON.parse(rawBody) as { detail?: unknown };
    detail = parsed?.detail;
  } catch {
    // Not JSON (a proxy error page, an empty body). Fall through to the raw text.
  }

  if (typeof detail === "string" && detail.trim()) {
    return new ApiError(status, detail, detail);
  }
  if (detail && typeof detail === "object") {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return new ApiError(status, message, detail);
    }
    return new ApiError(status, JSON.stringify(detail), detail);
  }
  return new ApiError(status, rawBody.trim() || `HTTP ${status}`);
}

export class StashwiseApi {
  constructor(
    private readonly transport: Transport,
    private readonly getBaseUrl: () => string,
  ) {}

  private async request<T>(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      query?: Record<string, string | number | boolean | null | undefined>;
    } = {},
  ): Promise<T> {
    const { method = "GET", token, body, query } = options;
    if (query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) path = `${path}?${qs}`;
    }
    const base = this.getBaseUrl().replace(/\/$/, "");
    const res = await this.transport({
      url: `${base}${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (res.status >= 400) {
      throw describeApiError(res.status, res.text);
    }
    if (res.status === 204 || !res.text) {
      return undefined as T;
    }
    return JSON.parse(res.text) as T;
  }

  /**
   * Begin a pairing.
   *
   * `client_kind` is what lets the authorize page name this client. Without it
   * the backend defaults to "cli" and the page greets an Obsidian user with
   * "Authorize the Stashwise CLI" and "Return to your terminal", which is
   * nonsense on a phone. It is presentational only: the backend's
   * `principal_for_client_kind` treats everything that is not the extension as
   * an agent, so the save policy is identical to the CLI's either way.
   */
  startDeviceCode(clientLabel: string): Promise<DeviceCodeStartResponse> {
    return this.request<DeviceCodeStartResponse>("/auth/cli/start", {
      method: "POST",
      body: { client_label: clientLabel, client_kind: "obsidian" },
    });
  }

  pollDeviceCode(deviceCode: string): Promise<DeviceCodePollResponse> {
    return this.request<DeviceCodePollResponse>("/auth/cli/poll", {
      method: "POST",
      body: { device_code: deviceCode },
    });
  }

  me(token: string): Promise<StashwiseUser> {
    return this.request<StashwiseUser>("/auth/me", { token });
  }

  search(
    token: string,
    query: string,
    k: number,
    scope: SearchScope,
  ): Promise<AgentSearchResponse> {
    return this.request<AgentSearchResponse>("/agent/search", {
      method: "POST",
      token,
      body: { query, k, scope },
    });
  }

  /** One page of the mirror feed. See flow-app routers/agent.py agent_sync. */
  sync(
    token: string,
    options: {
      since?: string | null;
      cursor?: string | null;
      limit?: number;
      scope?: SearchScope;
      includeManifest?: boolean;
    } = {},
  ): Promise<AgentSyncResponse> {
    return this.request<AgentSyncResponse>("/agent/sync", {
      token,
      query: {
        since: options.since ?? undefined,
        cursor: options.cursor ?? undefined,
        limit: options.limit ?? 100,
        scope: options.scope ?? "all",
        include_manifest: options.includeManifest ?? false,
      },
    });
  }

  /** Append or replace the user's note layer on an existing item. */
  updateContentNote(
    token: string,
    contentId: string,
    note: string,
    mode: "append" | "replace" = "replace",
  ): Promise<unknown> {
    return this.request<unknown>(
      `/agent/content/${encodeURIComponent(contentId)}/notes`,
      { method: "POST", token, body: { note, mode } },
    );
  }

  /** Create a new Library item from a note written in the vault. */
  createNote(
    token: string,
    body: {
      title: string;
      body: string;
      summary?: string | null;
      tags?: string[] | null;
      include_in_wiki?: boolean;
    },
  ): Promise<{ content: SyncContent }> {
    return this.request<{ content: SyncContent }>("/agent/notes", {
      method: "POST",
      token,
      body,
    });
  }

  /**
   * Save a URL the ordinary way, through the same path the web app uses.
   * Note this is /content, not /agent/content: there is no agent-specific
   * URL save, and reusing the real one keeps quota and platform allow-list
   * behaviour identical to a save made anywhere else.
   */
  saveUrl(
    token: string,
    url: string,
    categoryId?: string | null,
  ): Promise<SyncContent> {
    return this.request<SyncContent>("/content", {
      method: "POST",
      token,
      body: { source_url: url, category_id: categoryId ?? null },
    });
  }

  listAgentTokens(token: string): Promise<AgentTokenListResponse> {
    return this.request<AgentTokenListResponse>("/auth/me/agent-tokens", { token });
  }

  revokeAgentToken(token: string, tokenId: string): Promise<void> {
    return this.request<void>(
      `/auth/me/agent-tokens/${encodeURIComponent(tokenId)}`,
      { method: "DELETE", token },
    );
  }
}

/**
 * Recreate the backend's `visible_prefix`: the 8 characters after `sw_at_`.
 *
 * Lets Disconnect revoke exactly this vault's token. Matching on the human
 * label instead would revoke another machine's token whenever two vaults
 * happen to share a name.
 *
 * Source of truth: flow-app `services/agent_token_service.py:46`.
 */
export function visibleTokenPrefix(rawToken: string): string {
  const AGENT_TOKEN_PREFIX = "sw_at_";
  const secret = rawToken.startsWith(AGENT_TOKEN_PREFIX)
    ? rawToken.slice(AGENT_TOKEN_PREFIX.length)
    : rawToken;
  return secret.slice(0, 8);
}
