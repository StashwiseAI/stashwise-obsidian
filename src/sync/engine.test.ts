// Full sync runs against an in-memory vault and a scripted API.
//
// These are the tests that matter most: they cover the ordering rules and the
// refuse-to-write rules that stand between a sync bug and someone's lost notes.

import { beforeEach, describe, expect, it } from "vitest";
import type { StashwiseApi } from "../api/client.js";
import type { AgentSyncResponse, SyncContent, SyncEntity } from "../api/types.js";
import { SyncEngine, type VaultIO } from "./engine.js";
import { BEGIN_MARKER, END_MARKER, parseNote } from "./managedBlock.js";
import { SyncStateStore, type StateAdapter } from "./state.js";

const NOW = Date.parse("2026-08-04T12:00:00Z");

class FakeVault implements VaultIO {
  files = new Map<string, string>();
  folders = new Set<string>();
  trashed: string[] = [];

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  }
  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
  async trash(path: string): Promise<void> {
    this.trashed.push(path);
    this.files.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value !== undefined) {
      this.files.set(to, value);
      this.files.delete(from);
    }
  }
}

class MemoryStateAdapter implements StateAdapter {
  store = new Map<string, string>();
  async read(path: string): Promise<string> {
    const value = this.store.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return value;
  }
  async write(path: string, data: string): Promise<void> {
    this.store.set(path, data);
  }
  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }
}

function save(overrides: Partial<SyncContent> = {}): SyncContent {
  return {
    id: "c1",
    title: "How agents remember",
    source_url: "https://example.com/agents",
    source_platform: "youtube",
    summary: "A summary.",
    summary_core_markdown: null,
    takeaways: null,
    tags: [],
    personal_notes: null,
    category_id: null,
    status: "completed",
    analysis_state: null,
    created_at: "2026-08-01T12:00:00+00:00",
    updated_at: "2026-08-03T09:11:00+00:00",
    ...overrides,
  };
}

function entity(overrides: Partial<SyncEntity> = {}): SyncEntity {
  return {
    id: "e1",
    name: "Agent memory",
    category: "concept",
    canonical_form: null,
    summary: "What it means.",
    mention_count: 3,
    version: 1,
    updated_at: "2026-08-03T09:11:00+00:00",
    related: [],
    sources: [],
    ...overrides,
  };
}

function page(overrides: Partial<AgentSyncResponse> = {}): AgentSyncResponse {
  return {
    server_time: "2026-08-04T12:00:00+00:00",
    items: [],
    entities: [],
    next_cursor: null,
    has_more: false,
    manifest: null,
    ...overrides,
  };
}

interface Harness {
  engine: SyncEngine;
  vault: FakeVault;
  store: SyncStateStore;
  calls: { syncs: unknown[]; notePushes: Array<[string, string, string]> };
}

function harness(pages: AgentSyncResponse[]): Harness {
  const vault = new FakeVault();
  const adapter = new MemoryStateAdapter();
  const store = new SyncStateStore(adapter, "state.json");
  const calls = { syncs: [] as unknown[], notePushes: [] as Array<[string, string, string]> };

  let i = 0;
  const api = {
    async sync(_token: string, options: unknown) {
      calls.syncs.push(options);
      return pages[Math.min(i++, pages.length - 1)];
    },
    async updateContentNote(
      _token: string,
      contentId: string,
      note: string,
      mode: string,
    ) {
      calls.notePushes.push([contentId, note, mode]);
      return {};
    },
  } as unknown as StashwiseApi;

  return { engine: new SyncEngine(api, vault, store), vault, store, calls };
}

const OPTIONS = {
  token: "sw_at_test",
  root: "Stashwise",
  scope: "all" as const,
  deleteRemovedItems: false,
  now: NOW,
};

