import { describe, expect, it } from "vitest";
import type { AgentSearchResultItem } from "../api/types.js";
import {
  describeSource,
  escapeLinkText,
  escapeLinkUrl,
  formatInsert,
  markdownLink,
} from "./insert.js";

function result(overrides: Partial<AgentSearchResultItem> = {}): AgentSearchResultItem {
  return {
    kind: "content",
    id: "c1",
    title: "How agents remember",
    snippet: "Agents need durable memory to be useful across sessions.",
    source_url: "https://example.com/agents",
    source_platform: "youtube",
    score: 0.9,
    citation: "How agents remember — example.com",
    saved_at: "2026-08-01T12:00:00Z",
    ...overrides,
  };
}

describe("escapeLinkText", () => {
  it("escapes brackets that would terminate the link early", () => {
    expect(escapeLinkText("Review [2026] of agents")).toBe(
      "Review \\[2026\\] of agents",
    );
  });

  it("escapes backslashes so the escaping itself survives", () => {
    expect(escapeLinkText("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary titles untouched", () => {
    expect(escapeLinkText("How agents remember")).toBe("How agents remember");
  });
});

describe("escapeLinkUrl", () => {
  it("leaves a clean URL alone", () => {
    expect(escapeLinkUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
  });

  it("angle-wraps a URL containing a space", () => {
    expect(escapeLinkUrl("https://example.com/a b")).toBe("<https://example.com/a b>");
  });

  it("angle-wraps a URL containing parentheses", () => {
    expect(escapeLinkUrl("https://en.wikipedia.org/wiki/Agent_(computing)")).toBe(
      "<https://en.wikipedia.org/wiki/Agent_(computing)>",
    );
  });

  it("percent-encodes a closing angle bracket, which nothing else can rescue", () => {
    expect(escapeLinkUrl("https://example.com/a>b c")).toBe(
      "<https://example.com/a%3Eb c>",
    );
  });
});

describe("markdownLink", () => {
  it("builds a link when there is a URL", () => {
    expect(markdownLink("Title", "https://example.com")).toBe(
      "[Title](https://example.com)",
    );
  });

  it("degrades to plain text when there is no URL", () => {
    expect(markdownLink("Title", null)).toBe("Title");
  });

  it("falls back to Untitled rather than emitting an empty link", () => {
    expect(markdownLink("   ", "https://example.com")).toBe(
      "[Untitled](https://example.com)",
    );
  });
});

describe("formatInsert", () => {
  it("inserts an inline link", () => {
    expect(formatInsert(result(), "link")).toBe(
      "[How agents remember](https://example.com/agents)",
    );
  });

  it("inserts a quote callout carrying the snippet and attribution", () => {
    expect(formatInsert(result(), "quote")).toBe(
      "> [!quote] [How agents remember](https://example.com/agents)\n" +
        "> Agents need durable memory to be useful across sessions.",
    );
  });

  it("keeps a multi-line snippet inside the callout", () => {
    const text = formatInsert(result({ snippet: "First line.\nSecond line." }), "quote");
    expect(text.split("\n").slice(1)).toEqual(["> First line.", "> Second line."]);
  });

  it("degrades a quote with no snippet to a plain link", () => {
    expect(formatInsert(result({ snippet: "" }), "quote")).toBe(
      "[How agents remember](https://example.com/agents)",
    );
  });

  it("does not emit an em dash, per the project's text rules", () => {
    // The backend's own `citation` field contains one, which is why the plugin
    // builds its own formats rather than inserting that field verbatim.
    for (const style of ["link", "quote"] as const) {
      expect(formatInsert(result(), style)).not.toContain("—");
    }
  });
});

describe("describeSource", () => {
  it("labels a wiki entity as a topic rather than a platform", () => {
    expect(describeSource(result({ kind: "entity", source_platform: null }))).toMatch(
      /^Wiki topic/,
    );
  });

  it("stays quiet when the backend sends nulls", () => {
    expect(
      describeSource(result({ kind: "content", source_platform: null, saved_at: null })),
    ).toBe("");
  });

  it("ignores an unparseable timestamp instead of printing Invalid Date", () => {
    expect(
      describeSource(result({ source_platform: "youtube", saved_at: "not-a-date" })),
    ).toBe("youtube");
  });
});
