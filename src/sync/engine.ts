// One sync run: push local edits, drain the feed, reconcile deletions.
//
// The Obsidian vault sits behind `VaultIO` so the whole algorithm can be
// exercised against an in-memory fake. This is the file where an ordering
// mistake quietly loses a user's writing, so it needs to be testable without
// launching Obsidian.

import type { StashwiseApi } from "../api/client.js";
import type { SearchScope, SyncContent, SyncEntity } from "../api/types.js";
import {
  BEGIN_MARKER,
  composeNote,
  hashUserZone,
  parseNote,
  seedUserZone,
} from "./managedBlock.js";
import { entityFileName, saveFileName, vaultPath } from "./paths.js";
import { renderEntityBody, renderEntityFrontmatter } from "./renderEntity.js";
import { renderSaveBody, renderSaveFrontmatter } from "./renderSave.js";
import {
  deletedIds,
  needsFullReconcile,
  type SyncStateStore,
} from "./state.js";

export interface VaultIO {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface SyncOptions {
  token: string;
  root: string;
  scope: SearchScope;
  deleteRemovedItems: boolean;
  /** Ignore the stored cursor and rebuild from scratch. */
  full?: boolean;
  now?: number;
}

export interface SyncReport {
  savesWritten: number;
  entitiesWritten: number;
  notesPushed: number;
  detached: number;
  deleted: number;
  errors: string[];
}

const PAGE_LIMIT = 100;
/** A runaway feed should stop the plugin, not spin forever against the API. */
const MAX_PAGES = 200;

export class SyncEngine {
  constructor(
    private readonly api: StashwiseApi,
    private readonly vault: VaultIO,
    private readonly store: SyncStateStore,
  ) {}

  async run(options: SyncOptions): Promise<SyncReport> {
    const report: SyncReport = {
      savesWritten: 0,
      entitiesWritten: 0,
      notesPushed: 0,
      detached: 0,
      deleted: 0,
      errors: [],
    };
    const now = options.now ?? Date.now();
    const state = this.store.current;

    // Push before pull, always. If a local edit went up after the feed was
    // read, the response would carry the pre-edit personal_notes and the very
    // next write would stamp the user's own words back to the older version.
    await this.pushUserZones(options, report);

    const savesFolder = vaultPath(options.root, "Saves");
    const topicsFolder = vaultPath(options.root, "Topics");
    if (options.scope !== "wiki") await this.vault.ensureFolder(savesFolder);
    if (options.scope !== "library") await this.vault.ensureFolder(topicsFolder);

    const fullReconcile =
      options.full || needsFullReconcile(state.lastFullReconcileAt, now);
    const since = options.full ? null : state.cursor;

    let cursor: string | null = null;
    let serverTime: string | null = null;
    let manifest: { content_ids: string[]; entity_ids: string[] } | null = null;

    // Seed from filenames already owned, not an empty set. Tracked entities
    // keep their recorded path and never re-derive a name, so anything in here
    // is a slug some other entity holds. Starting empty let a new entity on a
    // later sync claim a name a tracked one already had, after which the two
    // overwrote each other every run. slugify strips non-ASCII, so every
    // CJK-named topic collapses to "untitled" and the collision surface is wide.
    const takenEntitySlugs = new Set<string>(
      Object.values(state.entities).map((entry) =>
        entry.path.split("/").pop()!.replace(/\.md$/, ""),
      ),
    );

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.api.sync(options.token, {
        since,
        cursor,
        limit: PAGE_LIMIT,
        scope: options.scope,
        includeManifest: fullReconcile,
      });
      serverTime = response.server_time;

      for (const item of response.items) {
        await this.writeSave(item, savesFolder, now, report);
      }
      for (const entity of response.entities) {
        await this.writeEntity(
          entity,
          topicsFolder,
          takenEntitySlugs,
          now,
          report,
        );
      }
      if (response.manifest) manifest = response.manifest;

      if (!response.has_more) break;
      cursor = response.next_cursor;
      if (!cursor) break; // defensive: has_more without a cursor would loop
    }

    if (manifest) {
      await this.reconcileDeletions(manifest, options, report);
      this.store.markFullReconcile(new Date(now).toISOString());
    }

    // Only advance the cursor after the walk completed. A throw above leaves
    // it where it was, so the next run re-reads the same window rather than
    // stepping over whatever it missed.
    if (serverTime) this.store.setCursor(serverTime);
    await this.store.save();
    return report;
  }

