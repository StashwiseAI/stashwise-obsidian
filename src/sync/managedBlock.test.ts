// Written before the implementation. This is the only file in the plugin that
// can destroy something a user typed, so every rule it enforces is pinned here
// first and the implementation is made to satisfy them.

import { describe, expect, it } from "vitest";
import {
  BEGIN_MARKER,
  composeNote,
  END_MARKER,
  hashUserZone,
  parseNote,
  seedUserZone,
} from "./managedBlock.js";

const FRONTMATTER = 'stashwise_id: c1\nstashwise_type: save';
const MANAGED = "# Title\n\nA summary the backend owns.";
const USER = "## My notes\n\nMy own thinking, which must survive.";

function noteWith(user: string, managed = MANAGED): string {
  return [
    "---",
    FRONTMATTER,
    "---",
    "",
    BEGIN_MARKER,
    managed,
    END_MARKER,
    "",
    user,
  ].join("\n");
}

describe("parseNote", () => {
  it("splits frontmatter, managed region and user zone", () => {
    const result = parseNote(noteWith(USER));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.parsed.frontmatter).toBe(FRONTMATTER);
    expect(result.parsed.managed).toBe(MANAGED);
    expect(result.parsed.userZone).toBe(USER);
  });

  it("detaches when the begin marker is gone rather than guessing", () => {
    const text = ["---", FRONTMATTER, "---", "", MANAGED, END_MARKER, "", USER].join("\n");
    expect(parseNote(text)).toEqual({ status: "detached", reason: "missing-begin" });
  });

  it("detaches when the end marker is gone", () => {
    const text = ["---", FRONTMATTER, "---", "", BEGIN_MARKER, MANAGED, "", USER].join("\n");
    expect(parseNote(text)).toEqual({ status: "detached", reason: "missing-end" });
  });

  it("detaches when the markers are out of order", () => {
    const text = [END_MARKER, MANAGED, BEGIN_MARKER, USER].join("\n");
    expect(parseNote(text)).toEqual({ status: "detached", reason: "out-of-order" });
  });

  it("detaches on duplicated markers, because the boundary is ambiguous", () => {
    const text = [
      BEGIN_MARKER,
      MANAGED,
      END_MARKER,
      BEGIN_MARKER,
      "a second block",
      END_MARKER,
      USER,
    ].join("\n");
    expect(parseNote(text)).toEqual({ status: "detached", reason: "ambiguous" });
  });

  it("handles a note with no frontmatter", () => {
    const text = [BEGIN_MARKER, MANAGED, END_MARKER, "", USER].join("\n");
    const result = parseNote(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.parsed.frontmatter).toBeNull();
    expect(result.parsed.userZone).toBe(USER);
  });

  it("treats an empty user zone as empty, not as missing", () => {
    const text = ["---", FRONTMATTER, "---", "", BEGIN_MARKER, MANAGED, END_MARKER].join("\n");
    const result = parseNote(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.parsed.userZone).toBe("");
  });

  it("tolerates CRLF line endings", () => {
    const result = parseNote(noteWith(USER).replace(/\n/g, "\r\n"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.parsed.userZone.replace(/\r/g, "")).toBe(USER);
  });

  it("ignores marker text that is only part of a longer line", () => {
    // Prose about the plugin should not be mistaken for a real marker.
    const text = [
      `Someone wrote about ${BEGIN_MARKER} in a sentence.`,
      BEGIN_MARKER,
      MANAGED,
      END_MARKER,
      USER,
    ].join("\n");
    const result = parseNote(text);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.parsed.managed).toBe(MANAGED);
  });
});

