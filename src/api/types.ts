// Wire types for the Stashwise backend. Mirrors stashwise-cli/src/api.ts so
// the two clients stay recognisably the same shape; only the transport differs.

export interface DeviceCodeStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface StashwiseUser {
  id: string;
  email: string | null;
  display_name: string | null;
  subscription_tier: string;
}

export interface DeviceCodePollResponse {
  status: "pending" | "authorized" | "expired";
  token?: string;
  user?: StashwiseUser;
}

export type SearchScope = "library" | "wiki" | "all";

export type AgentResultKind = "content" | "entity";

export interface AgentSearchResultItem {
  kind: AgentResultKind;
  id: string;
  title: string;
  snippet: string;
  source_url: string | null;
  source_platform: string | null;
  score: number;
  /** Pre-formatted by the backend. Render it, never rebuild it. */
  citation: string;
  saved_at: string | null;
}

export interface AgentSearchResponse {
  results: AgentSearchResultItem[];
  query: string;
  retrieval_ms: number;
}

export interface AgentTokenListItem {
  id: string;
  label: string;
  scopes: string;
  /** First 8 chars of the secret. Enough to identify a token, not to use it. */
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AgentTokenListResponse {
  items: AgentTokenListItem[];
}

export interface Takeaway {
  text: string;
  timestamp: string | null;
}

/** The subset of ContentResponse a vault note is built from. */
export interface SyncContent {
  id: string;
  title: string | null;
  source_url: string;
  source_platform: string;
  summary: string | null;
  /** Preferred over `summary` when present; see the enrichment redesign. */
  summary_core_markdown: string | null;
  takeaways: Takeaway[] | null;
  tags: string[];
  personal_notes: string | null;
  category_id: string | null;
  status: string;
  /** "raw" means saved past the free cap without AI processing. */
  analysis_state: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SyncEntityRelated {
  id: string;
  name: string;
  label: string;
}

export interface SyncEntitySource {
  content_id: string;
  title: string | null;
  source_url: string | null;
}

export interface SyncEntity {
  id: string;
  name: string;
  category: string;
  canonical_form: string | null;
  summary: string | null;
  mention_count: number;
  version: number;
  updated_at: string;
  related: SyncEntityRelated[];
  sources: SyncEntitySource[];
}

export interface SyncManifest {
  content_ids: string[];
  entity_ids: string[];
}

export interface AgentSyncResponse {
  /** Becomes the client's next `since`. Captured before the query ran. */
  server_time: string;
  items: SyncContent[];
  entities: SyncEntity[];
  /** Opaque keyset position. Hand it back verbatim for the next page. */
  next_cursor: string | null;
  has_more: boolean;
  manifest: SyncManifest | null;
}