describe("SyncEngine.run", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness([page({ items: [save()] })]);
  });

  it("writes a save into the Saves folder with a parseable structure", async () => {
    const report = await h.engine.run(OPTIONS);

    expect(report.savesWritten).toBe(1);
    const path = "Stashwise/Saves/how-agents-remember-c1.md";
    expect(h.vault.files.has(path)).toBe(true);

    const parsed = parseNote(await h.vault.read(path));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.parsed.managed).toContain("# How agents remember");
    expect(parsed.parsed.frontmatter).toContain("stashwise_id: c1");
  });

  it("preserves the user zone across a resync when the summary changes", async () => {
    await h.engine.run(OPTIONS);
    const path = "Stashwise/Saves/how-agents-remember-c1.md";

    // The user writes underneath.
    const withNotes = (await h.vault.read(path)).replace(
      /\n*$/,
      "\n## My notes\n\nThis is mine and must survive.",
    );
    await h.vault.write(path, withNotes);

    const second = harness([page({ items: [save({ summary: "A NEW summary." })] })]);
    second.vault.files = h.vault.files;
    second.store.recordSave("c1", {
      path,
      // Matches what is on disk, so no push is attempted in this test.
      userZoneHash: (await import("./managedBlock.js")).hashUserZone(
        "## My notes\n\nThis is mine and must survive.",
      ),
      lastSyncedAt: "2026-08-04T11:00:00Z",
    });
    await second.engine.run(OPTIONS);

    const text = await second.vault.read(path);
    expect(text).toContain("A NEW summary.");
    expect(text).toContain("This is mine and must survive.");
  });

  it("refuses to write and marks detached when a marker was deleted", async () => {
    await h.engine.run(OPTIONS);
    const path = "Stashwise/Saves/how-agents-remember-c1.md";

    // The user deletes the end marker, perhaps while tidying.
    const mangled = (await h.vault.read(path)).replace(END_MARKER, "");
    await h.vault.write(path, mangled);
    const before = mangled;

    const second = harness([page({ items: [save({ summary: "A NEW summary." })] })]);
    second.vault.files = h.vault.files;
    const report = await second.engine.run(OPTIONS);

    expect(report.detached).toBe(1);
    expect(report.savesWritten).toBe(0);
    // The critical assertion: the file was not touched at all.
    expect(await second.vault.read(path)).toBe(before);
    expect(second.store.current.saves["c1"].detached).toBe(true);
  });

  it("reports a broken note even when the feed returns nothing for it", async () => {
    // Regression, found while testing against real data. `detached` was only
    // ever set in writeSave, which runs for items the feed returns. On an
    // incremental sync the cursor is already past an untouched item, so a note
    // whose markers the user broke was opened, silently skipped, and never
    // flagged. The file stayed safe but the user was never told it had stopped
    // updating.
    const h2 = harness([page({ items: [] })]);
    const path = "Stashwise/Saves/broken-c1.md";
    h2.vault.files.set(
      path,
      // End marker deleted, exactly what a tidying user does.
      ["---", "stashwise_id: c1", "---", "", BEGIN_MARKER, "# Old", "", "My notes."].join("\n"),
    );
    h2.store.recordSave("c1", {
      path,
      userZoneHash: "whatever",
      lastSyncedAt: "2026-08-04T11:00:00Z",
    });

    const report = await h2.engine.run(OPTIONS);

    expect(report.detached).toBe(1);
    expect(h2.store.current.saves["c1"].detached).toBe(true);
    // And it must still not have been rewritten.
    expect(h2.vault.files.get(path)).toContain("My notes.");
    expect(h2.vault.files.get(path)).not.toContain(END_MARKER);
  });

  it("counts a broken note once, not once per code path", async () => {
    // pushUserZones flags it, then writeSave sees the same file again because
    // the feed happens to return that item. Counting twice would tell the user
    // two notes are broken when only one is.
    const h2 = harness([page({ items: [save()] })]);
    const path = "Stashwise/Saves/how-agents-remember-c1.md";
    h2.vault.files.set(path, [BEGIN_MARKER, "# Old", "", "Mine."].join("\n"));
    h2.store.recordSave("c1", {
      path,
      userZoneHash: "stale",
      lastSyncedAt: "2026-08-04T11:00:00Z",
    });

    const report = await h2.engine.run(OPTIONS);

    expect(report.detached).toBe(1);
  });

  it("does not try to push from a detached note", async () => {
    const h2 = harness([page({ items: [] })]);
    const path = "Stashwise/Saves/broken-c1.md";
    h2.vault.files.set(path, [BEGIN_MARKER, "# Old", "", "Mine."].join("\n"));
    h2.store.recordSave("c1", {
      path,
      userZoneHash: "stale",
      lastSyncedAt: "2026-08-04T11:00:00Z",
    });

    await h2.engine.run(OPTIONS);

    // Its user zone cannot be located, so there is nothing safe to send up.
    expect(h2.calls.notePushes).toHaveLength(0);
  });

  it("clears the detached flag once the user restores the markers", async () => {
    const h2 = harness([page({ items: [] })]);
    const path = "Stashwise/Saves/fixed-c1.md";
    h2.vault.files.set(
      path,
      ["---", "stashwise_id: c1", "---", "", BEGIN_MARKER, "# Old", END_MARKER, "", "Mine."].join("\n"),
    );
    h2.store.recordSave("c1", {
      path,
      userZoneHash: "stale",
      lastSyncedAt: "2026-08-04T11:00:00Z",
      detached: true,
    });

    const report = await h2.engine.run(OPTIONS);

    expect(report.detached).toBe(0);
    expect(h2.store.current.saves["c1"].detached).toBeFalsy();
    // A repaired note is a normal note again, so its edits flow once more.
    expect(h2.calls.notePushes).toHaveLength(1);
  });

  it("pushes a changed user zone before reading the feed", async () => {
    // Ordering matters: pulling first would return the pre-edit personal_notes
    // and the following write would stamp the user's words back to the old text.
    const path = "Stashwise/Saves/how-agents-remember-c1.md";
    const h2 = harness([page({ items: [save()] })]);
    h2.vault.files.set(
      path,
      ["---", "stashwise_id: c1", "---", "", BEGIN_MARKER, "# Old", END_MARKER, "", "My fresh thought."].join("\n"),
    );
    h2.store.recordSave("c1", {
      path,
      userZoneHash: "stale-hash",
      lastSyncedAt: "2026-08-04T11:00:00Z",
    });

    const report = await h2.engine.run(OPTIONS);

    expect(report.notesPushed).toBe(1);
    expect(h2.calls.notePushes[0][0]).toBe("c1");
    expect(h2.calls.notePushes[0][1]).toBe("My fresh thought.");
    // "replace", not "append": the vault zone is the whole note layer, so
    // appending would duplicate a little more of it on every single sync.
    expect(h2.calls.notePushes[0][2]).toBe("replace");
  });

  it("does not push when the user zone is unchanged", async () => {
    await h.engine.run(OPTIONS);
    const second = harness([page({ items: [save()] })]);
    second.vault.files = h.vault.files;
    second.store.recordSave("c1", h.store.current.saves["c1"]);

    const report = await second.engine.run(OPTIONS);
    expect(report.notesPushed).toBe(0);
  });

  it("seeds the user zone from personal_notes on the very first write", async () => {
    const h2 = harness([page({ items: [save({ personal_notes: "Noted in the app." })] })]);
    await h2.engine.run(OPTIONS);

    const text = await h2.vault.read("Stashwise/Saves/how-agents-remember-c1.md");
    expect(text).toContain("Noted in the app.");
  });

  it("drains every page of a multi-page walk", async () => {
    const h2 = harness([
      page({ items: [save({ id: "c1" })], has_more: true, next_cursor: "cur1" }),
      page({ items: [save({ id: "c2", title: "Second" })] }),
    ]);
    const report = await h2.engine.run(OPTIONS);

    expect(report.savesWritten).toBe(2);
    // The second request must carry the cursor the first one handed back.
    expect((h2.calls.syncs[1] as { cursor: string }).cursor).toBe("cur1");
  });

  it("stores server_time as the cursor for the next run", async () => {
    await h.engine.run(OPTIONS);
    expect(h.store.current.cursor).toBe("2026-08-04T12:00:00+00:00");
  });

  it("leaves the cursor alone when the walk throws, so nothing is stepped over", async () => {
    const failing = {
      async sync() {
        throw new Error("network down");
      },
    } as unknown as StashwiseApi;
    const store = new SyncStateStore(new MemoryStateAdapter(), "state.json");
    store.setCursor("2026-08-01T00:00:00Z");
    const engine = new SyncEngine(failing, new FakeVault(), store);

    await expect(engine.run(OPTIONS)).rejects.toThrow("network down");
    expect(store.current.cursor).toBe("2026-08-01T00:00:00Z");
  });

  it("passes the stored cursor as `since` on an incremental run", async () => {
    h.store.setCursor("2026-08-01T00:00:00Z");
    await h.engine.run(OPTIONS);
    expect((h.calls.syncs[0] as { since: string }).since).toBe("2026-08-01T00:00:00Z");
  });

  it("ignores the stored cursor on a full resync", async () => {
    h.store.setCursor("2026-08-01T00:00:00Z");
    await h.engine.run({ ...OPTIONS, full: true });
    expect((h.calls.syncs[0] as { since: string | null }).since).toBeNull();
  });

  it("never lets a new entity claim a filename an existing one already owns", async () => {
    // Regression, found against a real vault. The collision guard lived in a
    // Set built fresh per run, so it only knew slugs claimed during that run.
    // A new entity arriving on a later sync saw an empty Set, took the bare
    // slug a tracked entity already owned, and the two then overwrote each
    // other on every sync. Exposure is wide because slugify strips non-ASCII,
    // so every CJK-named topic collapses to "untitled".
    const h2 = harness([page({ entities: [entity({ id: "e2", name: "VAMP" })] })]);
    h2.store.recordEntity("e1", {
      path: "Stashwise/Topics/vamp.md",
      lastSyncedAt: "2026-08-04T11:00:00Z",
    });
    h2.vault.files.set("Stashwise/Topics/vamp.md", "the first entity's note");

    await h2.engine.run(OPTIONS);

    const paths = Object.values(h2.store.current.entities).map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(h2.store.current.entities["e2"].path).not.toBe("Stashwise/Topics/vamp.md");
  });

  it("keeps CJK-titled topics apart even though they all slug to untitled", async () => {
    const h2 = harness([
      page({
        entities: [
          entity({ id: "e1", name: "松露鳕鱼卷" }),
          entity({ id: "e2", name: "红烧肉" }),
          entity({ id: "e3", name: "宫保鸡丁" }),
        ],
      }),
    ]);

    await h2.engine.run(OPTIONS);

    const paths = Object.values(h2.store.current.entities).map((e) => e.path);
    expect(new Set(paths).size).toBe(3);
  });

  it("writes entity notes into Topics with wikilinks", async () => {
    const h2 = harness([
      page({
        entities: [
          entity({ related: [{ id: "e2", name: "Vector search", label: "relates_to" }] }),
        ],
      }),
    ]);
    const report = await h2.engine.run(OPTIONS);

    expect(report.entitiesWritten).toBe(1);
    const text = await h2.vault.read("Stashwise/Topics/agent-memory.md");
    expect(text).toContain("[[Vector search]]");
    expect(text).toContain("stashwise_type: topic");
  });
});

