// Filename generation. Pure, so slug parity with the backend is testable.

const SLUG_MAX_LEN = 80;

/**
 * Port of `wiki_export._slugify` from flow-app.
 *
 * Parity matters because `GET /wiki/export` already ships a zip whose entity
 * filenames come from that function. A user who unzipped it once and later
 * installs this plugin should get the same filenames, not a shadow set of
 * near-duplicates beside the originals.
 *
 * Letters and digits are kept in **any** script. `\p{L}\p{N}` is the closest
 * JS equivalent of Python's `str.isalnum()`, which is what the backend uses.
 * The older ASCII-only rule erased CJK entirely, so every Chinese-named topic
 * slugged to "untitled" and they all collided on one filename.
 *
 * Source of truth: flow-app `services/wiki_export.py:38`. Kept honest by the
 * parity table in render.test.ts, checked against the real Python.
 */
export function slugify(name: string): string {
  const lowered = (name ?? "").trim().toLowerCase();
  const collapsed = lowered
    .replace(/[^\p{L}\p{N}]/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  // Slice by code points, not UTF-16 units. Python's `[:80]` counts code
  // points, so a name using astral-plane CJK (the U+20000 extensions) would
  // otherwise truncate at a different place here and break parity, or worse
  // split a surrogate pair and emit an invalid filename.
  return [...(collapsed || "untitled")].slice(0, SLUG_MAX_LEN).join("");
}

/**
 * Characters Obsidian forbids in a filename, which slugify cannot produce but
 * a save title can. Applied to the human-readable half of a save filename.
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `<slug>-<first 8 of id>.md`.
 *
 * The id suffix is not decoration: two saves of the same article, or two
 * untitled ones, would otherwise collide onto one file and each sync would
 * overwrite the other. Titles are not unique; ids are.
 */
export function saveFileName(title: string | null, id: string): string {
  const base = slugify(sanitizeFileName(title ?? "")) || "untitled";
  return `${base}-${id.slice(0, 8)}.md`;
}

/**
 * Mirrors `wiki_export._assign_slug`: plain slug first, id-suffixed on
 * collision, full id if even that collides.
 *
 * `taken` must be seeded with every slug already in use, including from
 * previous syncs. Passing a fresh set each run lets a new entity claim a name
 * an existing one owns, and the two then overwrite each other forever.
 */
export function entityFileName(name: string, id: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) {
    taken.add(base);
    return `${base}.md`;
  }
  const suffixed = `${base}-${id.slice(0, 8)}`;
  if (!taken.has(suffixed)) {
    taken.add(suffixed);
    return `${suffixed}.md`;
  }
  // Two entities whose ids share a first 8 characters. Vanishingly unlikely
  // for UUIDs, but the Python has this third rung and silently colliding here
  // would mean one topic permanently overwriting another.
  const full = `${base}-${id}`;
  taken.add(full);
  return `${full}.md`;
}

/** Join vault path segments without doubling or dropping separators. */
export function vaultPath(...segments: string[]): string {
  return segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}
