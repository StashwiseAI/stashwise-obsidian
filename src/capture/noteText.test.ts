import { describe, expect, it } from "vitest";
import { extractNote, findUrl, readStashwiseId, withStashwiseId } from "./noteText.js";

describe("findUrl", () => {
  it("finds a bare URL", () => {
    expect(findUrl("see https://example.com/a for more")).toBe("https://example.com/a");
  });

  it("strips trailing sentence punctuation, which is not part of the URL", () => {
    expect(findUrl("Read https://example.com/a.")).toBe("https://example.com/a");
  });

  it("does not swallow the closing paren of a markdown link", () => {
    expect(findUrl("[a](https://example.com/a)")).toBe("https://example.com/a");
  });

  it("returns null when there is no URL", () => {
    expect(findUrl("nothing here")).toBeNull();
  });
});

describe("extractNote", () => {
  it("prefers a leading H1 over the filename", () => {
    const { title, body } = extractNote("# Real Title\n\nSome body.", "2026-08-04");
    expect(title).toBe("Real Title");
    expect(body).toBe("Some body.");
  });

  it("falls back to the filename when there is no heading", () => {
    const { title, body } = extractNote("Just a body.", "My Note");
    expect(title).toBe("My Note");
    expect(body).toBe("Just a body.");
  });

  it("drops frontmatter, which is vault metadata rather than content", () => {
    const { title, body } = extractNote(
      "---\ntags: [a]\n---\n\n# Title\n\nBody.",
      "fallback",
    );
    expect(title).toBe("Title");
    expect(body).toBe("Body.");
    expect(body).not.toContain("tags:");
  });

  it("does not mistake a horizontal rule in the body for frontmatter", () => {
    const { body } = extractNote("# T\n\nAbove.\n\n---\n\nBelow.", "fallback");
    expect(body).toContain("Above.");
    expect(body).toContain("Below.");
  });
});

describe("stashwise_id round trip", () => {
  it("stamps an id into a note with no frontmatter", () => {
    const out = withStashwiseId("# Title\n\nBody.", "c1");
    expect(readStashwiseId(out)).toBe("c1");
    expect(out).toContain("# Title");
  });

  it("adds an id to existing frontmatter without disturbing it", () => {
    const out = withStashwiseId("---\ntags: [a]\n---\n\n# T", "c1");
    expect(readStashwiseId(out)).toBe("c1");
    expect(out).toContain("tags: [a]");
  });

  it("replaces rather than duplicates on a second capture", () => {
    const once = withStashwiseId("# T", "c1");
    const twice = withStashwiseId(once, "c2");
    expect(readStashwiseId(twice)).toBe("c2");
    expect(twice.match(/stashwise_id:/g)).toHaveLength(1);
  });

  it("returns null when the note was never captured", () => {
    expect(readStashwiseId("# T\n\nBody.")).toBeNull();
  });

  it("tolerates a quoted id value", () => {
    expect(readStashwiseId('---\nstashwise_id: "c1"\n---\n')).toBe("c1");
  });
});