describe("deletion reconcile", () => {
  it("reports but does not delete when the setting is off", async () => {
    const h = harness([page({ items: [save()], manifest: { content_ids: [], entity_ids: [] } })]);
    h.store.recordSave("gone", {
      path: "Stashwise/Saves/gone-xxxx.md",
      userZoneHash: "",
      lastSyncedAt: "2026-08-01T00:00:00Z",
    });
    h.vault.files.set("Stashwise/Saves/gone-xxxx.md", "anything");

    const report = await h.engine.run(OPTIONS);

    expect(report.deleted).toBe(0);
    // Default off, because the user's own writing may live in that file.
    expect(h.vault.files.has("Stashwise/Saves/gone-xxxx.md")).toBe(true);
    expect(h.store.current.saves["gone"]).toBeUndefined();
  });

  it("trashes removed notes when the setting is on", async () => {
    const h = harness([page({ items: [], manifest: { content_ids: [], entity_ids: [] } })]);
    h.store.recordSave("gone", {
      path: "Stashwise/Saves/gone-xxxx.md",
      userZoneHash: "",
      lastSyncedAt: "2026-08-01T00:00:00Z",
    });
    h.vault.files.set("Stashwise/Saves/gone-xxxx.md", "anything");

    const report = await h.engine.run({ ...OPTIONS, deleteRemovedItems: true });

    expect(report.deleted).toBe(1);
    expect(h.vault.trashed).toEqual(["Stashwise/Saves/gone-xxxx.md"]);
  });

  it("keeps notes whose ids are still in the manifest", async () => {
    const h = harness([
      page({ items: [save()], manifest: { content_ids: ["c1"], entity_ids: [] } }),
    ]);
    const report = await h.engine.run({ ...OPTIONS, deleteRemovedItems: true });

    expect(report.deleted).toBe(0);
    expect(h.store.current.saves["c1"]).toBeDefined();
  });

  it("does not treat wiki-scope absence as a deleted save", async () => {
    // scope=wiki returns no content_ids at all. Reading that as "every save was
    // deleted" would empty the user's Saves folder in one run.
    const h = harness([
      page({ entities: [entity()], manifest: { content_ids: [], entity_ids: ["e1"] } }),
    ]);
    h.store.recordSave("c1", {
      path: "Stashwise/Saves/a-c1.md",
      userZoneHash: "",
      lastSyncedAt: "2026-08-01T00:00:00Z",
    });
    h.vault.files.set("Stashwise/Saves/a-c1.md", "anything");

    const report = await h.engine.run({
      ...OPTIONS,
      scope: "wiki",
      deleteRemovedItems: true,
    });

    expect(report.deleted).toBe(0);
    expect(h.vault.files.has("Stashwise/Saves/a-c1.md")).toBe(true);
  });
});
