// The boundary between what Stashwise owns and what the user owns.
//
// Everything between the markers is regenerated on every sync. Everything after
// the end marker belongs to the user and is never touched. `%%` is Obsidian's
// own comment syntax, so the markers are machine-parseable while staying
// invisible in reading view.
//
// The governing rule: when the structure is not exactly what we wrote, refuse
// to write. Guessing where the boundary used to be is how people lose work, and
// a detached note the user has to fix is recoverable in a way that overwritten
// prose is not.

export const BEGIN_MARKER = "%% stashwise:begin %%";
export const END_MARKER = "%% stashwise:end %%";

export interface ParsedNote {
  /** YAML between the `---` fences, without the fences. Null when absent. */
  frontmatter: string | null;
  /** Regenerated on every sync. */
  managed: string;
  /** Everything after the end marker. Never modified. */
  userZone: string;
}

export type DetachReason =
  | "missing-begin"
  | "missing-end"
  | "out-of-order"
  | "ambiguous";

export type ParseResult =
  | { status: "ok"; parsed: ParsedNote }
  | { status: "detached"; reason: DetachReason };

/** A marker counts only when it is the entire line, so prose about the plugin
 *  cannot be mistaken for structure. */
function markerLineIndices(lines: string[], marker: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker) found.push(i);
  }
  return found;
}

export function parseNote(text: string): ParseResult {
  // Normalise for scanning only. The user zone is sliced out of the original
  // text so its exact bytes, CRLF included, are handed back untouched.
  const lines = text.split("\n");

  const begins = markerLineIndices(lines, BEGIN_MARKER);
  const ends = markerLineIndices(lines, END_MARKER);

  if (begins.length > 1 || ends.length > 1) {
    return { status: "detached", reason: "ambiguous" };
  }
  if (begins.length === 0) {
    return { status: "detached", reason: "missing-begin" };
  }
  if (ends.length === 0) {
    return { status: "detached", reason: "missing-end" };
  }
  const begin = begins[0];
  const end = ends[0];
  if (end < begin) {
    return { status: "detached", reason: "out-of-order" };
  }

  const frontmatter = parseFrontmatter(lines, begin);
  const managed = lines.slice(begin + 1, end).join("\n");

  // Drop exactly one blank separator line after the end marker, matching what
  // composeNote writes. Anything beyond that is the user's.
  let userStart = end + 1;
  if (userStart < lines.length && lines[userStart].trim() === "") {
    userStart += 1;
  }
  const userZone = lines.slice(userStart).join("\n");

  return { status: "ok", parsed: { frontmatter, managed, userZone } };
}

/**
 * Read frontmatter only when it opens on line 0 and closes before the managed
 * block. A `---` further down is a horizontal rule in the user's prose.
 */
function parseFrontmatter(lines: string[], beforeIndex: number): string | null {
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < Math.min(lines.length, beforeIndex); i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(1, i).join("\n");
    }
  }
  return null;
}

export function composeNote(options: {
  frontmatter: string;
  managed: string;
  userZone: string;
}): string {
  const { frontmatter, managed, userZone } = options;
  // The single blank line after END_MARKER is the separator parseNote consumes.
  // Keeping the two in step is what makes compose/parse a true round trip.
  return [
    "---",
    frontmatter,
    "---",
    "",
    BEGIN_MARKER,
    managed,
    END_MARKER,
    "",
    userZone,
  ].join("\n");
}

export const USER_ZONE_HEADING = "## My notes";

/**
 * Build the initial user zone from notes the user already wrote in Stashwise.
 *
 * The push sends the whole user zone up, heading and all, so `personal_notes`
 * on a round-tripped item already starts with the heading. Adding another one
 * unconditionally gives that item two headings, and a third after the next
 * round trip. Only add one when the text does not open with a heading of its
 * own.
 */
export function seedUserZone(personalNotes: string): string {
  const text = personalNotes.trim();
  if (!text) return "";
  if (/^#{1,6}\s/.test(text)) return text;
  return `${USER_ZONE_HEADING}\n\n${text}`;
}

/**
 * FNV-1a over UTF-16 code units.
 *
 * Used to notice that the user edited their zone since the last sync, which is
 * what triggers the push back to `personal_notes`. It must be order-sensitive:
 * a purely additive hash would score "ab" and "ba" alike, so a reordering would
 * read as no change and the edit would never be pushed. Not a security hash,
 * and deliberately not a Node crypto import, which would break the mobile build.
 */
export function hashUserZone(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // FNV prime, via shifts because Math.imul on 16777619 overflows readability.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  // Length guards the empty-versus-whitespace case and cheapens collisions.
  return `${hash.toString(16)}-${text.length}`;
}
