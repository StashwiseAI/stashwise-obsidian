import { describe, expect, it } from "vitest";
import type { SyncContent, SyncEntity } from "../api/types.js";
import { entityFileName, saveFileName, slugify, vaultPath } from "./paths.js";
import { renderEntityBody, renderEntityFrontmatter } from "./renderEntity.js";
import {
  normalizeTimestamp,
  renderSaveBody,
  renderSaveFrontmatter,
  yamlScalar,
} from "./renderSave.js";

function save(overrides: Partial<SyncContent> = {}): SyncContent {
  return {
    id: "c7f2a1b0-1111-2222-3333-444455556666",
    title: "How agents remember",
    source_url: "https://example.com/agents",
    source_platform: "youtube",
    summary: "Legacy summary field.",
    summary_core_markdown: null,
    takeaways: null,
    tags: ["ai", "agents"],
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
    id: "e1111111-2222-3333-4444-555566667777",
    name: "Agent memory",
    category: "concept",
    canonical_form: null,
    summary: "What agent memory means.",
    mention_count: 4,
    version: 2,
    updated_at: "2026-08-03T09:11:00+00:00",
    related: [],
    sources: [],
    ...overrides,
  };
}

describe("slugify parity with wiki_export._slugify", () => {
  // Every expectation below was produced by running the real Python function
  // over the same input, not written by hand.
  it.each([
    ["Agent memory", "agent-memory"],
    ["  Spaced  Out  ", "spaced-out"],
    ["C++ / Rust", "c-rust"],
    ["...", "untitled"],
    ["", "untitled"],
    ["MiXeD CaSe", "mixed-case"],
    ["emoji 🎉 here", "emoji-here"],
    ["--leading-and-trailing--", "leading-and-trailing"],
    ["under_score", "under-score"],
    ["NVIDIA & Microsoft", "nvidia-microsoft"],
    ["100% real", "100-real"],
    ["#hashtag", "hashtag"],
    ["tab\tand\nnewline", "tab-and-newline"],
    ["AI/ML: the 2026 “state” of things", "ai-ml-the-2026-state-of-things"],
  ])("slugify(%o) === %o", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  // Letters and digits survive in any script. The old ASCII-only rule erased
  // these entirely, so every CJK-named topic became "untitled" and they all
  // collided onto one filename.
  it.each([
    ["松露鳕鱼卷", "松露鳕鱼卷"],
    ["红烧肉", "红烧肉"],
    ["Luqra：更好的支付处理", "luqra-更好的支付处理"],
    ["9Router：免费使用 Claude Code", "9router-免费使用-claude-code"],
    ["日本語のテスト", "日本語のテスト"],
    ["한국어 테스트", "한국어-테스트"],
    ["Ελληνικά", "ελληνικά"],
    ["Русский текст", "русский-текст"],
    ["café naïve", "café-naïve"],
    ["中文 with English mixed", "中文-with-english-mixed"],
    // Numeric forms Python's isalnum() accepts, which \p{N} must also accept.
    ["½ and ⅷ", "½-and-ⅷ"],
    // Symbols are not alphanumeric in either language.
    ["Ω≈ç√∫", "ω-ç"],
    ["🎉🎉🎉", "untitled"],
  ])("keeps non-ASCII: slugify(%o) === %o", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("caps at 80 characters like the Python side", () => {
    expect(slugify("a".repeat(200))).toHaveLength(80);
  });

  it("counts the cap in code points, matching Python, not UTF-16 units", () => {
    // Astral-plane CJK is two UTF-16 units per character. Slicing by units
    // would truncate at a different place, and could split a surrogate pair
    // into an invalid filename.
    expect([...slugify("𠀀".repeat(200))]).toHaveLength(80);
    expect(slugify("𠀀𠀁 astral CJK")).toBe("𠀀𠀁-astral-cjk");
  });

  it("gives every CJK topic its own slug rather than collapsing them", () => {
    const names = ["松露鳕鱼卷", "红烧肉", "宫保鸡丁", "日本語のテスト"];
    expect(new Set(names.map(slugify)).size).toBe(names.length);
  });
});

describe("saveFileName", () => {
  it("appends an id suffix so two saves of the same title cannot collide", () => {
    const a = saveFileName("How agents remember", "aaaaaaaa-1111");
    const b = saveFileName("How agents remember", "bbbbbbbb-2222");
    expect(a).not.toBe(b);
    expect(a).toBe("how-agents-remember-aaaaaaaa.md");
  });

  it("survives a title with characters Obsidian forbids in filenames", () => {
    const name = saveFileName('Re: "Agents" / Part #2 | *hot*', "cccccccc-3333");
    expect(name).toBe("re-agents-part-2-hot-cccccccc.md");
    expect(name).not.toMatch(/[\\/:*?"<>|#^[\]]/);
  });

  it("still produces a usable name for an untitled save", () => {
    expect(saveFileName(null, "dddddddd-4444")).toBe("untitled-dddddddd.md");
  });
});

describe("entityFileName", () => {
  it("uses the plain slug when free and suffixes only on collision", () => {
    const taken = new Set<string>();
    expect(entityFileName("Agent memory", "e1111111", taken)).toBe("agent-memory.md");
    expect(entityFileName("Agent Memory", "e2222222", taken)).toBe(
      "agent-memory-e2222222.md",
    );
  });
});

describe("vaultPath", () => {
  it("joins without doubling separators", () => {
    expect(vaultPath("Stashwise", "Saves", "a.md")).toBe("Stashwise/Saves/a.md");
    expect(vaultPath("/Stashwise/", "/Saves/", "a.md")).toBe("Stashwise/Saves/a.md");
  });
});

describe("yamlScalar", () => {
  it("quotes a title containing a colon, which would otherwise break the YAML", () => {
    expect(yamlScalar("Re: agents")).toBe('"Re: agents"');
  });

  it("escapes embedded quotes", () => {
    expect(yamlScalar('He said "hi"')).toBe('"He said \\"hi\\""');
  });

  it("quotes a leading dash, which YAML would read as a list item", () => {
    expect(yamlScalar("-dash")).toBe('"-dash"');
  });

  it("leaves a plain word unquoted", () => {
    expect(yamlScalar("youtube")).toBe("youtube");
  });

  it("returns empty quotes rather than nothing for an empty value", () => {
    expect(yamlScalar("")).toBe('""');
  });
});

describe("renderSaveFrontmatter", () => {
  it("carries the id, source and timestamps", () => {
    const text = renderSaveFrontmatter(save());
    expect(text).toContain("stashwise_id: c7f2a1b0-1111-2222-3333-444455556666");
    expect(text).toContain("stashwise_type: save");
    expect(text).toContain("source_platform: youtube");
    expect(text).toContain("tags: [ai, agents]");
  });

  it("omits tags entirely rather than writing an empty list", () => {
    expect(renderSaveFrontmatter(save({ tags: [] }))).not.toContain("tags:");
  });

  it("records analysis_state only for a raw save", () => {
    expect(renderSaveFrontmatter(save())).not.toContain("analysis_state");
    expect(renderSaveFrontmatter(save({ analysis_state: "raw" }))).toContain(
      "analysis_state: raw",
    );
  });
});

describe("renderSaveBody", () => {
  it("prefers summary_core_markdown over the legacy summary field", () => {
    const body = renderSaveBody(
      save({ summary_core_markdown: "The newer core summary." }),
    );
    expect(body).toContain("The newer core summary.");
    expect(body).not.toContain("Legacy summary field.");
  });

  it("falls back to summary for rows predating the enrichment migration", () => {
    expect(renderSaveBody(save())).toContain("Legacy summary field.");
  });

  it("says a raw save was never analyzed instead of looking broken", () => {
    const body = renderSaveBody(
      save({ analysis_state: "raw", summary: null, summary_core_markdown: null }),
    );
    expect(body).toContain("Not analyzed");
    expect(body).not.toContain("Still being analyzed");
  });

  it("marks an in-flight save as still analyzing", () => {
    const body = renderSaveBody(
      save({ status: "processing", summary: null, summary_core_markdown: null }),
    );
    expect(body).toContain("Still being analyzed");
  });

  it("renders takeaways with timestamps when present", () => {
    const body = renderSaveBody(
      save({
        takeaways: [
          { text: "Memory beats context.", timestamp: "01:23" },
          { text: "Durability is the point.", timestamp: null },
        ],
      }),
    );
    expect(body).toContain("- Memory beats context. _(01:23)_");
    expect(body).toContain("- Durability is the point.");
  });

  it("renders topic wikilinks so the graph connects saves to the wiki", () => {
    const body = renderSaveBody(save(), {
      topics: [{ id: "e1", name: "Agent memory", label: "mentions" }],
    });
    expect(body).toContain("## Topics\n[[Agent memory]]");
  });

  it("emits no em dash, per the project's text rules", () => {
    expect(renderSaveBody(save())).not.toContain("—");
  });
});

describe("renderEntity", () => {
  it("carries wiki metadata in frontmatter, tagged by category for Dataview", () => {
    const text = renderEntityFrontmatter(entity());
    expect(text).toContain("stashwise_type: topic");
    expect(text).toContain("mention_count: 4");
    expect(text).toContain("tags: [concept]");
  });

  it("renders related entities as wikilinks, which is what lights up the graph", () => {
    const body = renderEntityBody(
      entity({
        related: [
          { id: "e2", name: "Vector search", label: "relates_to" },
          { id: "e3", name: "MCP Servers", label: "co_mentioned" },
        ],
      }),
    );
    expect(body).toContain("- [[Vector search]] _(relates_to)_");
    expect(body).toContain("- [[MCP Servers]] _(co_mentioned)_");
  });

  it("dedupes a pair carrying several relationship types", () => {
    const body = renderEntityBody(
      entity({
        related: [
          { id: "e2", name: "Vector search", label: "relates_to" },
          { id: "e2", name: "Vector search", label: "co_mentioned" },
        ],
      }),
    );
    expect(body.match(/\[\[Vector search\]\]/g)).toHaveLength(1);
  });

  it("lists sources as markdown links", () => {
    const body = renderEntityBody(
      entity({
        sources: [
          { content_id: "c1", title: "A source", source_url: "https://example.com/s" },
        ],
      }),
    );
    expect(body).toContain("- [A source](https://example.com/s)");
  });

  it("says so plainly when there is no summary yet", () => {
    expect(renderEntityBody(entity({ summary: null }))).toContain("_No summary yet._");
  });
});

describe("normalizeTimestamp", () => {
  it("adds a UTC marker to a naive timestamp, as SQLite returns", () => {
    // Without this the same note reads as local time from a dev backend and as
    // UTC from prod, and every Dataview date query silently disagrees.
    expect(normalizeTimestamp("2026-08-02T07:34:33.440953")).toBe(
      "2026-08-02T07:34:33.440953Z",
    );
  });

  it("leaves a Z-suffixed timestamp alone", () => {
    expect(normalizeTimestamp("2026-08-02T07:34:33Z")).toBe("2026-08-02T07:34:33Z");
  });

  it("leaves an explicit offset alone, as Postgres returns", () => {
    expect(normalizeTimestamp("2026-08-02T07:34:33+00:00")).toBe(
      "2026-08-02T07:34:33+00:00",
    );
  });

  it("handles a non-UTC offset without mangling it", () => {
    expect(normalizeTimestamp("2026-08-02T07:34:33+08:00")).toBe(
      "2026-08-02T07:34:33+08:00",
    );
  });
});

describe("save frontmatter timestamps", () => {
  it("always carries a timezone, whichever backend served it", () => {
    const text = renderSaveFrontmatter(save({ created_at: "2026-08-02T07:34:33.440953" }));
    expect(text).toContain('saved_at: "2026-08-02T07:34:33.440953Z"');
  });
});