describe("composeNote", () => {
  it("round-trips: the user zone survives byte for byte", () => {
    // The single most important property in the plugin.
    const original = noteWith(USER);
    const parsed = parseNote(original);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;

    const rebuilt = composeNote({
      frontmatter: "stashwise_id: c1\nstashwise_type: save\nupdated_at: later",
      managed: "# New Title\n\nA regenerated summary.",
      userZone: parsed.parsed.userZone,
    });

    const reparsed = parseNote(rebuilt);
    expect(reparsed.status).toBe("ok");
    if (reparsed.status !== "ok") return;
    expect(reparsed.parsed.userZone).toBe(USER);
    expect(reparsed.parsed.managed).toBe("# New Title\n\nA regenerated summary.");
  });

  it("survives a user zone made only of whitespace and blank lines", () => {
    const messy = "\n\n   \n\ttabbed\n\n";
    const rebuilt = composeNote({
      frontmatter: FRONTMATTER,
      managed: MANAGED,
      userZone: messy,
    });
    const reparsed = parseNote(rebuilt);
    expect(reparsed.status).toBe("ok");
    if (reparsed.status !== "ok") return;
    expect(reparsed.parsed.userZone).toBe(messy);
  });

  it("preserves a user zone containing markdown that looks structural", () => {
    const tricky = "## My notes\n\n---\n\nA horizontal rule above, which is not frontmatter.";
    const rebuilt = composeNote({
      frontmatter: FRONTMATTER,
      managed: MANAGED,
      userZone: tricky,
    });
    const reparsed = parseNote(rebuilt);
    expect(reparsed.status).toBe("ok");
    if (reparsed.status !== "ok") return;
    expect(reparsed.parsed.userZone).toBe(tricky);
  });

  it("emits parseable output when the user zone is empty", () => {
    const rebuilt = composeNote({
      frontmatter: FRONTMATTER,
      managed: MANAGED,
      userZone: "",
    });
    const reparsed = parseNote(rebuilt);
    expect(reparsed.status).toBe("ok");
    if (reparsed.status !== "ok") return;
    expect(reparsed.parsed.userZone).toBe("");
  });

  it("is idempotent: composing the same inputs twice gives the same text", () => {
    const args = { frontmatter: FRONTMATTER, managed: MANAGED, userZone: USER };
    expect(composeNote(args)).toBe(composeNote(args));
  });
});

describe("hashUserZone", () => {
  it("is stable for identical input", () => {
    expect(hashUserZone(USER)).toBe(hashUserZone(USER));
  });

  it("changes when the text changes", () => {
    expect(hashUserZone(USER)).not.toBe(hashUserZone(USER + "!"));
  });

  it("distinguishes empty from whitespace, so a cleared note counts as an edit", () => {
    expect(hashUserZone("")).not.toBe(hashUserZone(" "));
  });

  it("does not collide on a simple transposition", () => {
    // A weak additive hash would give "ab" and "ba" the same value, which would
    // make a reordering look like no change and silently skip the push.
    expect(hashUserZone("ab")).not.toBe(hashUserZone("ba"));
  });
});

describe("seedUserZone", () => {
  it("adds a heading to plain notes written in the app", () => {
    expect(seedUserZone("A thought I had.")).toBe("## My notes\n\nA thought I had.");
  });

  it("does not add a second heading to notes that round-tripped", () => {
    // The push sends the whole user zone up, heading included, so a
    // round-tripped item already starts with one. Adding another gives two
    // headings, then three after the next round trip.
    const roundTripped = "## My notes\n\nA thought I had.";
    expect(seedUserZone(roundTripped)).toBe(roundTripped);
  });

  it("respects any heading level the user chose", () => {
    expect(seedUserZone("# Mine\n\nBody.")).toBe("# Mine\n\nBody.");
    expect(seedUserZone("###### Deep\n\nBody.")).toBe("###### Deep\n\nBody.");
  });

  it("returns nothing for empty or whitespace-only notes", () => {
    expect(seedUserZone("")).toBe("");
    expect(seedUserZone("   \n  ")).toBe("");
  });

  it("does not mistake a hash inside prose for a heading", () => {
    expect(seedUserZone("issue #42 is fixed")).toBe("## My notes\n\nissue #42 is fixed");
  });
});
