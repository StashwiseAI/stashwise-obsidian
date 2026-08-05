// What the plugin remembers between syncs.
//
// Kept out of data.json deliberately: that file holds settings and the token
// and stays small enough to read on every settings-tab open, while this grows
// with the library. Persisted through vault.adapter, which works on mobile
// where node:fs does not exist.

export interface SaveEntry {
  path: string;
  /** Hash of the user zone as of the last sync. Drives the push back. */
  userZoneHash: string;
  lastSyncedAt: string;
  /** Set when the markers went missing, so we stop writing to this file. */
  detached?: boolean;
}

export interface EntityEntry {
  path: string;
  lastSyncedAt: string;
}

export interface SyncState {
  /** server_time from the last fully drained walk. Null means never synced. */
  cursor: string | null;
  lastFullReconcileAt: string | null;
  saves: Record<string, SaveEntry>;
  entities: Record<string, EntityEntry>;
}

export function emptyState(): SyncState {
  return { cursor: null, lastFullReconcileAt: null, saves: {}, entities: {} };
}

/** Minimal slice of Obsidian's DataAdapter, so this file stays testable. */
export interface StateAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class SyncStateStore {
  private state: SyncState = emptyState();

  constructor(
    private readonly adapter: StateAdapter,
    private readonly path: string,
  ) {}

  get current(): SyncState {
    return this.state;
  }

  async load(): Promise<SyncState> {
    try {
      if (!(await this.adapter.exists(this.path))) {
        this.state = emptyState();
        return this.state;
      }
      const parsed = JSON.parse(await this.adapter.read(this.path)) as Partial<SyncState>;
      this.state = {
        cursor: parsed.cursor ?? null,
        lastFullReconcileAt: parsed.lastFullReconcileAt ?? null,
        saves: parsed.saves ?? {},
        entities: parsed.entities ?? {},
      };
    } catch {
      // A corrupt state file must not brick the plugin. Starting from empty
      // costs one full resync, which is recoverable; refusing to load is not.
      this.state = emptyState();
    }
    return this.state;
  }

  async save(): Promise<void> {
    await this.adapter.write(this.path, JSON.stringify(this.state, null, 2));
  }

  recordSave(id: string, entry: SaveEntry): void {
    this.state.saves[id] = entry;
  }

  recordEntity(id: string, entry: EntityEntry): void {
    this.state.entities[id] = entry;
  }

  forgetSave(id: string): void {
    delete this.state.saves[id];
  }

  forgetEntity(id: string): void {
    delete this.state.entities[id];
  }

  setCursor(cursor: string | null): void {
    this.state.cursor = cursor;
  }

  markFullReconcile(at: string): void {
    this.state.lastFullReconcileAt = at;
  }
}

/**
 * Ids the vault has but the server no longer does.
 *
 * `contents` has no soft-delete column, so a removal is invisible to any
 * cursor. Set difference against the manifest is the only signal there is.
 */
export function deletedIds(known: string[], live: string[]): string[] {
  const alive = new Set(live);
  return known.filter((id) => !alive.has(id));
}

/**
 * Whether a full reconcile is due.
 *
 * The manifest is every id the user owns, which is far too large to fetch on
 * every tick of a 15-minute timer, so deletions are reconciled roughly daily.
 */
export function needsFullReconcile(
  lastAt: string | null,
  now: number,
  intervalMs = 24 * 60 * 60 * 1000,
): boolean {
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  if (Number.isNaN(last)) return true;
  return now - last >= intervalMs;
}