  /**
   * Send user-zone edits up before reading the feed, and audit every note.
   *
   * This is also where detachment is detected, which matters more than it
   * looks. `writeSave` only runs for items the feed returns, so on an
   * incremental sync a note the user broke is never examined: the cursor has
   * long since moved past an item nobody changed upstream. The file stays
   * safe, but the user is never told it has stopped updating. This loop walks
   * every tracked note on every run, so it is the only place that can notice.
   */
  private async pushUserZones(
    options: SyncOptions,
    report: SyncReport,
  ): Promise<void> {
    for (const [id, entry] of Object.entries(this.store.current.saves)) {
      try {
        if (!(await this.vault.exists(entry.path))) continue;
        const parsed = parseNote(await this.vault.read(entry.path));

        if (parsed.status !== "ok") {
          // Only count it the first time, so a note left broken for weeks does
          // not nag on every single sync.
          if (!entry.detached) {
            entry.detached = true;
            report.detached += 1;
          }
          continue;
        }
        // Markers are back. A repaired note is an ordinary note again.
        if (entry.detached) delete entry.detached;

        const hash = hashUserZone(parsed.parsed.userZone);
        if (hash === entry.userZoneHash) continue;

        const note = parsed.parsed.userZone.trim();
        if (note) {
          // "replace": the vault zone is the whole of the user's note layer,
          // so appending would duplicate it a little more on every sync.
          await this.api.updateContentNote(options.token, id, note, "replace");
          report.notesPushed += 1;
        }
        entry.userZoneHash = hash;
      } catch (error) {
        report.errors.push(`Push ${entry.path}: ${describe(error)}`);
      }
    }
  }

  private async writeSave(
    item: SyncContent,
    folder: string,
    now: number,
    report: SyncReport,
  ): Promise<void> {
    const existing = this.store.current.saves[item.id];
    const path = existing?.path ?? vaultPath(folder, saveFileName(item.title, item.id));

    try {
      const frontmatter = renderSaveFrontmatter(item);
      const body = renderSaveBody(item);

      let userZone = "";
      if (await this.vault.exists(path)) {
        const parsed = parseNote(await this.vault.read(path));
        if (parsed.status !== "ok") {
          // The markers are gone or ambiguous. Writing would mean guessing
          // where the user's text begins, so leave the file completely alone
          // and report it instead.
          this.store.recordSave(item.id, {
            path,
            userZoneHash: existing?.userZoneHash ?? "",
            lastSyncedAt: new Date(now).toISOString(),
            detached: true,
          });
          // pushUserZones walks every tracked note first and may already have
          // counted this one. Counting again would report two broken notes
          // when there is one.
          if (!existing?.detached) report.detached += 1;
          return;
        }
        userZone = parsed.parsed.userZone;
      } else if (item.personal_notes) {
        // First write for an item that already has notes in Stashwise: seed
        // the user zone from them so the two sides start in agreement.
        userZone = seedUserZone(item.personal_notes);
      }

      await this.vault.write(path, composeNote({ frontmatter, managed: body, userZone }));
      this.store.recordSave(item.id, {
        path,
        userZoneHash: hashUserZone(userZone),
        lastSyncedAt: new Date(now).toISOString(),
      });
      report.savesWritten += 1;
    } catch (error) {
      report.errors.push(`Write ${path}: ${describe(error)}`);
    }
  }

  private async writeEntity(
    entity: SyncEntity,
    folder: string,
    taken: Set<string>,
    now: number,
    report: SyncReport,
  ): Promise<void> {
    const existing = this.store.current.entities[entity.id];
    const path =
      existing?.path ?? vaultPath(folder, entityFileName(entity.name, entity.id, taken));

    try {
      const frontmatter = renderEntityFrontmatter(entity);
      const body = renderEntityBody(entity);

      let userZone = "";
      if (await this.vault.exists(path)) {
        const parsed = parseNote(await this.vault.read(path));
        if (parsed.status !== "ok") {
          report.detached += 1;
          return;
        }
        userZone = parsed.parsed.userZone;
      }

      await this.vault.write(path, composeNote({ frontmatter, managed: body, userZone }));
      this.store.recordEntity(entity.id, {
        path,
        lastSyncedAt: new Date(now).toISOString(),
      });
      report.entitiesWritten += 1;
    } catch (error) {
      report.errors.push(`Write ${path}: ${describe(error)}`);
    }
  }

  private async reconcileDeletions(
    manifest: { content_ids: string[]; entity_ids: string[] },
    options: SyncOptions,
    report: SyncReport,
  ): Promise<void> {
    const state = this.store.current;

    const goneSaves =
      options.scope === "wiki"
        ? []
        : deletedIds(Object.keys(state.saves), manifest.content_ids);
    const goneEntities =
      options.scope === "library"
        ? []
        : deletedIds(Object.keys(state.entities), manifest.entity_ids);

    for (const id of goneSaves) {
      const entry = state.saves[id];
      await this.removeNote(entry.path, options, report);
      this.store.forgetSave(id);
    }
    for (const id of goneEntities) {
      const entry = state.entities[id];
      await this.removeNote(entry.path, options, report);
      this.store.forgetEntity(id);
    }
  }

  private async removeNote(
    path: string,
    options: SyncOptions,
    report: SyncReport,
  ): Promise<void> {
    if (!options.deleteRemovedItems) {
      // Off by default. The user may have written their own thinking below the
      // marker, and losing that to a deletion in the web app is not a trade
      // anyone opted into.
      return;
    }
    try {
      if (await this.vault.exists(path)) {
        await this.vault.trash(path);
        report.deleted += 1;
      }
    } catch (error) {
      report.errors.push(`Trash ${path}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Exported for the settings tab's "what will this touch" copy. */
export const MANAGED_REGION_MARKER = BEGIN_MARKER;
